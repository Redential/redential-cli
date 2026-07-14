import { buildBundleInteractively, type BuildBundleOptions } from "./build-bundle.js";
import { formatSummary } from "./summary.js";
import { describeSince } from "./since.js";
import { getSiteUrl } from "./config.js";
import { readCredentials } from "./credentials.js";
import { bundleContentHash, readLastSubmission } from "./submission-record.js";
import { isShallowRepository } from "./git.js";
import type { Bundle } from "./types.js";

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
  // suppresses the huge-repo progress line and the connectable-repo
  // "Continue locally?" interactive follow-up (both go through
  // `interactiveTTY` below), even though both are otherwise gated on
  // `isTTY` alone. Neither ever touched stdout to begin with (progress is
  // stderr-only; the follow-up is a stdin/stderr prompt), so this isn't
  // about stdout purity — it's about `--json` meaning "treat this run as
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
 * The `scan` command's actual behavior, independent of commander wiring —
 * exists mainly so the public-host warning ("warn, never block") is
 * testable without spawning the built CLI.
 *
 * Output contract (phase 2 of the console-UX redesign) — exactly one of:
 * - `--json` (regardless of `isTTY`), OR piped/redirected stdout with no
 *   flags: ONLY the raw bundle JSON on stdout, byte-identical to every
 *   prior release — the pipe/no-flags case is pinned by tests and MUST
 *   stay byte-for-byte identical; `scan | jq` keeps working unchanged.
 * - A real TTY, no `--json`: ONLY the human-readable summary
 *   (`formatSummary`) — no JSON dump. The summary itself tells the user
 *   how to get the exact payload (`redential scan --json`) and how to see
 *   the hour/weekday histograms (`redential scan --details`).
 * - A real TTY, no `--json`, `--details`: the same summary, with the
 *   histogram sections added (`FormatSummaryOptions.details`).
 * `interactiveTTY` (isTTY AND NOT json) is the single flag deciding both
 * of the above AND whether the connectable-repo "Continue locally?"
 * follow-up / huge-repo progress line are interactive at all — `--json`
 * means "treat this run as scripted," full stop, even on a real terminal.
 */
export async function executeScanCommand(opts: ScanCommandOptions): Promise<void> {
  const log = opts.log ?? console.log;
  const interactiveTTY = opts.isTTY === true && !opts.json;
  const bundle = await buildBundleInteractively({
    ...opts,
    isTTY: interactiveTTY,
    onProgress: buildProgressReporter(opts),
  });
  // `null` only happens when a real TTY user declined the connectable-repo
  // "Continue locally?" follow-up (see build-bundle.ts) — buildBundleInteractively
  // already printed the "nothing scanned" notice; nothing else to do here.
  if (bundle === null) return;

  if (!interactiveTTY) {
    log(JSON.stringify(bundle, null, 2));
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
      // it. Only evaluated when the summary is actually rendered, same
      // as nextStepsState below.
      isShallow: isShallowRepository(opts.repoPath),
      ...nextStepsState(bundle, opts.configDir),
    })
  );
}
