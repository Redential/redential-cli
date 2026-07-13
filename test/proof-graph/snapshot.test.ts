import { afterEach, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, commit, createRepo } from "../support/fixtures.js";
import { readHeadSnapshot } from "../../src/proof-graph/snapshot.js";

const dirs: string[] = [];
function repo(): string {
  const dir = createRepo();
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length > 0) cleanup(dirs.pop()!);
});

describe("readHeadSnapshot", () => {
  it("returns only .ts/.tsx files, excluding .d.ts declaration files", async () => {
    const dir = repo();
    commit(dir, {
      message: "x",
      authorName: "You",
      authorEmail: "you@example.com",
      files: {
        "src/a.ts": "export const a = 1;\n",
        "src/b.tsx": "export const B = () => null;\n",
        "src/types.d.ts": "export type X = string;\n",
        "README.md": "# hello\n",
        "package.json": "{}\n",
      },
    });

    const files = await readHeadSnapshot(dir);

    expect(files.map((f) => f.path)).toEqual(["src/a.ts", "src/b.tsx"]);
  });

  it("excludes churn-excluded paths (dist/, node_modules/)", async () => {
    const dir = repo();
    commit(dir, {
      message: "x",
      authorName: "You",
      authorEmail: "you@example.com",
      files: {
        "src/kept.ts": "export const kept = true;\n",
        "dist/foo.ts": "export const generated = true;\n",
        "node_modules/x/y.ts": "export const vendored = true;\n",
      },
    });

    const files = await readHeadSnapshot(dir);

    expect(files.map((f) => f.path)).toEqual(["src/kept.ts"]);
  });

  it("excludes a file over the size cap, keeping files under it", async () => {
    const dir = repo();
    const small = "export const small = 1;\n"; // well under the cap
    const big = "x".repeat(50); // deliberately over a tiny cap set below
    commit(dir, {
      message: "x",
      authorName: "You",
      authorEmail: "you@example.com",
      files: {
        "src/small.ts": small,
        "src/big.ts": big,
      },
    });

    const files = await readHeadSnapshot(dir, { maxFileBytes: 30 });

    expect(files.map((f) => f.path)).toEqual(["src/small.ts"]);
  });

  it("truncates to maxFiles deterministically (lexicographically first paths survive)", async () => {
    const dir = repo();
    commit(dir, {
      message: "x",
      authorName: "You",
      authorEmail: "you@example.com",
      files: {
        "src/c.ts": "export const c = 1;\n",
        "src/a.ts": "export const a = 1;\n",
        "src/b.ts": "export const b = 1;\n",
      },
    });

    const files = await readHeadSnapshot(dir, { maxFiles: 2 });

    expect(files.map((f) => f.path)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("returns COMMITTED content, not uncommitted working-tree edits", async () => {
    const dir = repo();
    commit(dir, {
      message: "x",
      authorName: "You",
      authorEmail: "you@example.com",
      files: { "src/a.ts": "export const a = 1;\n" },
    });

    // Modify the file on disk WITHOUT committing.
    writeFileSync(join(dir, "src/a.ts"), "export const a = 999; // uncommitted\n");

    const files = await readHeadSnapshot(dir);

    expect(files).toEqual([{ path: "src/a.ts", content: "export const a = 1;\n" }]);
  });

  it("returns [] for a repo with no commits", async () => {
    const dir = repo();

    const files = await readHeadSnapshot(dir);

    expect(files).toEqual([]);
  });
});
