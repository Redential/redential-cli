import { runScan, listAuthors, type AuthorCandidate } from "./scan.js";
import { ScanError } from "./errors.js";
import { promptAuthors, promptConfirmAttestation } from "./prompt.js";
import { getRemoteUrl } from "./git.js";
import { publicHostWarning } from "./public-remote.js";

export interface ScanCommandOptions {
  repoPath: string;
  author: string[];
  yes: boolean;
  toolVersion: string;
  configDir?: string;
  // Injectable for tests; defaults to the real interactive prompts.
  promptAuthorsFn?: (candidates: AuthorCandidate[]) => Promise<string[]>;
  promptConfirmFn?: () => Promise<boolean>;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}

/**
 * The `scan` command's actual behavior, independent of commander wiring —
 * exists mainly so the public-host warning ("warn, never block") is
 * testable without spawning the built CLI.
 */
export async function executeScanCommand(opts: ScanCommandOptions): Promise<void> {
  const log = opts.log ?? console.log;
  // Separate from `log`/stdout so `scan | jq` (or any bundle consumer)
  // never has to skip a leading non-JSON line.
  const warn = opts.warn ?? console.error;

  const warning = publicHostWarning(getRemoteUrl(opts.repoPath));
  if (warning) warn(warning);

  let authors = opts.author;
  if (authors.length === 0) {
    const candidates = listAuthors(opts.repoPath);
    if (candidates.length === 0) {
      throw new ScanError("This repository has no commits yet — nothing to scan.");
    }
    authors = await (opts.promptAuthorsFn ?? promptAuthors)(candidates);
  }

  let confirmed = opts.yes;
  if (!confirmed) {
    confirmed = await (opts.promptConfirmFn ?? promptConfirmAttestation)();
  }

  const bundle = runScan({
    repoPath: opts.repoPath,
    authors,
    confirmed,
    toolVersion: opts.toolVersion,
    configDir: opts.configDir,
  });
  log(JSON.stringify(bundle, null, 2));
}
