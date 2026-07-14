import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shallowRepoWarning } from "../src/shallow-repo.js";
import { executeScanCommand } from "../src/scan-command.js";
import { cleanup, commit, createRepo, createShallowClone } from "./support/fixtures.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) cleanup(dirs.pop()!);
});

function tempConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "redential-config-"));
  dirs.push(dir);
  return dir;
}

describe("shallowRepoWarning", () => {
  it("mentions the remedy and never claims the scan was blocked", () => {
    const warning = shallowRepoWarning();
    expect(warning).toContain("git fetch --unshallow");
    expect(warning).not.toMatch(/refus|block|abort/i);
  });
});

describe("scan continues after a shallow-clone warning (never blocks)", () => {
  it("prints the warning AND still produces a bundle for a shallow clone", async () => {
    const source = createRepo();
    dirs.push(source);
    commit(source, { message: "1", authorName: "You", authorEmail: "you@example.com", files: { "a.ts": "1\n" } });
    commit(source, { message: "2", authorName: "You", authorEmail: "you@example.com", files: { "a.ts": "2\n" } });
    const shallow = createShallowClone(source);
    dirs.push(shallow);
    const configDir = tempConfigDir();

    const logs: string[] = [];
    const warnings: string[] = [];
    await executeScanCommand({
      repoPath: shallow,
      author: ["you@example.com"],
      yes: true,
      toolVersion: "0.1.0",
      configDir,
      log: (message) => logs.push(message),
      warn: (message) => warnings.push(message),
    });

    expect(warnings.some((line) => line.includes("shallow clone"))).toBe(true);
    // Same channel separation as the public-host warning — stderr only,
    // never inside the JSON `scan | jq` reads.
    expect(logs.some((line) => line.includes("shallow clone"))).toBe(false);
    const bundle = JSON.parse(logs.find((line) => line.trim().startsWith("{"))!);
    expect(bundle.commits.user_total).toBe(1);
  });

  it("produces a bundle with no shallow warning for an ordinary full clone", async () => {
    const dir = createRepo();
    dirs.push(dir);
    commit(dir, { message: "x", authorName: "You", authorEmail: "you@example.com", files: { "a.ts": "1\n" } });
    const configDir = tempConfigDir();

    const warnings: string[] = [];
    await executeScanCommand({
      repoPath: dir,
      author: ["you@example.com"],
      yes: true,
      toolVersion: "0.1.0",
      configDir,
      log: () => {},
      warn: (message) => warnings.push(message),
    });

    expect(warnings).toEqual([]);
  });

  it("the wrapped summary (TTY) notes the shallow clone", async () => {
    const source = createRepo();
    dirs.push(source);
    commit(source, { message: "1", authorName: "You", authorEmail: "you@example.com", files: { "a.ts": "1\n" } });
    commit(source, { message: "2", authorName: "You", authorEmail: "you@example.com", files: { "a.ts": "2\n" } });
    const shallow = createShallowClone(source);
    dirs.push(shallow);
    const configDir = tempConfigDir();

    const logs: string[] = [];
    await executeScanCommand({
      repoPath: shallow,
      author: ["you@example.com"],
      yes: true,
      toolVersion: "0.1.0",
      configDir,
      log: (message) => logs.push(message),
      warn: () => {},
      isTTY: true,
    });

    // Phase 2: TTY default output is the summary alone (no JSON dump), so
    // it's the sole log entry.
    expect(logs[0]).toContain("shallow clone");
  });

  it("the wrapped summary has no shallow note for a full clone", async () => {
    const dir = createRepo();
    dirs.push(dir);
    commit(dir, { message: "x", authorName: "You", authorEmail: "you@example.com", files: { "a.ts": "1\n" } });
    const configDir = tempConfigDir();

    const logs: string[] = [];
    await executeScanCommand({
      repoPath: dir,
      author: ["you@example.com"],
      yes: true,
      toolVersion: "0.1.0",
      configDir,
      log: (message) => logs.push(message),
      warn: () => {},
      isTTY: true,
    });

    expect(logs[0]).not.toContain("shallow clone");
  });
});
