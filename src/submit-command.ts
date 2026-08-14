import { buildBundleInteractively, type BuildBundleOptions } from "./build-bundle.js";
import { ScanError, AuthError, SubmitError } from "./errors.js";
import { formatConsentSummary } from "./summary.js";
import { getSiteUrl } from "./config.js";
import { readCredentials } from "./credentials.js";
import { getRemoteUrl } from "./git.js";
import { checkVisibilityGate, fetchVerifiedEmails, postBundle, postPrivateLabel } from "./submit.js";
import { promptConfirmUpload, promptPrivateLabel } from "./prompt.js";
import { checkForUpdate } from "./version-check.js";
import { bundleContentHash, saveLastSubmission } from "./submission-record.js";
import { computeCorroboration, corroborationNotice, type IdentityCorroboration } from "./identity-corroboration.js";
import { getOrCreateSalt } from "./salt.js";
import { validatePrivateLabel } from "./private-label.js";
import type { Bundle } from "./types.js";

export type SubmitCommandOptions = BuildBundleOptions & {
  /** Separate from `yes` (authorization-to-scan) on purpose — this is
   * consent to upload, a materially different and riskier action. */
  confirmUpload: boolean;
  log?: (message: string) => void;
  promptConfirmUploadFn?: () => Promise<boolean>;
  // The private nickname for this repo — see docs/private-label.md.
  // MANDATORY on every submit: required as this flag in a non-TTY/piped
  // run (executeSubmitCommand throws a clear error before any network call
  // if it's missing there); optional here on a real TTY, where the user is
  // prompted interactively instead (see promptPrivateLabelFn below). When
  // given, it is still run through the exact same validation as a typed
  // answer (validatePrivateLabel) — an invalid --label is a hard error,
  // never silently coerced.
  label?: string;
  // Injectable for tests; defaults to the real interactive prompt
  // (prompt.ts's promptPrivateLabel). Only ever called on a real TTY when
  // `label` above wasn't given.
  promptPrivateLabelFn?: () => Promise<string>;
  // Injectable for tests, so a private-label-POST failure/success path
  // doesn't need a real network call; defaults to the real submit.ts
  // postPrivateLabel.
  postPrivateLabelFn?: typeof postPrivateLabel;
  // Injectable for tests, so the visibility gate doesn't need a real
  // network call to github.com to exercise the blocked/unblocked paths.
  probeFn?: Parameters<typeof checkVisibilityGate>[1];
  // Injectable so tests don't make a real request to the npm registry;
  // defaults to the real checkForUpdate (src/version-check.ts).
  checkForUpdateFn?: () => Promise<void>;
  // True when stdout is an interactive terminal — cli.ts passes
  // `process.stdout.isTTY`. Determines whether the human-readable
  // short-summary line, identity-corroboration line, consent box, and
  // payload header are printed at all (see executeSubmitCommand's own
  // "Output order" comment for the full TTY sequence). Tests set this
  // explicitly instead of relying on a real TTY. Undefined behaves like
  // `false` (JSON only, no other output), matching a piped stdout so the
  // printed bundle JSON stays byte-identical to before this feature existed.
  isTTY?: boolean;
  // True to render the consent summary with the ASCII/no-color fallback
  // theme (see summary.ts's shouldUsePlainOutput) instead of ANSI + Unicode
  // box-drawing. cli.ts computes this from process.platform/process.env;
  // tests set it explicitly, same pattern as isTTY.
  plain?: boolean;
};

// Mirrors summary.ts's private `humanizeSpan` (kept in sync by hand).
// Duplicated here — rather than exported from summary.ts and imported —
// because this file is out of scope for the console-UX phases that have
// touched summary.ts so far; extracting a single shared helper is a good
// small follow-up, but isn't worth a cross-file change for its own sake.
function humanizeSpanDays(days: number): string {
  if (days <= 0) return "a single day";
  const years = Math.floor(days / 365);
  if (years >= 1) return `${years} year${years === 1 ? "" : "s"}`;
  const months = Math.floor(days / 30);
  if (months >= 1) return `${months} month${months === 1 ? "" : "s"}`;
  return `${days} day${days === 1 ? "" : "s"}`;
}

/**
 * The one-line short summary printed first in TTY mode, right before the
 * identity-corroboration line and the consent box — owner-mandated so the
 * structural-evidence count (schema 1.2.0+'s `evidence: "structural"`) is
 * visible at the upload edge, not buried inside the box or the JSON. Pure
 * function of the bundle already built above: no new data collection.
 */
// Exported for direct unit coverage (test/submit.test.ts) — a pure
// formatting function of an already-built `Bundle`, same pattern as
// summary.ts's own exported formatters.
export function formatShortUploadSummary(bundle: Bundle, plain: boolean | undefined): string {
  const span = humanizeSpanDays(bundle.commits.span_days);
  const commitCount = bundle.commits.user_total.toLocaleString("en-US");
  // "commit" for exactly 1, "commits" otherwise — mirrors summary.ts's own
  // `commitWord` (duplicated rather than imported, same rationale as
  // `humanizeSpanDays` above: this file is out of scope for the console-UX
  // phases that have touched summary.ts so far).
  const commitWord = bundle.commits.user_total === 1 ? "commit" : "commits";
  const capabilityCount = bundle.detected_skills.length;
  const structuralCount = bundle.detected_skills.filter((s) => s.evidence === "structural").length;
  const structuralSuffix = structuralCount > 0 ? ` (${structuralCount} structural)` : "";
  const dot = plain ? "-" : "·"; // middle dot; ASCII fallback for PLAIN_THEME parity
  return (
    `${span} of private work ${dot} ${commitCount} ${commitWord} ${dot} ` +
    `${capabilityCount} capabilities detected${structuralSuffix}`
  );
}

// Below this many commits (with real history — see the span check below
// too), the resulting credential says very little: "10" is a deliberately
// low, non-scientific floor, just enough to catch the "ran this on a repo
// with almost nothing in it yet" case without nagging on genuinely small
// but real work.
const THIN_HISTORY_COMMIT_FLOOR = 10;

/**
 * Non-blocking, informational only — same "warn, never block" stance as
 * public-remote.ts/shallow-repo.ts. Called once, after the bundle is built
 * but before the consent box, so the user sees this before deciding to
 * upload rather than after. A shallow clone always wins over the plain
 * thin-history check: even a shallow clone with 10+ visible commits is
 * still truncated, missing whatever history sits before the shallow
 * boundary, so its own (more specific) message is the useful one — the
 * generic "scan a repo with more history" advice would be actively
 * misleading there, since more history already exists locally, just not
 * fetched.
 */
export function thinHistoryNotice(bundle: Bundle): string | null {
  if (bundle.repo.shallow === true) {
    return (
      "Note: this scan ran on a truncated (shallow) clone — the resulting credential will be weak, " +
      "since history before the shallow boundary isn't available. Run `git fetch --unshallow` (or clone " +
      "the full repository) and rescan for a stronger one."
    );
  }
  if (bundle.commits.user_total < THIN_HISTORY_COMMIT_FLOOR || bundle.commits.span_days === 0) {
    return (
      "Note: very little history was found for you in this repo — the resulting credential will be " +
      "weak. Consider scanning a repo with more of your commit history."
    );
  }
  return null;
}

/**
 * The consent-surface line for the private label — printed right after the
 * exact JSON, right before the upload prompt (see the "Output order"
 * comment below and docs/private-label.md). Deliberately spells out BOTH
 * halves of the trust claim in one line: it travels (so nothing about it
 * is a silent addition to the request) and it travels OUTSIDE the bundle
 * (so its presence here is never mistaken for a bundle field). `«»` is
 * replaced with plain double quotes in plain mode, matching this file's
 * existing ASCII-fallback convention for non-structural glyphs (see
 * formatShortUploadSummary's `dot` above).
 */
export function formatPrivateLabelLine(label: string, plain: boolean | undefined): string {
  const [open, close] = plain ? ['"', '"'] : ["«", "»"];
  return (
    `Plus your private label: ${open}${label}${close} (travels alongside the bundle, ` +
    "never inside it — only you will ever see it)"
  );
}

/**
 * `submit`'s actual behavior, independent of commander wiring. Builds the
 * bundle through the exact same path `scan` uses, prints it (byte-for-byte
 * what gets uploaded — see submit.ts's postBundle), then gates on: a
 * matching stored session, explicit upload confirmation, and the remote
 * visibility check.
 */
export async function executeSubmitCommand(opts: SubmitCommandOptions): Promise<void> {
  const log = opts.log ?? console.log;
  const warn = opts.warn ?? console.error;

  const siteUrl = getSiteUrl();
  const credentials = readCredentials(opts.configDir);
  if (!credentials) {
    throw new AuthError("Not logged in. Run `redential login` first.");
  }
  if (credentials.site_url !== siteUrl) {
    throw new AuthError("Stored session belongs to a different site. Run `redential login` again.");
  }

  const bundle = await buildBundleInteractively(opts);
  const bundleJson = JSON.stringify(bundle, null, 2);

  // Thin-history / shallow-clone advisory — see thinHistoryNotice's own
  // comment. Printed here, before any of the consent-surface output below
  // (the short summary, the consent box, the exact payload), non-blocking:
  // stderr only, never changes stdout, never throws, no new prompt.
  const historyNotice = thinHistoryNotice(bundle);
  if (historyNotice) warn(historyNotice);

  // Private label resolution (see docs/private-label.md) — MANDATORY,
  // resolved/validated before any of this function's own network calls
  // (fetchVerifiedEmails below is the first one). Two of the three cases
  // resolve right here, before anything is printed:
  //   - `--label` given: validated immediately (an invalid one is a hard
  //     error here, TTY or not — no reason to defer a value we already
  //     have).
  //   - non-TTY and no `--label`: there is no way to prompt, so this is an
  //     immediate, clear failure — before any output, before any request.
  // The third case — a real TTY with no `--label` — is intentionally left
  // unresolved here (`privateLabel` stays undefined) and is resolved later,
  // at its documented position in the TTY output sequence below (after the
  // consent box, before the exact-payload print) — see that block's own
  // comment for why the position matters.
  let privateLabel: string | undefined;
  if (opts.label !== undefined) {
    privateLabel = validatePrivateLabel(opts.label);
  } else if (!opts.isTTY) {
    throw new ScanError(
      "submit requires --label <text> (a private nickname for this repo, only you will ever see it) " +
        "when not running in an interactive terminal."
    );
  }

  // Output order (console-UX milestone, 2026-07; private-label prompt
  // added 2026-07 — see docs/private-label.md):
  //   1. one-line short summary (TTY only)
  //   2. identity-corroboration line, when present (both TTY and non-TTY —
  //      see the comment above its computation below; unchanged from
  //      before this milestone)
  //   3. the consent box, "WHAT GETS UPLOADED" (TTY only)
  //   4. the private-label prompt, TTY only, only when `--label` wasn't
  //      given (interactive — not a `log()` line, see the block below)
  //   5. the payload header + the exact JSON (byte-for-byte what gets sent
  //      — this print IS the guarantee, so nothing may come between the
  //      header and it; ALWAYS printed before the upload prompt, TTY or
  //      not — see the non-TTY branch below for the piped-output case)
  //   6. the private-label consent line (TTY only) — part of the consent
  //      surface: everything that travels is shown before the y/n, and the
  //      label travels just as much as the bundle does, even though it's a
  //      separate request (see postPrivateLabel below).
  //   7. the upload prompt, immediately after the label line
  // Non-TTY/piped stdout keeps its exact pre-existing contract: the raw
  // bundle JSON is the very first thing logged, nothing else surrounding
  // it — `scan`/`submit | jq`-style consumers are unaffected by this
  // reordering, which only touches the TTY-interactive presentation.
  if (!opts.isTTY) {
    log(bundleJson);
  } else {
    log(formatShortUploadSummary(bundle, opts.plain));
  }

  // Identity corroboration (optional X-Redential-Identity-Corroboration
  // header on postBundle below) must be fetched and its counts printed
  // HERE — before the upload confirmation prompt, not after. Principle 4
  // ("no hidden fields, no enrichment after review"): the header is data
  // that leaves the machine but isn't part of the printed bundle above, so
  // the dev must see exactly what it says before consenting to upload. A
  // failed/unreachable emails lookup prints nothing and sends nothing —
  // fetchVerifiedEmails and computeCorroboration are both fail-open by
  // contract, never throwing and never blocking the submit. Printed in
  // BOTH TTY and non-TTY modes, same as before this milestone — only its
  // position relative to the TTY-only elements around it has moved.
  const verifiedEmails = await fetchVerifiedEmails(siteUrl, credentials.access_token);
  let corroboration: IdentityCorroboration | null = null;
  if (verifiedEmails) {
    corroboration = computeCorroboration(
      bundle.identity.author_identity_hashes,
      verifiedEmails,
      getOrCreateSalt(opts.configDir)
    );
    if (corroboration) log(corroborationNotice(corroboration));
  }

  if (opts.isTTY) {
    log(formatConsentSummary(bundle, { plain: opts.plain, command: "submit" }));
    // Resolved earlier (from `--label`) unless this is a real TTY without
    // one — in which case this is where the interactive prompt fires, per
    // the "Output order" comment above: after the consent box, before the
    // exact-payload print.
    if (privateLabel === undefined) {
      privateLabel = await (opts.promptPrivateLabelFn ?? promptPrivateLabel)();
    }
    log("Exact payload (byte-for-byte what gets sent):");
    log(bundleJson);
    log(formatPrivateLabelLine(privateLabel, opts.plain));
  }

  // By this point `privateLabel` is always defined: either validated from
  // `--label` above, resolved by the TTY prompt just above, or this
  // function has already thrown (non-TTY without `--label`, earlier). The
  // non-null assertion below documents that invariant rather than
  // papering over a real gap.
  const confirmedUpload = opts.confirmUpload || (await (opts.promptConfirmUploadFn ?? promptConfirmUpload)());
  if (!confirmedUpload) {
    log("Aborted — nothing was uploaded.");
    return;
  }

  const visibility = opts.probeFn
    ? await checkVisibilityGate(getRemoteUrl(opts.repoPath), opts.probeFn)
    : await checkVisibilityGate(getRemoteUrl(opts.repoPath));
  if (visibility.message) warn(visibility.message);
  if (visibility.blocked) {
    throw new SubmitError("Submit refused: see the message above.");
  }

  const result = await postBundle(siteUrl, credentials.access_token, bundleJson, corroboration);
  log(`Uploaded. Bundle id: ${result.id}`);

  // Signed-commit tip (owner follow-up, 2026-08): relocated here from
  // `scan`'s summary (src/summary.ts), which used to show it unconditionally
  // near the results, before the upload even happened — after a successful
  // upload is a calmer, more relevant moment for it, and it's now a single
  // neutral (uncolored) stderr line rather than a yellow/dim one. Chosen
  // over gating it behind `scan --details` because a signed-commit ratio of
  // zero is a genuinely one-time, low-frequency fact worth surfacing once,
  // right after the credential-relevant action (an upload) actually
  // happened, rather than every time someone re-runs `--details`.
  if (bundle.signed.ratio === 0) {
    warn(
      "Tip: none of your commits are signed. Signed commits make your future work cryptographically " +
        "attributable: https://docs.github.com/en/authentication/managing-commit-signature-verification"
    );
  }

  // The SECOND request — the private label, sent only now, only after the
  // bundle upload above has already fully succeeded (see
  // docs/private-label.md). `privateLabel` is guaranteed defined here (see
  // the invariant comment above the upload-confirmation prompt); the `!`
  // documents that rather than silently trusting an `undefined` through.
  // Deliberately never retried and never followed by a second bundle
  // upload on failure — postPrivateLabel itself never throws, so a failure
  // here surfaces only as a warning, with the bundle upload already safely
  // recorded as a success (see this function's own exit-code note in
  // docs/private-label.md: the overall `submit` still succeeds).
  const labelResult = await (opts.postPrivateLabelFn ?? postPrivateLabel)(
    siteUrl,
    credentials.access_token,
    result.id,
    privateLabel!
  );
  if (!labelResult.ok) {
    warn(
      `Warning: your private label could not be saved (${labelResult.message}) Your bundle uploaded ` +
        `successfully. Your label was: "${privateLabel}" — you can set it later from the web.`
    );
  }

  // Local-only bookkeeping so a future `scan`'s summary can tell "already
  // uploaded, nothing new to submit" from "not submitted yet" —
  // see submission-record.ts. Never sent anywhere; best-effort in spirit
  // but not wrapped in try/catch like checkForUpdate below, since a
  // failure here (e.g. an unwritable config dir) would be a real local
  // problem worth surfacing, not a network blip to swallow.
  // Deliberately does NOT include `privateLabel`: this record already
  // lives outside the restricted-permissions/secret-file category
  // (submission-record.ts writes it without `mode: 0600`, unlike
  // credentials.json), on the grounds that it's just a hash of content the
  // user already reviewed. A private label is a different kind of local
  // data — a free-text nickname the user may reuse across employers/repos
  // — so accumulating it into this unprotected file would create exactly
  // the kind of local-disk sensitive-data footprint this record was never
  // meant to have. It is never read back or needed locally for anything.
  saveLastSubmission(
    {
      site_url: siteUrl,
      bundle_hash: bundleContentHash(bundle),
      submitted_at: new Date().toISOString(),
      repo_fingerprint: bundle.repo.repo_fingerprint,
    },
    opts.configDir
  );

  // Best-effort only, after the upload itself has already fully succeeded
  // — never allowed to turn a successful submit into a failure
  // (checkForUpdate never throws by contract).
  await (opts.checkForUpdateFn ?? (() => checkForUpdate({ log: warn, currentVersion: opts.toolVersion })))();
}
