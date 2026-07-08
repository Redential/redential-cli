import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanup,
  commit,
  createRepo,
  setupSshSigning,
  setupSshSigningWithMismatchedTrust,
} from "./support/fixtures.js";
import { validateAgainstSchema } from "./support/schema-validate.js";
import { runScan, ScanError, listAuthors } from "../src/scan.js";

const schema = JSON.parse(
  readFileSync(new URL("../schema/bundle.v1.json", import.meta.url), "utf8")
);

const dirs: string[] = [];
function repo(): string {
  const dir = createRepo();
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length > 0) cleanup(dirs.pop()!);
});

// Isolate the device salt from the developer's real ~/.config/redential.
function tempConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "redential-config-"));
  dirs.push(dir);
  return dir;
}

describe("runScan", () => {
  it("computes ownership and identity across multiple author identities", () => {
    const dir = repo();
    const configDir = tempConfigDir();
    commit(dir, {
      message: "a1",
      authorName: "Alice",
      authorEmail: "alice@example.com",
      files: { "src/index.ts": "console.log(1)\n" },
    });
    commit(dir, {
      message: "a2",
      authorName: "Alice",
      authorEmail: "alice@example.com",
      files: { "src/index.ts": "console.log(1)\nconsole.log(2)\n" },
    });
    commit(dir, {
      message: "b1",
      authorName: "Bob",
      authorEmail: "bob@example.com",
      files: { "src/other.ts": "console.log(3)\n" },
    });

    const bundle = runScan({
      repoPath: dir,
      authors: ["alice@example.com"],
      confirmed: true,
      toolVersion: "0.1.0",
      configDir,
    });

    expect(bundle.commits.user_total).toBe(2);
    expect(bundle.identity.other_contributors_count).toBe(1);
    expect(bundle.ownership.user_commit_ratio).toBeCloseTo(2 / 3);
    expect(bundle.identity.author_identity_hashes).toHaveLength(1);
    expect(bundle.identity.author_identity_hashes[0]).toMatch(/^[0-9a-f]{64}$/);

    const json = JSON.stringify(bundle);
    expect(json).not.toContain("alice@example.com");
    expect(json).not.toContain("bob@example.com");

    expect(validateAgainstSchema(schema, bundle)).toEqual([]);
  });

  it("counts signed vs unsigned commits", () => {
    const dir = repo();
    const configDir = tempConfigDir();
    setupSshSigning(dir, "carol@example.com");
    commit(dir, {
      message: "signed",
      authorName: "Carol",
      authorEmail: "carol@example.com",
      files: { "a.ts": "1\n" },
      sign: true,
    });
    commit(dir, {
      message: "unsigned",
      authorName: "Carol",
      authorEmail: "carol@example.com",
      files: { "a.ts": "1\n2\n" },
      sign: false,
    });

    const bundle = runScan({
      repoPath: dir,
      authors: ["carol@example.com"],
      confirmed: true,
      toolVersion: "0.1.0",
      configDir,
    });

    expect(bundle.signed.count).toBe(1);
    expect(bundle.signed.ratio).toBeCloseTo(0.5);
    expect(validateAgainstSchema(schema, bundle)).toEqual([]);
  });

  it("does not count a signature that can't be verified (mismatched key) as signed", () => {
    const dir = repo();
    const configDir = tempConfigDir();
    setupSshSigningWithMismatchedTrust(dir, "dana@example.com");
    commit(dir, {
      message: "signed but unverifiable",
      authorName: "Dana",
      authorEmail: "dana@example.com",
      files: { "a.ts": "1\n" },
      sign: true,
    });

    const bundle = runScan({
      repoPath: dir,
      authors: ["dana@example.com"],
      confirmed: true,
      toolVersion: "0.1.0",
      configDir,
    });

    expect(bundle.signed.count).toBe(0);
    expect(bundle.signed.ratio).toBe(0);
    expect(validateAgainstSchema(schema, bundle)).toEqual([]);
  });

  it("rejects an empty repository", () => {
    const dir = repo();
    const configDir = tempConfigDir();
    expect(() =>
      runScan({
        repoPath: dir,
        authors: ["nobody@example.com"],
        confirmed: true,
        toolVersion: "0.1.0",
        configDir,
      })
    ).toThrow(ScanError);
    expect(listAuthors(dir)).toEqual([]);
  });

  it("handles a repo with a single commit", () => {
    const dir = repo();
    const configDir = tempConfigDir();
    commit(dir, {
      message: "only",
      authorName: "Dana",
      authorEmail: "dana@example.com",
      files: { "README.md": "hello\n" },
    });

    const bundle = runScan({
      repoPath: dir,
      authors: ["dana@example.com"],
      confirmed: true,
      toolVersion: "0.1.0",
      configDir,
    });

    expect(bundle.commits.user_total).toBe(1);
    expect(bundle.commits.span_days).toBe(0);
    expect(bundle.commits.first_at).toBe(bundle.commits.last_at);
    expect(bundle.ownership.user_commit_ratio).toBe(1);
    expect(bundle.identity.other_contributors_count).toBe(0);
    expect(validateAgainstSchema(schema, bundle)).toEqual([]);
  });

  it("requires explicit confirmation before producing a bundle", () => {
    const dir = repo();
    const configDir = tempConfigDir();
    commit(dir, {
      message: "x",
      authorName: "Eve",
      authorEmail: "eve@example.com",
      files: { "a.ts": "1\n" },
    });
    expect(() =>
      runScan({
        repoPath: dir,
        authors: ["eve@example.com"],
        confirmed: false,
        toolVersion: "0.1.0",
        configDir,
      })
    ).toThrow(ScanError);
  });

  it("requires at least one selected author", () => {
    const dir = repo();
    const configDir = tempConfigDir();
    commit(dir, {
      message: "x",
      authorName: "Frank",
      authorEmail: "frank@example.com",
      files: { "a.ts": "1\n" },
    });
    expect(() =>
      runScan({ repoPath: dir, authors: [], confirmed: true, toolVersion: "0.1.0", configDir })
    ).toThrow(ScanError);
  });
});
