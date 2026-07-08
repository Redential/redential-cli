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
      `--format=${RECORD_SEP}%H${FIELD_SEP}%ae${FIELD_SEP}%aI${FIELD_SEP}%G?`,
    ]);
  } catch {
    return [];
  }

  return out
    .split(RECORD_SEP)
    .filter((chunk) => chunk.trim().length > 0)
    .map((chunk) => {
      const lines = chunk.split("\n");
      const [sha, email, authorDateIso, signatureStatus] = lines[0].split(FIELD_SEP);
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
      };
    });
}

/** First line of `rev-list --max-parents=0`; multi-root histories are out of scope. */
export function getRootCommitSha(repoPath: string): string {
  return git(repoPath, ["rev-list", "--max-parents=0", "HEAD"]).trim().split("\n")[0];
}

export function getRemoteHostType(repoPath: string): RepoInfo["host_type"] {
  let url: string;
  try {
    url = git(repoPath, ["remote", "get-url", "origin"]).trim();
  } catch {
    return "none";
  }
  if (/github\.com/.test(url)) return "github";
  if (/gitlab\.com/.test(url)) return "gitlab";
  if (/bitbucket\.org/.test(url)) return "bitbucket";
  return "other";
}
