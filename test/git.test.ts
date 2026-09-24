import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanup, commit, createRepo, createShallowClone } from "./support/fixtures.js";
import {
  getAllCommits,
  getCommitAddedLines,
  getCommitsAddedLines,
  getCommitCount,
  getConfiguredUserEmail,
  isShallowRepository,
} from "../src/git.js";
import { extractImportedPackages } from "../src/import-detect.js";
import { ScanError } from "../src/errors.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) cleanup(dirs.pop()!);
});

describe("getCommitAddedLines — CRLF handling", () => {
  it("strips the trailing \\r from a CRLF-authored file's added lines", () => {
    const dir = createRepo();
    dirs.push(dir);
    const sha = commit(dir, {
      message: "x",
      authorName: "You",
      authorEmail: "you@example.com",
      files: { "a.ts": 'import Stripe from "stripe";\r\n\r\nconst s = new Stripe("key");\r\n' },
    });

    const files = getCommitAddedLines(dir, sha);
    expect(files).toHaveLength(1);
    expect(files[0].addedLines).not.toContain("\r");
  });

  it("still detects an import from a CRLF-line-ended diff, end to end", () => {
    const dir = createRepo();
    dirs.push(dir);
    const sha = commit(dir, {
      message: "x",
      authorName: "You",
      authorEmail: "you@example.com",
      files: { "a.ts": 'import Stripe from "stripe";\r\n' },
    });

    const [file] = getCommitAddedLines(dir, sha);
    expect(extractImportedPackages(file.addedLines, file.path)).toEqual(["stripe"]);
  });
});

describe("getCommitsAddedLines — batched fetch", () => {
  it("attributes each commit's added lines to the correct sha, not the previous/next commit in the batch", async () => {
    const dir = createRepo();
    dirs.push(dir);
    const sha1 = commit(dir, {
      message: "1",
      authorName: "You",
      authorEmail: "you@example.com",
      files: { "a.ts": 'import Stripe from "stripe";\n' },
    });
    const sha2 = commit(dir, {
      message: "2",
      authorName: "You",
      authorEmail: "you@example.com",
      files: { "b.ts": 'import * as Sentry from "@sentry/node";\n' },
    });
    const sha3 = commit(dir, {
      message: "3",
      authorName: "You",
      authorEmail: "you@example.com",
      files: { "c.ts": "export const x = 1;\n" },
    });

    const result = await getCommitsAddedLines(dir, [sha1, sha2, sha3]);

    expect(result.get(sha1)).toEqual([{ path: "a.ts", addedLines: 'import Stripe from "stripe";' }]);
    expect(result.get(sha2)).toEqual([
      { path: "b.ts", addedLines: 'import * as Sentry from "@sentry/node";' },
    ]);
    expect(result.get(sha3)).toEqual([{ path: "c.ts", addedLines: "export const x = 1;" }]);
    // Each sha's own key holds ONLY its own file's lines — the exact bug
    // class this test exists to catch is a record-boundary parsing error
    // that misattributes one commit's diff content to a neighboring sha
    // (or, worse, corrupts the sha key itself so lookups miss entirely —
    // this happened once during development: a stray leading control byte
    // ended up part of the parsed sha).
    for (const [sha, files] of result) {
      expect(sha).toMatch(/^[0-9a-f]{40}$/);
      for (const file of files) {
        if (file.path === "a.ts") {
          expect(file.addedLines).toContain("Stripe");
        } else {
          expect(file.addedLines).not.toContain("Stripe from");
        }
      }
    }
  });

  it("matches getAllCommits' own sha format exactly, so lookups by sha succeed", async () => {
    const dir = createRepo();
    dirs.push(dir);
    commit(dir, {
      message: "x",
      authorName: "You",
      authorEmail: "you@example.com",
      files: { "a.ts": 'import Stripe from "stripe";\n' },
    });

    const [rawCommit] = await getAllCommits(dir);
    const result = await getCommitsAddedLines(dir, [rawCommit.sha]);

    expect(result.has(rawCommit.sha)).toBe(true);
  });

  it("returns an empty map without spawning git when given no shas", async () => {
    const dir = createRepo();
    dirs.push(dir);
    const result = await getCommitsAddedLines(dir, []);
    expect(result.size).toBe(0);
  });
});

describe("getAllCommits — since window and progress", () => {
  it("since limits the walk and getCommitCount agrees with the resulting length", async () => {
    const dir = createRepo();
    dirs.push(dir);
    commit(dir, {
      message: "old",
      authorName: "You",
      authorEmail: "you@example.com",
      files: { "a.ts": "1\n" },
      authorDate: "2020-01-01T00:00:00Z",
    });
    commit(dir, {
      message: "new",
      authorName: "You",
      authorEmail: "you@example.com",
      files: { "b.ts": "2\n" },
      authorDate: "2025-01-01T00:00:00Z",
    });

    const since = new Date("2024-01-01T00:00:00Z");
    const windowed = await getAllCommits(dir, { since });
    expect(windowed).toHaveLength(1);
    expect(windowed[0].sha).toMatch(/^[0-9a-f]{40}$/);
    expect(getCommitCount(dir, since)).toBe(1);
    expect(getCommitCount(dir)).toBe(2);
  });

  it("reports progress once per commit, ending at the total commit count", async () => {
    const dir = createRepo();
    dirs.push(dir);
    for (let i = 0; i < 5; i++) {
      commit(dir, {
        message: `c${i}`,
        authorName: "You",
        authorEmail: "you@example.com",
        files: { [`f${i}.ts`]: `${i}\n` },
      });
    }

    const progressCounts: number[] = [];
    const commits = await getAllCommits(dir, { onProgress: (count) => progressCounts.push(count) });

    expect(commits).toHaveLength(5);
    expect(progressCounts).toEqual([1, 2, 3, 4, 5]);
  });

  it("resolves to [] for a genuinely empty repo, without throwing", async () => {
    const dir = createRepo();
    dirs.push(dir);
    await expect(getAllCommits(dir)).resolves.toEqual([]);
  });
});

describe("getAllCommits — authorEmails (git-level filter optimization)", () => {
  it("with one authorEmail, returns only that author's commits (two authors present)", async () => {
    const dir = createRepo();
    dirs.push(dir);
    commit(dir, {
      message: "by you",
      authorName: "You",
      authorEmail: "you@example.com",
      files: { "a.ts": "1\n" },
    });
    commit(dir, {
      message: "by someone else",
      authorName: "Someone",
      authorEmail: "someone@example.com",
      files: { "b.ts": "2\n" },
    });

    const filtered = await getAllCommits(dir, { authorEmails: ["you@example.com"] });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].email).toBe("you@example.com");
  });

  it("a regex-metacharacter email (the '+' in a plus-tag address) still matches correctly", async () => {
    const dir = createRepo();
    dirs.push(dir);
    commit(dir, {
      message: "plus-tag commit",
      authorName: "You",
      authorEmail: "user+tag@example.com",
      files: { "a.ts": "1\n" },
    });
    commit(dir, {
      message: "unrelated commit",
      authorName: "Someone",
      authorEmail: "someone@example.com",
      files: { "b.ts": "2\n" },
    });

    const filtered = await getAllCommits(dir, { authorEmails: ["user+tag@example.com"] });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].email).toBe("user+tag@example.com");
  });

  // Regression: `git log --author`'s pattern language is governed by
  // `grep.patternType`, which defaults to "basic" but is user/repo
  // configurable — escapeRegexForGitAuthor's escaping is written
  // specifically for BASIC regex semantics (see git.ts's own comment), and
  // is silently WRONG under "extended" (a bare `+` in the escaped pattern
  // stops being a literal character once the pattern is read as ERE
  // instead of BRE). Without pinning `--basic-regexp` on the command line,
  // a repo/user with `grep.patternType=extended` set locally would
  // silently UNDERMATCH — the exact failure mode this test reproduces by
  // setting that config directly on the fixture repo, not by simulating it.
  it("still matches a plus-tag email even when the repo's own grep.patternType is set to 'extended'", async () => {
    const dir = createRepo();
    dirs.push(dir);
    execFileSync("git", ["config", "grep.patternType", "extended"], { cwd: dir });
    commit(dir, {
      message: "plus-tag commit under extended grep.patternType",
      authorName: "You",
      authorEmail: "user+tag@example.com",
      files: { "a.ts": "1\n" },
    });

    const filtered = await getAllCommits(dir, { authorEmails: ["user+tag@example.com"] });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].email).toBe("user+tag@example.com");
  });

  it("multiple emails OR together — commits from any of them are returned", async () => {
    const dir = createRepo();
    dirs.push(dir);
    commit(dir, {
      message: "by alice",
      authorName: "Alice",
      authorEmail: "alice@example.com",
      files: { "a.ts": "1\n" },
    });
    commit(dir, {
      message: "by bob",
      authorName: "Bob",
      authorEmail: "bob@example.com",
      files: { "b.ts": "2\n" },
    });
    commit(dir, {
      message: "by carol",
      authorName: "Carol",
      authorEmail: "carol@example.com",
      files: { "c.ts": "3\n" },
    });

    const filtered = await getAllCommits(dir, { authorEmails: ["alice@example.com", "bob@example.com"] });
    expect(filtered.map((c) => c.email).sort()).toEqual(["alice@example.com", "bob@example.com"]);
  });

  it("undefined/omitted authorEmails walks unfiltered, matching every existing caller's behavior", async () => {
    const dir = createRepo();
    dirs.push(dir);
    commit(dir, {
      message: "by you",
      authorName: "You",
      authorEmail: "you@example.com",
      files: { "a.ts": "1\n" },
    });
    commit(dir, {
      message: "by someone else",
      authorName: "Someone",
      authorEmail: "someone@example.com",
      files: { "b.ts": "2\n" },
    });

    const all = await getAllCommits(dir);
    expect(all).toHaveLength(2);
  });
});

describe("getAllCommits — committer date", () => {
  it("defaults committerDate to authorDate when the commit was never rewritten", async () => {
    const dir = createRepo();
    dirs.push(dir);
    commit(dir, {
      message: "x",
      authorName: "You",
      authorEmail: "you@example.com",
      files: { "a.ts": "1\n" },
      authorDate: "2024-01-01T00:00:00Z",
    });

    const [c] = await getAllCommits(dir);
    expect(c.authorDate.toISOString()).toBe("2024-01-01T00:00:00.000Z");
    expect(c.committerDate.toISOString()).toBe("2024-01-01T00:00:00.000Z");
  });

  it("reads committerDate independently from authorDate when the fixture sets them separately", async () => {
    const dir = createRepo();
    dirs.push(dir);
    commit(dir, {
      message: "x",
      authorName: "You",
      authorEmail: "you@example.com",
      files: { "a.ts": "1\n" },
      authorDate: "2021-03-15T00:00:00Z",
      committerDate: "2026-07-10T10:00:00Z",
    });

    const [c] = await getAllCommits(dir);
    expect(c.authorDate.toISOString()).toBe("2021-03-15T00:00:00.000Z");
    expect(c.committerDate.toISOString()).toBe("2026-07-10T10:00:00.000Z");
  });
});

describe("isShallowRepository", () => {
  it("is false for an ordinary full clone", () => {
    const dir = createRepo();
    dirs.push(dir);
    commit(dir, { message: "x", authorName: "You", authorEmail: "you@example.com", files: { "a.ts": "1\n" } });
    expect(isShallowRepository(dir)).toBe(false);
  });

  it("is true for a --depth 1 shallow clone", () => {
    const source = createRepo();
    dirs.push(source);
    commit(source, { message: "1", authorName: "You", authorEmail: "you@example.com", files: { "a.ts": "1\n" } });
    commit(source, { message: "2", authorName: "You", authorEmail: "you@example.com", files: { "a.ts": "2\n" } });

    const shallow = createShallowClone(source);
    dirs.push(shallow);
    expect(isShallowRepository(shallow)).toBe(true);
    // Sanity check the fixture actually IS shallow, independent of the
    // function under test — only 1 of the 2 source commits is present.
    expect(execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: shallow, encoding: "utf8" }).trim()).toBe(
      "1"
    );
  });

  it("fails open (false) rather than throwing when the path isn't a git repo at all", () => {
    const dir = mkdtempSync(join(tmpdir(), "redential-not-a-repo-"));
    dirs.push(dir);
    expect(isShallowRepository(dir)).toBe(false);
  });
});

describe("getConfiguredUserEmail", () => {
  it("reads the repo-local git config user.email", () => {
    const dir = createRepo();
    dirs.push(dir);
    execFileSync("git", ["config", "user.email", "configured@example.com"], { cwd: dir });
    expect(getConfiguredUserEmail(dir)).toBe("configured@example.com");
  });

  it("returns whatever is configured even when it doesn't match any commit author (build-bundle.ts's job to compare, not this)", () => {
    const dir = createRepo();
    dirs.push(dir);
    execFileSync("git", ["config", "user.email", "nobody-else@example.com"], { cwd: dir });
    expect(getConfiguredUserEmail(dir)).toBe("nobody-else@example.com");
  });
});

describe("getAllCommits — git subprocess errors", () => {
  it("rejects with a closed message when git log fails for a reason other than an empty repo", async () => {
    const dir = createRepo();
    dirs.push(dir);
    commit(dir, {
      message: "seed",
      authorName: "A",
      authorEmail: "a@example.com",
      files: { "a.txt": "x" },
    });
    const objectsDir = join(dir, ".git", "objects");
    for (const hex of readdirSync(objectsDir)) {
      if (hex === "info") continue;
      rmSync(join(objectsDir, hex), { recursive: true, force: true });
    }

    await expect(getAllCommits(dir)).rejects.toThrow(ScanError);
    await expect(getAllCommits(dir)).rejects.toThrow(/git log failed \(exit/);
    try {
      await getAllCommits(dir);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ScanError);
      expect((err as Error).message).not.toContain("fatal:");
      expect((err as Error).message).not.toContain("bad object");
    }
  });
});

describe("getAllCommits — non-git directory", () => {
  it("rejects with a ScanError carrying a clean, actionable message instead of a raw git-log Error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "redential-not-a-repo-"));
    dirs.push(dir);

    await expect(getAllCommits(dir)).rejects.toThrow(ScanError);
    await expect(getAllCommits(dir)).rejects.toThrow(`Not a git repository: ${dir}`);

    // The message must stay a single actionable line — no leaked raw git
    // stderr text ("fatal: ...") and no stack-trace-shaped content.
    try {
      await getAllCommits(dir);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ScanError);
      expect((err as Error).message).not.toContain("fatal:");
      expect((err as Error).message).toContain("--repo <path-to-repo>");
    }
  });
});
