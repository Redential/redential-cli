import { buildBundleInteractively, type BuildBundleOptions } from "./build-bundle.js";
import { formatConsentSummary, formatSummary } from "./summary.js";
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
  // is appended; tests set this explicitly instead of relying on a real
  // TTY. Undefined behaves like `false` (JSON-only), matching a piped
  // stdout so `scan | jq` never sees anything but the bundle.
  isTTY?: boolean;
  // Forces JSON-only output even when stdout is a TTY.
  json?: boolean;
  // True to render the summary with the ASCII/no-color fallback theme
  // (see summary.ts's shouldUsePlainOutput) instead of ANSI + Unicode
  // box-drawing. cli.ts computes this from process.platform/process.env;
  // tests set it explicitly, same pattern as isTTY.
  plain?: boolean;
  // Where the huge-repo progress line ("scanning commits... N/Total") is
  // written — ALWAYS stderr, NEVER the `log` callback above (which backs
  // stdout). Defaults to `process.stderr.write`; tests inject a collector
  // instead of a real stream. Only used when `isTTY` is true — see
  // buildProgressReporter below.
  progressWrite?: (message: string) => void;
};

/**
 * Builds the onProgress callback threaded into runScan (via
 * buildBundleInteractively), or undefined when progress shouldn't be shown
 * at all — piped/non-TTY stdout stays completely silent on stderr too, so
 * `scan | jq` output is never at risk of interleaving weirdly with a
 * script that also inspects stderr. Throttled to PROGRESS_INTERVAL so a
 * 20k-commit walk doesn't write 20,000 lines; always writes the final
 * scanned === total line so the terminal doesn't sit on a stale count.
 */
function buildProgressReporter(opts: ScanCommandOptions): ((scanned: number, total: number) => void) | undefined {
  if (!opts.isTTY) return undefined;
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
 * Local-only session/submission state for the wrapped summary's closing
 * next-step hint (see summary.ts's three CTA states). Reads only the CLI's
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
 * Output contract: piped/redirected stdout (or `--json`) always gets ONLY
 * the raw bundle JSON, byte-identical to before the summary existed, so
 * `scan | jq` keeps working. A real TTY (and no `--json`) gets a
 * human-readable consent summary FIRST (the actual surface a user reads
 * before deciding whether to run `submit`), then the same JSON, then the
 * human-readable "wrapped" summary below it — JSON first among those two so
 * the wrapped summary is what's left on screen once the JSON has scrolled
 * up. Both summaries are pure formatting over the bundle `runScan` already
 * computed, not a second data source.
 */
export async function executeScanCommand(opts: ScanCommandOptions): Promise<void> {
  const log = opts.log ?? console.log;
  const bundle = await buildBundleInteractively({ ...opts, onProgress: buildProgressReporter(opts) });
  // `null` only happens when a real TTY user declined the connectable-repo
  // "Continue locally?" follow-up (see build-bundle.ts) — buildBundleInteractively
  // already printed the "nothing scanned" notice; nothing else to do here.
  if (bundle === null) return;
  const bundleJson = JSON.stringify(bundle, null, 2);

  if (opts.isTTY && !opts.json) {
    log(formatConsentSummary(bundle, { plain: opts.plain, command: "scan" }));
    log("Exact payload (byte-for-byte what `redential submit` would send):");
  }
  log(bundleJson);
  if (opts.isTTY && !opts.json) {
    log(
      formatSummary(bundle, {
        plain: opts.plain,
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
}
