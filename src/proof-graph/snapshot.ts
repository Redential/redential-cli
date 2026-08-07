import { listHeadTreeBlobs, readBlobContents } from "../git.js";
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
  /**
   * Optional progress callback, invoked once per content-fetch batch with
   * (files fetched so far, total files to fetch) — counts only, never a
   * path (see src/proof-graph/progress.ts's content rule). Purely additive:
   * every existing caller that doesn't pass this keeps working unchanged.
   */
  onProgress?: (done: number, total: number) => void;
}

const DEFAULT_MAX_FILE_BYTES = 200 * 1024;
const DEFAULT_MAX_FILES = 5000;

// Content for this many surviving paths is fetched (and held) at once, via
// a single batched `git cat-file --batch` process (git.ts's
// readBlobContents), instead of one process per file — same
// "subprocess spawn count is the dominant cost at scale" rationale as
// skill-detect.ts's DIFF_BATCH_SIZE.
//
// `readBlobContents` reads files from a requested git revision rather than
// only from HEAD. HEAD represents the currently checked-out snapshot, but
// callers may need historical snapshots as well (for example, a commit and
// its parent when comparing manifest changes). The batching behavior remains
// identical regardless of which revision is being read.
//
// This bounds how much file content is ever in memory simultaneously to one
// batch's worth, not the whole repository snapshot.
//
// Raised from 200 to 1000 (measured): at 2000 files, 200 meant 10 batches —
// each batch pays a fixed `git cat-file --batch` process-spawn cost on top
// of its actual read work, and that per-batch overhead alone measured
// ~300ms across those 10 batches (529ms at CONTENT_BATCH_SIZE=200 vs
// ~850ms of overhead extrapolated for a from-scratch 1-batch run — see
// docs/proof-graph-spike.md's "Scale hardening" -> "History-dominated
// repos" subsection for the full A/B). 1000 still bounds worst-case memory
// fine: 1000 files x the 200 KiB per-file cap (maxFileBytes) is a 200 MB
// theoretical ceiling, and real TypeScript source files sit far below that
// cap in practice, so a batch's actual in-memory footprint is a small
// fraction of the theoretical worst case. Not raised further than 1000:
// that's already a 5x reduction in batch count for the largest fixture this
// spike is measured against (5000 files -> 5 batches instead of 25), and
// pushing it higher stops buying much while growing the worst-case-memory
// ceiling for no measured benefit.
const CONTENT_BATCH_SIZE = 1000;

/** `.d.ts`/`.d.tsx` declaration files carry no authored logic (just type
 * shapes, often generated) — never part of the structural graph the spike
 * walks. `.tsx` has no declaration-file counterpart in practice, but the
 * check is written generically rather than assuming `.ts` is the only
 * extension that can end in `.d.ts`. */
function isTypeScriptSourceFile(path: string): boolean {
  if (path.endsWith(".d.ts") || path.endsWith(".d.tsx")) return false;
  return path.endsWith(".ts") || path.endsWith(".tsx");
}

// SNAPSHOT-LOCAL extra exclusions, deliberately NOT added to
// churn-exclusions.ts (isExcludedPath, used below alongside these). These
// four dirs/patterns are generated-code shapes churn-exclusions.ts doesn't
// already cover (its own GENERATED_DIR_PATTERN only knows dist/build/.next/
// node_modules/ — see that file's own comment) — a proof-graph snapshot
// walking into e.g. a committed `out/` (Next.js static export),
// `coverage/` (test-coverage HTML/JSON reports), `.vercel/` (deployment
// build cache some repos commit), `storybook-static/` (a built Storybook
// site), any directory literally named `generated/`, or a `.min.ts` file
// would parse checked-in build output as if it were authored source —
// exactly the kind of false "you wrote this" signal isExcludedPath already
// exists to prevent for churn, just for a different set of shapes this
// module happens to be more exposed to (the proof-graph spike parses full
// file bodies, not just diff churn). Applying them HERE (snapshot-side)
// rather than editing churn-exclusions.ts keeps the shipping `scan`
// command's own behavior (which uses churn-exclusions.ts directly, and is
// explicitly out of scope for this milestone — see CLAUDE.md) completely
// unchanged; upstreaming some or all of these into churn-exclusions.ts
// itself is a separate future discussion, not decided here (see
// docs/proof-graph-spike.md's own note on this).
//
// This is hygiene, not the hang fix from this same milestone (see
// findInferredTriple in infer.ts) — the hang this milestone diagnosed and
// fixed reproduced with zero generated content in the fixture, purely from
// anchor-instance search-space size.
const SNAPSHOT_LOCAL_EXCLUDED_DIR_PATTERN = /(^|\/)(out|coverage|\.vercel|storybook-static|generated)\//i;
const MINIFIED_TS_PATTERN = /\.min\.ts$/i;

function isSnapshotLocalExcludedPath(path: string): boolean {
  return SNAPSHOT_LOCAL_EXCLUDED_DIR_PATTERN.test(path) || MINIFIED_TS_PATTERN.test(path);
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
 * "you wrote this" signals) plus this module's own extra generated-code
 * exclusions (isSnapshotLocalExcludedPath — see its own comment), drop
 * anything over `maxFileBytes` using the
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
    if (isSnapshotLocalExcludedPath(entry.path)) continue;
    if (entry.size > maxFileBytes) {
      // The path itself is never logged (see readBlobContents' doc
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
    // Fetch each batch in a single git invocation rather than spawning one
    // process per file.
    const requests = batch.map((path) => ({
    revision: "HEAD",
    path,
    }));
    const contentByRevision = await readBlobContents(repoPath, requests);
    const headContent = contentByRevision.get("HEAD");

    if (!headContent) continue;

    for (const path of batch) {
      const content = headContent.get(path);

      if (content !== undefined) {
        files.push({ path, content });
      }
    }
    opts.onProgress?.(Math.min(i + CONTENT_BATCH_SIZE, selectedPaths.length), selectedPaths.length);
  }

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return files;
}
