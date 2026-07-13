import { listHeadTreeBlobs, readHeadBlobContents } from "../git.js";
import { isExcludedPath } from "../churn-exclusions.js";
import { debugLog } from "../debug.js";

export interface SnapshotFile {
  path: string;
  content: string;
}

export interface SnapshotOptions {
  /** Per-file cap, decided from the `ls-tree -l` size BEFORE fetching
   * content — a minified/generated blob past this isn't worth parsing and
   * this bounds worst-case memory regardless of what's committed. Default:
   * 200 KiB. */
  maxFileBytes?: number;
  /** Total file-count cap, applied deterministically (see truncation note
   * below) — bounds worst-case memory/time on a huge monorepo regardless of
   * how many individual files stay under maxFileBytes. Default: 5000. */
  maxFiles?: number;
}

const DEFAULT_MAX_FILE_BYTES = 200 * 1024;
const DEFAULT_MAX_FILES = 5000;

// Content for this many surviving paths is fetched (and held) at once, via
// a single batched `git cat-file --batch` process (git.ts's
// readHeadBlobContents), instead of one process per file — same
// "subprocess spawn count is the dominant cost at scale" rationale as
// skill-detect.ts's DIFF_BATCH_SIZE, and it bounds how much file content is
// ever in memory simultaneously to one batch's worth, not the whole
// snapshot's.
const CONTENT_BATCH_SIZE = 200;

/** `.d.ts`/`.d.tsx` declaration files carry no authored logic (just type
 * shapes, often generated) — never part of the structural graph the spike
 * walks. `.tsx` has no declaration-file counterpart in practice, but the
 * check is written generically rather than assuming `.ts` is the only
 * extension that can end in `.d.ts`. */
function isTypeScriptSourceFile(path: string): boolean {
  if (path.endsWith(".d.ts") || path.endsWith(".d.tsx")) return false;
  return path.endsWith(".ts") || path.endsWith(".tsx");
}

/**
 * Reads every `.ts`/`.tsx` file at HEAD, entirely from local git objects —
 * never the working tree, so uncommitted edits never leak into the graph
 * and the snapshot is reproducible from the commit alone. Nothing is ever
 * written to disk and nothing is cached between calls; the returned array
 * is the only copy, held in memory for as long as the caller keeps it.
 *
 * Pipeline: enumerate HEAD's tree once (listHeadTreeBlobs), filter to
 * TypeScript source files, drop vendored/lockfile/build-output paths
 * (isExcludedPath — same rationale as skill detection: they'd be false
 * "you wrote this" signals), drop anything over `maxFileBytes` using the
 * size ls-tree already reported (no content fetch wasted on a file that's
 * getting dropped anyway), sort and truncate to `maxFiles` for a
 * deterministic result independent of git's own tree-walk order, then
 * fetch the surviving files' content in bounded batches.
 *
 * Returns [] for a repo with no commits yet (unborn HEAD) rather than
 * throwing, matching listHeadTreeBlobs' own empty-repo handling.
 */
export async function readHeadSnapshot(repoPath: string, opts: SnapshotOptions = {}): Promise<SnapshotFile[]> {
  const maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;

  const entries = await listHeadTreeBlobs(repoPath);

  const candidatePaths: string[] = [];
  let oversizeExcluded = 0;
  for (const entry of entries) {
    if (!isTypeScriptSourceFile(entry.path)) continue;
    if (isExcludedPath(entry.path)) continue;
    if (entry.size > maxFileBytes) {
      // The path itself is never logged (see readHeadBlobContents' doc
      // comment on src/debug.ts's paste-safety invariant) — only the
      // reason and the size that triggered it.
      debugLog(`snapshot: excluded a file over the size cap (${entry.size} bytes > ${maxFileBytes} bytes)`);
      oversizeExcluded++;
      continue;
    }
    candidatePaths.push(entry.path);
  }

  // Sorted BEFORE truncation so which files survive a maxFiles cutoff is a
  // pure function of the path set, not of git's tree-walk/readdir order —
  // the same snapshot run twice (or on two machines) must drop the same
  // files.
  candidatePaths.sort();

  let selectedPaths = candidatePaths;
  if (candidatePaths.length > maxFiles) {
    selectedPaths = candidatePaths.slice(0, maxFiles);
    debugLog(`snapshot: file count truncated to ${maxFiles} (dropped ${candidatePaths.length - maxFiles})`);
  }
  if (oversizeExcluded > 0) {
    debugLog(`snapshot: ${oversizeExcluded} file(s) excluded for exceeding the size cap`);
  }

  const files: SnapshotFile[] = [];
  for (let i = 0; i < selectedPaths.length; i += CONTENT_BATCH_SIZE) {
    const batch = selectedPaths.slice(i, i + CONTENT_BATCH_SIZE);
    const contentByPath = await readHeadBlobContents(repoPath, batch);
    for (const path of batch) {
      const content = contentByPath.get(path);
      // Missing only if readHeadBlobContents' fail-quiet path was hit
      // (e.g. a concurrent history rewrite mid-read) — skip rather than
      // include a file with no content.
      if (content !== undefined) files.push({ path, content });
    }
  }

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return files;
}
