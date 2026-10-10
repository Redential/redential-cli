import type { FileChurn, RawCommit } from "./git.js";

// Checked-in artifacts, not authored work — see docs/schema.md's "What is
// excluded from churn" for the full, versioned list (part of the bundle's
// measurement contract, not an implementation detail). Without this, a
// single `npm install`/build commit can dwarf months of actual code in the
// languages/categories breakdown.
const LOCKFILE_BASENAMES = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb"]);

const MINIFIED_PATTERN = /\.min\.js$/i;

// Requires the name to be a full path segment (bounded by "/" or the start,
// and followed by "/") so it only matches build-output DIRECTORIES, never a
// substring like "redistribute/" or a same-named leaf file.
const GENERATED_DIR_PATTERN = /(^|\/)(dist|build|\.next|node_modules)\//i;

// Checked-in third-party trees (Go vendor/, Composer vendor/, C++ third_party/,
// etc.) — same full-segment rule as GENERATED_DIR_PATTERN so `vendor-api/` is
// not excluded. Skill detection and churn shares skip these paths so a
// vendored copy of a library cannot credit the author (#27).
const VENDORED_DIR_PATTERN = /(^|\/)(vendor|vendored|third_party|third-party)\//i;

// `path` is always a git-reported path (see categorize.ts's own note), so
// splitting on "/" is correct on every host OS, including Windows — this
// is deliberately not node:path's `basename`, which would split on "\"
// there and never match.
function basename(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? path : path.slice(idx + 1);
}

/** Lockfile, minified bundle, or build-output path — excluded by name/shape
 * alone, with no need to look at commit history. */
export function isExcludedPath(path: string): boolean {
  return (
    LOCKFILE_BASENAMES.has(basename(path)) ||
    MINIFIED_PATTERN.test(path) ||
    GENERATED_DIR_PATTERN.test(path) ||
    VENDORED_DIR_PATTERN.test(path)
  );
}

// A file whose entire churn history (within the selected author's commits)
// is a single commit that added at least this many lines is almost always a
// vendored/generated artifact that happened to get committed — a bundled
// dependency, a lockfile format not already recognized by name, a one-time
// codegen dump — rather than authored work. 1000 is comfortably above any
// plausible hand-written single-file commit.
export const GENERATED_FILE_MIN_ADDED_LINES = 1000;

/**
 * Paths whose only appearance across `commits` is one commit adding at
 * least `GENERATED_FILE_MIN_ADDED_LINES` lines — "a single commit, no
 * history before or after it". Operates over whatever commit set the caller
 * passes in (the selected author's commits, in `scan.ts`), not the whole
 * repo — this is a per-scan heuristic, not a repo-wide fact.
 */
export function heuristicallyGeneratedPaths(commits: RawCommit[]): Set<string> {
  const touchCount = new Map<string, number>();
  const soleEntry = new Map<string, FileChurn>();
  for (const c of commits) {
    for (const f of c.churn) {
      touchCount.set(f.path, (touchCount.get(f.path) ?? 0) + 1);
      soleEntry.set(f.path, f);
    }
  }

  const generated = new Set<string>();
  for (const [path, count] of touchCount) {
    if (count === 1 && soleEntry.get(path)!.added >= GENERATED_FILE_MIN_ADDED_LINES) {
      generated.add(path);
    }
  }
  return generated;
}
