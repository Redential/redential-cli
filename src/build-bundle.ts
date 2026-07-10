import { runScan, listAuthors, type AuthorCandidate } from "./scan.js";
import { ScanError } from "./errors.js";
import { promptAuthors, promptConfirmAttestation } from "./prompt.js";
import { getRemoteUrl } from "./git.js";
import { publicHostWarning } from "./public-remote.js";
import type { Bundle } from "./types.js";

export interface BuildBundleOptions {
  repoPath: string;
  author: string[];
  yes: boolean;
  toolVersion: string;
  configDir?: string;
  // Injectable for tests; defaults to the real interactive prompts.
  promptAuthorsFn?: (candidates: AuthorCandidate[]) => Promise<string[]>;
  promptConfirmFn?: () => Promise<boolean>;
  warn?: (message: string) => void;
  // Raw --since spec, forwarded to runScan (src/since.ts parses it). See
  // scan-command.ts / docs/scan.md for the CLI-facing behavior.
  since?: string;
  // Forwarded to runScan — see ScanOptions.onProgress.
  onProgress?: (scanned: number, total: number) => void;
}

/**
 * Shared by `scan` and `submit`: author selection, authorization
 * confirmation, and the actual scan. `submit` calls this directly instead
 * of re-deriving the bundle another way, so the bundle it uploads is
 * produced by the exact same code path `scan` prints (principle 4,
 * "User-reviewed").
 */
export async function buildBundleInteractively(opts: BuildBundleOptions): Promise<Bundle> {
  const warn = opts.warn ?? console.error;

  const warning = publicHostWarning(getRemoteUrl(opts.repoPath));
  if (warning) warn(warning);

  let authors = opts.author;
  if (authors.length === 0) {
    const candidates = await listAuthors(opts.repoPath);
    if (candidates.length === 0) {
      throw new ScanError("This repository has no commits yet — nothing to scan.");
    }
    authors = await (opts.promptAuthorsFn ?? promptAuthors)(candidates);
  }

  let confirmed = opts.yes;
  if (!confirmed) {
    confirmed = await (opts.promptConfirmFn ?? promptConfirmAttestation)();
  }

  return runScan({
    repoPath: opts.repoPath,
    authors,
    confirmed,
    toolVersion: opts.toolVersion,
    configDir: opts.configDir,
    since: opts.since,
    onProgress: opts.onProgress,
  });
}
