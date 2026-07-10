import { afterEach, describe, expect, it } from "vitest";
import { cleanup, commit, createRepo } from "./support/fixtures.js";
import { getAllCommits, getCommitAddedLines, getCommitsAddedLines, getCommitCount } from "../src/git.js";
import { extractImportedPackages } from "../src/import-detect.js";

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
