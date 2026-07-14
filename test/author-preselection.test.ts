import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBundleInteractively } from "../src/build-bundle.js";
import { cleanup, commit, createRepo } from "./support/fixtures.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) cleanup(dirs.pop()!);
});

function tempConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "redential-config-"));
  dirs.push(dir);
  return dir;
}

function repoWithTwoAuthors(): string {
  const dir = createRepo();
  dirs.push(dir);
  commit(dir, { message: "a1", authorName: "Alice", authorEmail: "alice@example.com", files: { "a.ts": "1\n" } });
  commit(dir, { message: "a2", authorName: "Alice", authorEmail: "alice@example.com", files: { "a.ts": "2\n" } });
  commit(dir, { message: "b1", authorName: "Bob", authorEmail: "bob@example.com", files: { "b.ts": "1\n" } });
  return dir;
}

describe("author pre-selection from git config user.email", () => {
  it("2+ candidates, git identity matches one, accepted: skips the full list entirely", async () => {
    const dir = repoWithTwoAuthors();
    execFileSync("git", ["config", "user.email", "alice@example.com"], { cwd: dir });

    let gitIdentityPrompted: string | undefined;
    let listPrompted = false;
    const bundle = await buildBundleInteractively({
      repoPath: dir,
      author: [],
      yes: true,
      toolVersion: "0.1.0",
      configDir: tempConfigDir(),
      warn: () => {},
      promptUseGitIdentityFn: async (candidate) => {
        gitIdentityPrompted = candidate.email;
        return true;
      },
      promptAuthorsFn: async () => {
        listPrompted = true;
        return [];
      },
    });

    expect(gitIdentityPrompted).toBe("alice@example.com");
    expect(listPrompted).toBe(false);
    // buildBundleInteractively now returns Bundle | null (console-UX milestone:
    // null only on a declined connectable-repo TTY prompt, never hit here
    // since isTTY isn't set) — non-null assert to keep this test unchanged.
    expect(bundle!.commits.user_total).toBe(2);
  });

  it("2+ candidates, git identity matches one, DECLINED: falls through to the full unmodified list", async () => {
    const dir = repoWithTwoAuthors();
    execFileSync("git", ["config", "user.email", "alice@example.com"], { cwd: dir });

    let listPromptedWith: string[] = [];
    const bundle = await buildBundleInteractively({
      repoPath: dir,
      author: [],
      yes: true,
      toolVersion: "0.1.0",
      configDir: tempConfigDir(),
      warn: () => {},
      promptUseGitIdentityFn: async () => false,
      promptAuthorsFn: async (candidates) => {
        listPromptedWith = candidates.map((c) => c.email);
        return ["alice@example.com", "bob@example.com"]; // multi-identity user picks both
      },
    });

    // The matched entry is NOT removed from the list shown on decline.
    expect(listPromptedWith.sort()).toEqual(["alice@example.com", "bob@example.com"]);
    expect(bundle!.commits.user_total).toBe(3);
  });

  it("no git identity configured: falls through to the full list, never prompting for git-identity use", async () => {
    const dir = repoWithTwoAuthors();
    // No `git config user.email` set at all in this fixture repo.

    let gitIdentityPromptCalled = false;
    let listPromptedWith: string[] = [];
    await buildBundleInteractively({
      repoPath: dir,
      author: [],
      yes: true,
      toolVersion: "0.1.0",
      configDir: tempConfigDir(),
      warn: () => {},
      promptUseGitIdentityFn: async () => {
        gitIdentityPromptCalled = true;
        return true;
      },
      promptAuthorsFn: async (candidates) => {
        listPromptedWith = candidates.map((c) => c.email);
        return ["alice@example.com"];
      },
    });

    expect(gitIdentityPromptCalled).toBe(false);
    expect(listPromptedWith.sort()).toEqual(["alice@example.com", "bob@example.com"]);
  });

  it("git identity configured but matches NO candidate: falls through to the full list unchanged", async () => {
    const dir = repoWithTwoAuthors();
    execFileSync("git", ["config", "user.email", "someone-else@example.com"], { cwd: dir });

    let gitIdentityPromptCalled = false;
    let listPromptedWith: string[] = [];
    await buildBundleInteractively({
      repoPath: dir,
      author: [],
      yes: true,
      toolVersion: "0.1.0",
      configDir: tempConfigDir(),
      warn: () => {},
      promptUseGitIdentityFn: async () => {
        gitIdentityPromptCalled = true;
        return true;
      },
      promptAuthorsFn: async (candidates) => {
        listPromptedWith = candidates.map((c) => c.email);
        return ["bob@example.com"];
      },
    });

    expect(gitIdentityPromptCalled).toBe(false);
    expect(listPromptedWith.sort()).toEqual(["alice@example.com", "bob@example.com"]);
  });

  it("SINGLE candidate matching git identity: skips the pre-selection prompt (promptAuthors' own Y/n handles it, not asked twice)", async () => {
    const dir = createRepo();
    dirs.push(dir);
    commit(dir, { message: "x", authorName: "Alice", authorEmail: "alice@example.com", files: { "a.ts": "1\n" } });
    execFileSync("git", ["config", "user.email", "alice@example.com"], { cwd: dir });

    let gitIdentityPromptCalled = false;
    let listPromptCalled = false;
    await buildBundleInteractively({
      repoPath: dir,
      author: [],
      yes: true,
      toolVersion: "0.1.0",
      configDir: tempConfigDir(),
      warn: () => {},
      promptUseGitIdentityFn: async () => {
        gitIdentityPromptCalled = true;
        return true;
      },
      promptAuthorsFn: async () => {
        listPromptCalled = true;
        return ["alice@example.com"];
      },
    });

    expect(gitIdentityPromptCalled).toBe(false);
    expect(listPromptCalled).toBe(true);
  });

  it("--author flag set: pre-selection never runs at all (existing behavior unchanged)", async () => {
    const dir = repoWithTwoAuthors();
    execFileSync("git", ["config", "user.email", "alice@example.com"], { cwd: dir });

    let gitIdentityPromptCalled = false;
    const bundle = await buildBundleInteractively({
      repoPath: dir,
      author: ["bob@example.com"],
      yes: true,
      toolVersion: "0.1.0",
      configDir: tempConfigDir(),
      warn: () => {},
      promptUseGitIdentityFn: async () => {
        gitIdentityPromptCalled = true;
        return true;
      },
    });

    expect(gitIdentityPromptCalled).toBe(false);
    expect(bundle!.commits.user_total).toBe(1);
  });
});
