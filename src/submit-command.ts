import { buildBundleInteractively, type BuildBundleOptions } from "./build-bundle.js";
import { AuthError, SubmitError } from "./errors.js";
import { formatConsentSummary } from "./summary.js";
import { getSiteUrl } from "./config.js";
import { readCredentials } from "./credentials.js";
import { getRemoteUrl } from "./git.js";
import { checkVisibilityGate, fetchVerifiedEmails, postBundle } from "./submit.js";
import { promptConfirmUpload } from "./prompt.js";
import { checkForUpdate } from "./version-check.js";
import { bundleContentHash, saveLastSubmission } from "./submission-record.js";
import { computeCorroboration, corroborationNotice, type IdentityCorroboration } from "./identity-corroboration.js";
import { getOrCreateSalt } from "./salt.js";
import type { Bundle } from "./types.js";

export type SubmitCommandOptions = BuildBundleOptions & {
  /** Separate from `yes` (authorization-to-scan) on purpose — this is
   * consent to upload, a materially different and riskier action. */
  confirmUpload: boolean;
  log?: (message: string) => void;
  promptConfirmUploadFn?: () => Promise<boolean>;
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
  const capabilityCount = bundle.detected_skills.length;
  const structuralCount = bundle.detected_skills.filter((s) => s.evidence === "structural").length;
  const structuralSuffix = structuralCount > 0 ? ` (${structuralCount} structural)` : "";
  const dot = plain ? "-" : "·"; // middle dot; ASCII fallback for PLAIN_THEME parity
  return (
    `${span} of private work ${dot} ${commitCount} commits ${dot} ` +
    `${capabilityCount} capabilities detected${structuralSuffix}`
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
  // `null` only happens when a real TTY user declined the connectable-repo
  // "Continue locally?" follow-up (see build-bundle.ts) — it already
  // printed the "nothing scanned" notice; nothing was uploaded either.
  if (bundle === null) return;
  const bundleJson = JSON.stringify(bundle, null, 2);

  // Output order (console-UX milestone, 2026-07):
  //   1. one-line short summary (TTY only)
  //   2. identity-corroboration line, when present (both TTY and non-TTY —
  //      see the comment above its computation below; unchanged from
  //      before this milestone)
  //   3. the consent box, "WHAT GETS UPLOADED" (TTY only)
  //   4. the payload header + the exact JSON (byte-for-byte what gets sent
  //      — this print IS the guarantee, so nothing may come between the
  //      header and it; ALWAYS printed before the upload prompt, TTY or
  //      not — see the non-TTY branch below for the piped-output case)
  //   5. the upload prompt, immediately after the JSON
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
    log("Exact payload (byte-for-byte what gets sent):");
    log(bundleJson);
  }

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

  // Local-only bookkeeping so a future `scan`'s summary can tell "already
  // uploaded, nothing new to submit" from "not submitted yet" —
  // see submission-record.ts. Never sent anywhere; best-effort in spirit
  // but not wrapped in try/catch like checkForUpdate below, since a
  // failure here (e.g. an unwritable config dir) would be a real local
  // problem worth surfacing, not a network blip to swallow.
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
