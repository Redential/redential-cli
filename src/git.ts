import { execFileSync, spawn } from "node:child_process";
import { debugLog } from "./debug.js";
import type { RepoInfo } from "./types.js";

export interface FileChurn {
  path: string;
  added: number;
  deleted: number;
}

export interface RawCommit {
  sha: string;
  email: string;
  authorDate: Date;
  // Distinct from authorDate: the date the commit object was actually
  // written (rewritten by a rebase/`filter-branch`/`commit --amend`, set to
  // merge time by a squash-merge platform, etc.), whereas authorDate is
  // carried over unchanged by all of those. The gap between the two is
  // date_forensics' whole signal (see scan.ts's computeDateForensics and
  // docs/schema.md's `integrity.date_forensics` section) — never displayed
  // on its own, never a per-commit value in the bundle.
  committerDate: Date;
  signed: boolean;
  churn: FileChurn[];
  // 2+ parents. `--numstat` already emits no per-file churn for merges (so
  // they contribute nothing to language/category shares); skill detection
  // mirrors that and skips them too, rather than reading a combined diff.
  isMerge: boolean;
}

function git(repoPath: string, args: string[]): string {
  // argv only — NEVER repoPath/cwd (would reveal an employer/project name
  // if pasted into a public issue) and never the command's own output.
  debugLog(`git ${args.join(" ")}`);
  return execFileSync("git", args, {
    cwd: repoPath,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

const RECORD_SEP = "\x01";
const FIELD_SEP = "\x02";

// A repo with no commits yet ("unborn HEAD") is the one `git log` failure
// getAllCommits/getCommitCount treat as "empty repository" (returning
// [] / 0) rather than surfacing — every other failure (corrupt repo, git
// missing, permissions) is a real problem and must not be swallowed the
// same way, or a huge-repo maxBuffer-style bug just gets replaced by a
// different silently-wrong "no commits" result. Matched on stderr, not
// exit code alone, since both cases exit 128.
const EMPTY_REPO_PATTERN = /does not have any commits yet|bad default revision/;

function parseCommitRecord(record: string): RawCommit {
  const lines = record.split("\n");
  const [sha, email, authorDateIso, committerDateIso, signatureStatus, parents] = lines[0].split(FIELD_SEP);
  const churn: FileChurn[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const [addedRaw, deletedRaw, ...pathParts] = parts;
    churn.push({
      path: pathParts.join("\t"),
      added: addedRaw === "-" ? 0 : parseInt(addedRaw, 10),
      deleted: deletedRaw === "-" ? 0 : parseInt(deletedRaw, 10),
    });
  }
  return {
    sha,
    email,
    authorDate: new Date(authorDateIso),
    committerDate: new Date(committerDateIso),
    // Only a fully verified good signature ("G") counts as signed. "U"
    // (good but untrusted/unmatched key), "B" (bad), "X"/"Y"/"R"
    // (expired/expired-key/revoked-key) and "E" (can't check) all mean
    // the signature doesn't actually establish anything — see
    // docs/schema.md's `signed` section for why.
    signed: signatureStatus === "G",
    churn,
    isMerge: parents.trim().split(/\s+/).filter(Boolean).length > 1,
  };
}

export interface GetAllCommitsOptions {
  /** Limits the walk to commits at or after this date (`git log --since`,
   * committer-date-based) — see src/since.ts. Undefined walks full history. */
  since?: Date;
  /** Invoked once per commit as it's parsed off the stream, in `--reverse`
   * (oldest-first) order — drives scan-command.ts's stderr progress line.
   * Never receives anything beyond a running count: no sha, path, or email. */
  onProgress?: (count: number) => void;
}

/**
 * All commits reachable from HEAD, oldest first (or, with `since` set, all
 * commits at or after that date). Returns [] for a repo with no commits
 * yet, rather than throwing — any OTHER git failure rejects instead of
 * silently returning [], so it isn't mistaken for an empty repo.
 *
 * Streams `git log`'s stdout via `spawn` and parses commit records
 * incrementally as chunks arrive, instead of buffering the whole output
 * (as the previous `execFileSync`-based version did) and instead of
 * holding it all at once — for a huge repo, whole-output buffering would
 * both blow past Node's default 1MB child-process maxBuffer (silently
 * swallowed by the old try/catch as an empty repo) and hold everything in
 * memory at once. Commit records here only ever carry numstat *counts*,
 * never diff content, so the accumulated array stays cheap even at tens of
 * thousands of commits — see getCommitsAddedLines for the actual diff
 * content path, which is batched separately.
 */
export function getAllCommits(repoPath: string, opts: GetAllCommitsOptions = {}): Promise<RawCommit[]> {
  const args = [
    "log",
    "--reverse",
    "--numstat",
    `--format=${RECORD_SEP}%H${FIELD_SEP}%ae${FIELD_SEP}%aI${FIELD_SEP}%cI${FIELD_SEP}%G?${FIELD_SEP}%P`,
  ];
  if (opts.since) args.push(`--since=${opts.since.toISOString()}`);
  // Format string omitted — it's noisy separator bytes, not useful signal.
  debugLog(`git log --reverse --numstat${opts.since ? ` --since=${opts.since.toISOString()}` : ""} (streaming)`);

  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd: repoPath, stdio: ["ignore", "pipe", "pipe"] });
    const commits: RawCommit[] = [];
    let buffer = "";
    let stderr = "";
    let count = 0;

    // `buffer` always starts with its own leading RECORD_SEP once git has
    // written anything (the format string opens with it) — that leading
    // byte marks where the CURRENT record starts, not part of its content,
    // so every slice below strips it via `.slice(1, ...)`/`.slice(1)`.
    const consumeCompleteRecords = (final: boolean) => {
      for (;;) {
        const idx = buffer.indexOf(RECORD_SEP, 1);
        if (idx === -1) {
          if (final && buffer.trim().length > 0) {
            commits.push(parseCommitRecord(buffer.slice(1)));
            count++;
            opts.onProgress?.(count);
            buffer = "";
          }
          return;
        }
        const record = buffer.slice(1, idx);
        buffer = buffer.slice(idx);
        if (record.trim().length > 0) {
          commits.push(parseCommitRecord(record));
          count++;
          opts.onProgress?.(count);
        }
      }
    };

    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      buffer += chunk;
      consumeCompleteRecords(false);
    });
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      stderr += chunk;
    });
    // A spawn-level failure (e.g. `git` itself isn't on PATH) is a real
    // problem, not an empty repo — same "don't swallow real errors into a
    // misleading no-commits result" rationale as the exit-code branch
    // below.
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code !== 0) {
        if (EMPTY_REPO_PATTERN.test(stderr)) {
          resolve([]);
        } else {
          reject(new Error(`git log failed (exit ${code}): ${stderr.trim() || "unknown error"}`));
        }
        return;
      }
      consumeCompleteRecords(true);
      resolve(commits);
    });
  });
}

/** Fast total for the progress denominator — same `since` window as
 * getAllCommits, so "N/Total" is consistent with what's actually walked. */
export function getCommitCount(repoPath: string, since?: Date): number {
  const args = ["rev-list", "--count", "HEAD"];
  if (since) args.push(`--since=${since.toISOString()}`);
  try {
    const count = parseInt(git(repoPath, args).trim(), 10);
    return Number.isNaN(count) ? 0 : count;
  } catch {
    return 0;
  }
}

/** First line of `rev-list --max-parents=0`; multi-root histories are out of scope. */
export function getRootCommitSha(repoPath: string): string {
  return git(repoPath, ["rev-list", "--max-parents=0", "HEAD"]).trim().split("\n")[0];
}

/**
 * The root commit's own author date — always the TRUE start of the repo's
 * history, independent of any `--since` window applied elsewhere. Used for
 * `repo.age_days`, which must keep meaning "how old is this repo", not
 * "how old is the analyzed window" (see docs/schema.md and docs/scan.md's
 * `--since` section).
 */
export function getRootCommitDate(repoPath: string, rootSha: string): Date {
  return new Date(git(repoPath, ["show", "-s", "--format=%aI", rootSha]).trim());
}

/** Raw `origin` remote URL, read purely from local git config — null if there's none. */
export function getRemoteUrl(repoPath: string): string | null {
  try {
    return git(repoPath, ["remote", "get-url", "origin"]).trim();
  } catch {
    return null;
  }
}

export function getRemoteHostType(repoPath: string): RepoInfo["host_type"] {
  const url = getRemoteUrl(repoPath);
  if (!url) return "none";
  if (/github\.com/.test(url)) return "github";
  if (/gitlab\.com/.test(url)) return "gitlab";
  if (/bitbucket\.org/.test(url)) return "bitbucket";
  return "other";
}

/**
 * True for a shallow clone (`--depth N`) — history before the shallow
 * boundary simply doesn't exist locally, which would silently understate
 * `repo.age_days`, span, and commit counts with no indication why. Never a
 * reason to block scanning (same "warn, never block" stance as
 * publicHostWarning) — just something the user should know about. Fails
 * open (false) on any error, matching every other git.ts boolean-ish
 * probe: an inconclusive read must never look like "definitely not
 * shallow" being asserted with confidence it doesn't have, but blocking
 * scan on an advisory check would be worse than a missed warning.
 */
export function isShallowRepository(repoPath: string): boolean {
  try {
    return git(repoPath, ["rev-parse", "--is-shallow-repository"]).trim() === "true";
  } catch {
    return false;
  }
}

/**
 * The effective (local-overriding-global) `git config user.email` — used
 * ONLY to pre-select a candidate author identity already returned by
 * `listAuthors` (build-bundle.ts); never trusted as an authorization
 * signal by itself (the existing confirm-attestation step still applies
 * regardless of how the author was chosen). Null if unset or unreadable.
 */
export function getConfiguredUserEmail(repoPath: string): string | null {
  try {
    const email = git(repoPath, ["config", "user.email"]).trim();
    return email.length > 0 ? email : null;
  } catch {
    return null;
  }
}

export interface AddedLines {
  path: string;
  addedLines: string;
}

/**
 * Lines a single (non-merge — caller's responsibility to skip those,
 * matching `getAllCommits`' own numstat behavior) commit ADDED, grouped by
 * file — the input to skill-detection pattern matching (src/skill-detect.ts).
 * Never removed/context lines: we care what was introduced, not what a diff
 * happened to touch. `--no-color`/`--no-ext-diff`/`core.quotepath=off` keep
 * the user's own git config (color.ui, an external diff tool, quoted
 * non-ASCII paths) from corrupting this parser — this reads local git
 * output, but the shape of that output must stay ours to depend on.
 */
export function getCommitAddedLines(repoPath: string, sha: string): AddedLines[] {
  let out: string;
  try {
    out = git(repoPath, [
      "-c",
      "core.quotepath=off",
      "show",
      sha,
      "--unified=0",
      "--format=",
      "--no-color",
      "--no-ext-diff",
    ]);
  } catch {
    return [];
  }

  // Diff CONTENT lines mirror the file's own line endings — a CRLF-authored
  // file's "+" lines each carry a trailing \r once this only splits on "\n"
  // below. That \r would otherwise leak into every downstream regex in
  // import-detect.ts (JS's `^`/`$` under the `m` flag treat a bare \r as
  // its own line terminator, independent of \n) and, worse, potentially
  // into a matched package name itself. This can happen on any OS that
  // scans a CRLF-authored file, not just Windows — normalize once, up
  // front, rather than special-case every parser downstream.
  out = out.replace(/\r\n/g, "\n");

  const files: AddedLines[] = [];
  let currentPath: string | null = null;
  let currentLines: string[] = [];
  const flush = () => {
    if (currentPath) files.push({ path: currentPath, addedLines: currentLines.join("\n") });
  };
  for (const line of out.split("\n")) {
    if (line.startsWith("+++ b/")) {
      flush();
      currentPath = line.slice("+++ b/".length);
      currentLines = [];
    } else if (line.startsWith("+++ /dev/null")) {
      // Deleted file — nothing was added to it.
      flush();
      currentPath = null;
      currentLines = [];
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      currentLines.push(line.slice(1));
    }
  }
  flush();
  return files;
}

const SHOW_HEADER_PATTERN = /^\x01([0-9a-f]{40})$/;

/**
 * Batched form of getCommitAddedLines: fetches added-line diff content for
 * MANY commits in a single `git show <sha...>` process instead of one
 * process per commit — the dominant cost at huge-repo scale is subprocess
 * spawn count, not git's own diff work. Callers (skill-detect.ts) chunk
 * their sha list themselves, so at most one chunk's worth of diff text is
 * ever held in memory at a time — see docs/scan.md's "huge repositories"
 * section.
 *
 * Streams stdout and parses line-by-line rather than buffering the whole
 * process output (same maxBuffer rationale as getAllCommits — a batch's
 * combined diff can easily exceed 1MB). Record boundaries are anchored to
 * whole lines matching `\x01<40 hex chars>` (the `--format=\x01%H` header
 * git emits once per commit) rather than a raw byte search: unlike
 * getAllCommits' numstat records, this stream carries arbitrary user file
 * content, and diff body lines always start with `+`/`-`/` `/`@`/`d`/`i`
 * (unified-diff syntax) — never with the bare `\x01` byte at position 0 —
 * so a content line can never be mistaken for a header.
 *
 * Never throws: a git failure (e.g. an unresolvable sha) resolves with
 * whatever was already parsed, matching getCommitAddedLines' own
 * fail-quiet-to-no-diff-data behavior — skill detection missing a match is
 * not a privacy problem, only a completeness one.
 */
export function getCommitsAddedLines(repoPath: string, shas: string[]): Promise<Map<string, AddedLines[]>> {
  const result = new Map<string, AddedLines[]>();
  if (shas.length === 0) return Promise.resolve(result);

  const args = [
    "-c",
    "core.quotepath=off",
    "show",
    ...shas,
    "--unified=0",
    `--format=${RECORD_SEP}%H`,
    "--no-color",
    "--no-ext-diff",
  ];
  debugLog(`git show <${shas.length} shas> --unified=0 (batched diff fetch)`);

  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd: repoPath, stdio: ["ignore", "pipe", "pipe"] });
    let currentSha: string | null = null;
    let currentPath: string | null = null;
    let currentLines: string[] = [];
    let files: AddedLines[] = [];
    let leftover = "";

    const flushFile = () => {
      if (currentPath) files.push({ path: currentPath, addedLines: currentLines.join("\n") });
      currentPath = null;
      currentLines = [];
    };
    const flushCommit = () => {
      flushFile();
      if (currentSha) result.set(currentSha, files);
      files = [];
    };

    const processLine = (rawLine: string) => {
      // Same CRLF normalization as getCommitAddedLines, applied per-line
      // since this parses incrementally instead of over the whole buffer.
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      const header = SHOW_HEADER_PATTERN.exec(line);
      if (header) {
        flushCommit();
        currentSha = header[1];
      } else if (line.startsWith("+++ b/")) {
        flushFile();
        currentPath = line.slice("+++ b/".length);
      } else if (line.startsWith("+++ /dev/null")) {
        flushFile();
      } else if (line.startsWith("+") && !line.startsWith("+++")) {
        currentLines.push(line.slice(1));
      }
    };

    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      const combined = leftover + chunk;
      const lines = combined.split("\n");
      leftover = lines.pop() ?? "";
      for (const line of lines) processLine(line);
    });
    child.stderr!.on("data", () => {
      // Intentionally discarded — see the doc comment: a git failure here
      // degrades to "no diff data for the affected commits", never thrown.
    });
    child.on("error", () => resolve(result));
    child.on("close", () => {
      if (leftover.length > 0) processLine(leftover);
      flushCommit();
      resolve(result);
    });
  });
}

export interface HeadTreeEntry {
  path: string;
  size: number;
}

// Distinct from EMPTY_REPO_PATTERN above: ls-tree/cat-file on an unborn
// HEAD (no commits yet) fails with "Not a valid object name HEAD" rather
// than git log's "does not have any commits yet" — same degenerate-repo
// case, different command family, different stderr text. Kept as its own
// pattern rather than folded into EMPTY_REPO_PATTERN so a future change to
// one doesn't silently affect the other's matching.
const EMPTY_REPO_TREE_PATTERN = /Not a valid object name HEAD|does not have any commits yet|bad default revision/;

// "<mode> SP <type> SP <sha40> SP<padding><size> TAB <path>" (NUL-terminated
// record, no trailing content) — ls-tree -l right-pads the size field to a
// fixed width, so splitting the metadata portion on runs of whitespace (not
// a single space) is required to isolate it.
function parseLsTreeRecord(record: string): HeadTreeEntry | null {
  const tab = record.indexOf("\t");
  if (tab === -1) return null;
  const meta = record.slice(0, tab).trim().split(/\s+/);
  if (meta.length < 4) return null;
  const [, type, , sizeRaw] = meta;
  if (type !== "blob") return null; // skip submodule gitlinks etc. — never file content
  const size = parseInt(sizeRaw, 10);
  if (Number.isNaN(size)) return null;
  return { path: record.slice(tab + 1), size };
}

/**
 * Every blob (file) reachable from HEAD's tree, recursively, with its size
 * in bytes — a single `git ls-tree -r -l -z HEAD` call rather than one
 * `git cat-file -s`/`git show` per file, so enumerating a repo with
 * thousands of files costs one process spawn, not thousands. `-l` puts the
 * blob size on the same line (no second round trip needed to decide which
 * files are even worth fetching); `-z` NUL-terminates records and disables
 * filename quoting, so paths with spaces/non-ASCII bytes come back verbatim
 * with no C-style escaping to undo (same class of problem
 * getCommitAddedLines' core.quotepath=off solves for diff output, solved
 * here by picking the flag that avoids quoting entirely instead).
 *
 * Streams stdout for the same reason as getAllCommits: a huge repo's
 * ls-tree output can exceed execFileSync's default maxBuffer, so this uses
 * `spawn` and parses records incrementally rather than buffering the whole
 * process output.
 *
 * Returns [] for a repo with no commits yet (unborn HEAD), matching
 * getAllCommits' empty-repo handling; any other failure rejects rather than
 * being silently treated as "no files".
 */
export function listHeadTreeBlobs(repoPath: string): Promise<HeadTreeEntry[]> {
  debugLog("git ls-tree -r -l -z HEAD (streaming)");
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["ls-tree", "-r", "-l", "-z", "HEAD"], {
      cwd: repoPath,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const entries: HeadTreeEntry[] = [];
    let buffer = "";
    let stderr = "";

    const consumeCompleteRecords = (final: boolean) => {
      for (;;) {
        const idx = buffer.indexOf("\0");
        if (idx === -1) {
          if (final && buffer.length > 0) {
            const entry = parseLsTreeRecord(buffer);
            if (entry) entries.push(entry);
            buffer = "";
          }
          return;
        }
        const record = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        const entry = parseLsTreeRecord(record);
        if (entry) entries.push(entry);
      }
    };

    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      buffer += chunk;
      consumeCompleteRecords(false);
    });
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code !== 0) {
        if (EMPTY_REPO_TREE_PATTERN.test(stderr)) {
          resolve([]);
        } else {
          reject(new Error(`git ls-tree failed (exit ${code}): ${stderr.trim() || "unknown error"}`));
        }
        return;
      }
      consumeCompleteRecords(true);
      resolve(entries);
    });
  });
}

/**
 * Batched form of HEAD blob content retrieval: fetches the content of MANY
 * paths, as they exist at HEAD, in a single `git cat-file --batch` process
 * instead of one process per file — same "subprocess spawn count is the
 * dominant cost at scale" rationale as getCommitsAddedLines. Callers
 * (proof-graph/snapshot.ts) chunk their path list themselves, mirroring
 * getCommitsAddedLines/skill-detect.ts's DIFF_BATCH_SIZE split, so at most
 * one batch's worth of file content is ever held in memory at once.
 *
 * `--batch` was chosen over N calls to `git show HEAD:path` (one process
 * per file — exactly the cost this exists to avoid) or one `git show`
 * given many `HEAD:path` args back to back (which does concatenate blob
 * contents with no separator, but relying on that to re-split the stream
 * would depend on undocumented `git show` behavior for a case it isn't
 * documented to support). `--batch`'s protocol instead self-describes each
 * object's exact byte length up front (`<sha> <type> <size>\n` followed by
 * exactly `<size>` content bytes), which is the documented, binary-safe way
 * to split a concatenated multi-file stream apart correctly. Paths are
 * written to the child's STDIN (one `HEAD:<path>` per line) rather than
 * passed as argv, which also sidesteps argv length limits for a large
 * batch and keeps individual paths out of this process's argv (and so out
 * of the `git argv` debug line the way `debugLog` here logs only a count —
 * see src/debug.ts's paste-safety note on why per-file paths never appear
 * in `--debug` output).
 *
 * Never throws: a git failure resolves with whatever was already parsed,
 * matching getCommitsAddedLines' fail-quiet-to-partial-data behavior — a
 * missing snapshot file is not a privacy problem, only a completeness one.
 */
export function readHeadBlobContents(repoPath: string, paths: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (paths.length === 0) return Promise.resolve(result);

  debugLog(`git cat-file --batch <${paths.length} paths> (batched content fetch)`);

  return new Promise((resolve) => {
    const child = spawn("git", ["cat-file", "--batch"], {
      cwd: repoPath,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let buffer = Buffer.alloc(0);
    let index = 0; // position in `paths` — cat-file --batch answers strictly in request order

    const tryParse = () => {
      for (;;) {
        const headerEnd = buffer.indexOf("\n");
        if (headerEnd === -1) return; // header not fully buffered yet
        const header = buffer.slice(0, headerEnd).toString("utf8");
        if (header.endsWith(" missing")) {
          // Shouldn't happen (paths come from a just-read HEAD tree), but
          // fail quiet rather than misalign the rest of the batch.
          buffer = buffer.slice(headerEnd + 1);
          index++;
          continue;
        }
        const parts = header.split(" ");
        if (parts.length < 3) return; // malformed/incomplete header, wait for more data
        const size = parseInt(parts[2], 10);
        if (Number.isNaN(size)) return;
        const contentStart = headerEnd + 1;
        const contentEnd = contentStart + size;
        if (buffer.length < contentEnd + 1) return; // content + trailing \n not fully buffered yet
        const path = paths[index];
        if (path !== undefined) {
          result.set(path, buffer.slice(contentStart, contentEnd).toString("utf8"));
        }
        buffer = buffer.slice(contentEnd + 1);
        index++;
      }
    };

    child.stdout!.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      tryParse();
    });
    child.stderr!.on("data", () => {
      // Intentionally discarded — same rationale as getCommitsAddedLines.
    });
    child.on("error", () => resolve(result));
    child.on("close", () => resolve(result));

    child.stdin!.write(paths.map((p) => `HEAD:${p}\n`).join(""));
    child.stdin!.end();
  });
}
