import { execFileSync } from "node:child_process";
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
  signed: boolean;
  churn: FileChurn[];
  // 2+ parents. `--numstat` already emits no per-file churn for merges (so
  // they contribute nothing to language/category shares); skill detection
  // mirrors that and skips them too, rather than reading a combined diff.
  isMerge: boolean;
}

function git(repoPath: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repoPath,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

const RECORD_SEP = "\x01";
const FIELD_SEP = "\x02";

/**
 * All commits reachable from HEAD, oldest first. Returns [] for a repo with
 * no commits yet, rather than throwing.
 */
export function getAllCommits(repoPath: string): RawCommit[] {
  let out: string;
  try {
    out = git(repoPath, [
      "log",
      "--reverse",
      "--numstat",
      `--format=${RECORD_SEP}%H${FIELD_SEP}%ae${FIELD_SEP}%aI${FIELD_SEP}%G?${FIELD_SEP}%P`,
    ]);
  } catch {
    return [];
  }

  return out
    .split(RECORD_SEP)
    .filter((chunk) => chunk.trim().length > 0)
    .map((chunk) => {
      const lines = chunk.split("\n");
      const [sha, email, authorDateIso, signatureStatus, parents] = lines[0].split(FIELD_SEP);
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
        // Only a fully verified good signature ("G") counts as signed. "U"
        // (good but untrusted/unmatched key), "B" (bad), "X"/"Y"/"R"
        // (expired/expired-key/revoked-key) and "E" (can't check) all mean
        // the signature doesn't actually establish anything — see
        // docs/schema.md's `signed` section for why.
        signed: signatureStatus === "G",
        churn,
        isMerge: parents.trim().split(/\s+/).filter(Boolean).length > 1,
      };
    });
}

/** First line of `rev-list --max-parents=0`; multi-root histories are out of scope. */
export function getRootCommitSha(repoPath: string): string {
  return git(repoPath, ["rev-list", "--max-parents=0", "HEAD"]).trim().split("\n")[0];
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
