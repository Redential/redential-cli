import { buildBundleInteractively, type BuildBundleOptions } from "./build-bundle.js";
import { formatSummary } from "./summary.js";
import { describeSince } from "./since.js";
import { getSiteUrl } from "./config.js";
import { readCredentials } from "./credentials.js";
import { bundleContentHash, readLastSubmission } from "./submission-record.js";
import { isShallowRepository, getRemoteUrl } from "./git.js";
import { connectableRepoNotice } from "./public-remote.js";
import { promptAddToProfile } from "./prompt.js";
import { AuthError } from "./errors.js";
import { dim } from "./dim.js";
import type { Bundle } from "./types.js";
import type { SubmitCommandOptions } from "./submit-command.js";

// Commits between stderr progress writes — keeps a huge repo's walk from
// spamming thousands of lines, while still giving visible movement well
// inside the 60s budget a 20k-commit scan targets (docs/scan.md).
const PROGRESS_INTERVAL = 200;

export type ScanCommandOptions = BuildBundleOptions & {
  log?: (message: string) => void;
  // True when stdout is an interactive terminal — cli.ts passes
  // `process.stdout.isTTY`. Determines whether the human-readable summary
  // is printed at all (in place of the raw JSON — see executeScanCommand's
  // own doc comment on the three output modes); tests set this explicitly
  // instead of relying on a real TTY. Undefined behaves like `false`
  // (JSON-only), matching a piped stdout so `scan | jq` never sees anything
  // but the bundle.
  isTTY?: boolean;
  // Forces JSON-only output even when stdout is a TTY — and, per this
  // option's own "suitable for pipes even on a TTY" contract, also
  // suppresses the huge-repo progress line and the post-scan "Add this to
  // your Redential profile?" prompt (both go through `interactiveTTY`
  // below), even though both are otherwise gated on `isTTY` alone. Neither
  // ever touched stdout to begin with (progress is stderr-only; the prompt
  // is a stdin/stdout prompt gated separately), so this isn't about stdout
  // purity — it's about `--json` meaning "treat this run as
  // non-interactive/scripted," consistently, even when stdout happens to
  // be a real terminal.
  json?: boolean;
  // True to render the summary with the ASCII/no-color fallback theme
  // (see summary.ts's shouldUsePlainOutput) instead of ANSI + Unicode
  // box-drawing. cli.ts computes this from process.platform/process.env;
  // tests set it explicitly, same pattern as isTTY.
  plain?: boolean;
  // `redential scan --details`: adds the COMMITS BY HOUR/WEEKDAY histogram
  // sections to the TTY summary (summary.ts's FormatSummaryOptions.details).
  // No effect on JSON output (`--json` / piped stdout) — those never
  // rendered histograms at all, JSON or otherwise.
  details?: boolean;
  // Where the huge-repo progress line ("scanning commits... N/Total") is
  // written — ALWAYS stderr, NEVER the `log` callback above (which backs
  // stdout). Defaults to `process.stderr.write`; tests inject a collector
  // instead of a real stream. Only used when `interactiveTTY` is true — see
  // buildProgressReporter below.
  progressWrite?: (message: string) => void;
  // Injectable for tests; defaults to the real interactive prompt
  // (prompt.ts's promptAddToProfile). Only ever called on `interactiveTTY`
  // when there's a stored session and this exact bundle content hasn't
  // already been uploaded — see `maybeOfferToAddToProfile` below.
  promptAddToProfileFn?: () => Promise<boolean>;
};

/**
 * Builds the onProgress callback threaded into runScan (via
 * buildBundleInteractively), or undefined when progress shouldn't be shown
 * at all — piped/non-TTY stdout (and `--json`, even on a real TTY — see
 * ScanCommandOptions.json's own comment) stays completely silent on stderr
 * too, so neither a piped consumer nor a script capturing `--json` output
 * risks interleaving weirdly with a script that also inspects stderr.
 * Throttled to PROGRESS_INTERVAL so a 20k-commit walk doesn't write 20,000
 * lines; always writes the final scanned === total line so the terminal
 * doesn't sit on a stale count.
 */
function buildProgressReporter(opts: ScanCommandOptions): ((scanned: number, total: number) => void) | undefined {
  if (!opts.isTTY || opts.json) return undefined;
  const write = opts.progressWrite ?? ((message: string) => process.stderr.write(message));
  let lastWritten = 0;
  return (scanned: number, total: number) => {
    if (scanned !== total && scanned - lastWritten < PROGRESS_INTERVAL) return;
    lastWritten = scanned;
    // \r overwrites the previous line in place rather than scrolling —
    // counts only, never a sha/path/email (this can end up in CI logs).
    write(`\rscanning commits... ${scanned.toLocaleString("en-US")}/${total.toLocaleString("en-US")}`);
    if (scanned === total) write("\n");
  };
}

/**
 * Local-only session/submission state for the summary's closing next-step
 * hint (see summary.ts's three CTA states). Reads only the CLI's
 * own config dir — same files login/submit already read/write — never the
 * network, never the repo again. Computed lazily by the caller, only when
 * the summary will actually be printed, so the common piped/`--json` path
 * never touches these files.
 */
function nextStepsState(bundle: Bundle, configDir: string | undefined): {
  hasSession: boolean;
  alreadySubmittedIdentical: boolean;
} {
  const siteUrl = getSiteUrl();
  const credentials = readCredentials(configDir);
  const hasSession = credentials !== null && credentials.site_url === siteUrl;
  if (!hasSession) return { hasSession: false, alreadySubmittedIdentical: false };

  const lastSubmission = readLastSubmission(configDir);
  const alreadySubmittedIdentical =
    lastSubmission !== null &&
    lastSubmission.site_url === siteUrl &&
    lastSubmission.bundle_hash === bundleContentHash(bundle);
  return { hasSession: true, alreadySubmittedIdentical };
}

/**
 * Console-UX overhaul (2026-08): a one-line, non-blocking connectable-repo
 * notice (`connectableRepoNotice`, public-remote.ts), printed to stderr in
 * EVERY mode as the very LAST thing `executeScanCommand` does — moved out
 * of the pre-scan guardrail this used to be, and never followed by any
 * question anymore (the old "Continue locally?" prompt is gone entirely;
 * see docs/scan.md). A cheap, local `getRemoteUrl` re-read rather than
 * threading the raw remote URL through `Bundle` itself — same
 * presentation-only-metadata-stays-out-of-the-bundle rationale as
 * `nextStepsState` below.
 */
function printConnectableRepoNotice(opts: ScanCommandOptions, warn: (message: string) => void): void {
  const note = connectableRepoNotice(getRemoteUrl(opts.repoPath));
  // Neutral/dim, never warning-colored (owner follow-up, 2026-08) — this is
  // informational, not an alert; see dim.ts.
  if (note) warn(dim(note));
}

/**
 * Post-scan hand-off to `submit` (console-UX overhaul, 2026-08) — only
 * offered on `interactiveTTY` when there's an actual stored session and
 * this exact bundle content hasn't already been uploaded (see
 * `nextStepsState`'s three states): with no session, `submit` would just
 * fail with "not logged in", so the existing textual "redential login &&
 * redential submit" hint already printed in the summary is left as the
 * only next step; with nothing new to upload, there is nothing to offer.
 *
 * On "yes", hands off to `submit`'s own flow IN-PROCESS
 * (`executeSubmitCommand`) via a DYNAMIC import — not a static one at the
 * top of this file — so `scan`'s own always-run code path (piped/`--json`
 * output, and the TTY summary on every run where this step doesn't fire)
 * never pulls in any network-capable module; only this explicit, freshly
 * consented action does. `author`/`yes: true` are threaded through from
 * what the user already confirmed moments ago in THIS SAME scan (the
 * unified pre-scan confirmation, build-bundle.ts's `promptConfirmScan`) —
 * so submit's own author-selection/authorization step
 * (`buildBundleInteractively`, code shared by both commands) is answered
 * honestly from that same just-given confirmation rather than silently
 * skipped or asked again. Every other part of submit's own consent
 * surface — the exact-JSON print, the upload confirmation prompt, the
 * private-label prompt — fires exactly as it always does on a real
 * `submit` run; nothing about submit's own invariants is weakened here.
 *
 * `AuthError` (the stored session turned out to belong to a different
 * `SITE_URL`, or was deleted between `nextStepsState`'s read and this
 * call) is caught and turned into a plain stderr note rather than
 * propagating: `scan` already fully succeeded and printed everything
 * above it, so a login hiccup on this optional add-on must never turn a
 * successful scan into a failed exit code. Every other error still
 * propagates normally.
 */
async function maybeAddToProfile(
  opts: ScanCommandOptions,
  authors: string[],
  log: (message: string) => void,
  warn: (message: string) => void
): Promise<void> {
  const proceed = await (opts.promptAddToProfileFn ?? promptAddToProfile)();
  if (!proceed) {
    warn(dim("Run `redential submit` any time to add this to your Redential profile."));
    return;
  }

  const { executeSubmitCommand } = await import("./submit-command.js");
  const submitOptions: SubmitCommandOptions = {
    repoPath: opts.repoPath,
    author: authors,
    yes: true,
    confirmUpload: false,
    toolVersion: opts.toolVersion,
    configDir: opts.configDir,
    isTTY: true,
    plain: opts.plain,
    // Reviewer fix (2026-08): forward the same --since window the scan
    // just summarized — without this, "Add THIS to your profile?" would
    // silently rebuild the bundle from FULL history instead of the
    // since-limited one the user just reviewed. `buildBundleInteractively`
    // (shared by scan and submit) already threads `since` straight through
    // to `runScan`, so this is the only place it needed wiring.
    since: opts.since,
    log,
    warn,
  };
  try {
    await executeSubmitCommand(submitOptions);
  } catch (err) {
    if (err instanceof AuthError) {
      warn("Not logged in — run `redential login` then `redential submit` to add this to your profile.");
      return;
    }
    throw err;
  }
}

/**
 * The `scan` command's actual behavior, independent of commander wiring —
 * exists mainly so the public-host warning ("warn, never block") is
 * testable without spawning the built CLI.
 *
 * Output contract (console-UX overhaul) — exactly one of:
 * - `--json` (regardless of `isTTY`), OR piped/redirected stdout with no
 *   flags: ONLY the raw bundle JSON on stdout, byte-identical to every
 *   prior release — the pipe/no-flags case is pinned by tests and MUST
 *   stay byte-for-byte identical; `scan | jq` keeps working unchanged.
 * - A real TTY, no `--json`: ONLY the human-readable summary
 *   (`formatSummary`) — no JSON dump. `redential scan --json` is the
 *   documented source of truth for the exact payload (docs/scan.md); the
 *   summary itself only points at it (and at `--details`) via `--help`
 *   and this doc, not a footer line anymore (owner follow-up, 2026-08).
 * - A real TTY, no `--json`, `--details`: the same summary, with the
 *   histogram sections added (`FormatSummaryOptions.details`).
 * `interactiveTTY` (isTTY AND NOT json) is the single flag deciding both
 * of the above AND whether the huge-repo progress line / post-scan "Add
 * this to your Redential profile?" prompt are interactive at all —
 * `--json` means "treat this run as scripted," full stop, even on a real
 * terminal.
 *
 * Owner-mandated ordering rule (2026-08): on `interactiveTTY`, once the
 * summary has been logged, the connectable-repo notice (if applicable)
 * always prints next, and THEN — never before it — whatever comes last:
 * the interactive "Add this to your Redential profile?" question (state 2
 * below), a plain login+submit reminder (state 1), or nothing at all
 * (state 3). The interactive question, when it fires, must be the
 * genuinely last thing printed before this function returns — nothing may
 * follow it automatically.
 */
export async function executeScanCommand(opts: ScanCommandOptions): Promise<void> {
  const log = opts.log ?? console.log;
  const warn = opts.warn ?? console.error;
  const interactiveTTY = opts.isTTY === true && !opts.json;

  let selectedAuthors: string[] = opts.author;
  const bundle = await buildBundleInteractively({
    ...opts,
    isTTY: interactiveTTY,
    onProgress: buildProgressReporter(opts),
    onAuthorsSelected: (authors) => {
      selectedAuthors = authors;
    },
  });

  if (!interactiveTTY) {
    log(JSON.stringify(bundle, null, 2));
    printConnectableRepoNotice(opts, warn);
    return;
  }

  log(
    formatSummary(bundle, {
      plain: opts.plain,
      details: opts.details,
      sinceLabel: opts.since !== undefined ? describeSince(opts.since) : undefined,
      // A second, cheap local `git rev-parse` call rather than threading
      // this through buildBundleInteractively's Bundle-shaped return —
      // that return type is load-bearing for principle 4 ("the printed
      // JSON is the bundle"), so presentation-only metadata stays out of
      // it. Only evaluated when the summary is actually rendered.
      isShallow: isShallowRepository(opts.repoPath),
    })
  );

  printConnectableRepoNotice(opts, warn);

  // Three states — see nextStepsState's own doc comment: no session ->
  // a plain reminder (no live prompt possible without one); session, not
  // yet submitted -> the live hand-off prompt; session AND already
  // submitted this exact content -> nothing, since there's nothing new to
  // offer. Whichever of these fires is the true last thing printed.
  const nextSteps = nextStepsState(bundle, opts.configDir);
  if (nextSteps.hasSession && !nextSteps.alreadySubmittedIdentical) {
    await maybeAddToProfile(opts, selectedAuthors, log, warn);
  } else if (!nextSteps.hasSession) {
    warn(dim("Log in and run `redential submit` to add this to your Redential profile."));
  }
}
