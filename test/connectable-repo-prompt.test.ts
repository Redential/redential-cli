import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBundleInteractively } from "../src/build-bundle.js";
import { executeScanCommand } from "../src/scan-command.js";
import { executeSubmitCommand } from "../src/submit-command.js";
import { saveCredentials } from "../src/credentials.js";
import { cleanup, commit, createRepo, setRemote } from "./support/fixtures.js";
import { startMockServer, type MockServer } from "./support/mock-server.js";

/**
 * Console-UX milestone (2026-07): the connectable-repo notice
 * (public-remote.ts's publicHostWarning) is now followed, in a real TTY
 * only, by an interactive "Continue locally? (Y/n)" confirmation
 * (prompt.ts's promptContinueLocally). Non-TTY/piped mode keeps the
 * pre-existing non-blocking behavior exactly: warn and continue, no
 * prompt, never a `null` bundle. See build-bundle.ts's own comments.
 */

const dirs: string[] = [];
const servers: MockServer[] = [];
afterEach(async () => {
  while (dirs.length > 0) cleanup(dirs.pop()!);
  while (servers.length > 0) await servers.pop()!.close();
});

function tempConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "redential-config-"));
  dirs.push(dir);
  return dir;
}

function connectableRepo(): string {
  const dir = createRepo();
  dirs.push(dir);
  setRemote(dir, "https://github.com/acme/example.git");
  commit(dir, {
    message: "x",
    authorName: "You",
    authorEmail: "you@example.com",
    files: { "a.ts": "1\n" },
  });
  return dir;
}

describe("buildBundleInteractively — connectable-repo notice + TTY-only prompt", () => {
  it("non-TTY: warns but never asks — promptContinueLocallyFn is never invoked, and a bundle is always returned", async () => {
    const dir = connectableRepo();
    const warnings: string[] = [];
    let promptCalled = false;

    const bundle = await buildBundleInteractively({
      repoPath: dir,
      author: ["you@example.com"],
      yes: true,
      toolVersion: "0.1.0",
      configDir: tempConfigDir(),
      warn: (m) => warnings.push(m),
      promptContinueLocallyFn: async () => {
        promptCalled = true;
        return true;
      },
      // isTTY omitted — same as a piped/non-interactive run.
    });

    expect(promptCalled).toBe(false);
    expect(warnings.some((w) => w.includes("This repo appears connectable through GitHub."))).toBe(true);
    expect(bundle).not.toBeNull();
    expect(bundle!.commits.user_total).toBe(1);
  });

  it("TTY, user accepts (Y): asks, then still returns a bundle", async () => {
    const dir = connectableRepo();
    const warnings: string[] = [];
    let promptCalled = false;

    const bundle = await buildBundleInteractively({
      repoPath: dir,
      author: ["you@example.com"],
      yes: true,
      toolVersion: "0.1.0",
      configDir: tempConfigDir(),
      warn: (m) => warnings.push(m),
      isTTY: true,
      promptContinueLocallyFn: async () => {
        promptCalled = true;
        return true;
      },
    });

    expect(promptCalled).toBe(true);
    expect(bundle).not.toBeNull();
    expect(bundle!.commits.user_total).toBe(1);
  });

  it("TTY, user declines (n): returns null, nothing scanned, and prints a brief GitHub App suggestion", async () => {
    const dir = connectableRepo();
    const warnings: string[] = [];

    const bundle = await buildBundleInteractively({
      repoPath: dir,
      author: ["you@example.com"],
      yes: true,
      toolVersion: "0.1.0",
      configDir: tempConfigDir(),
      warn: (m) => warnings.push(m),
      isTTY: true,
      promptContinueLocallyFn: async () => false,
    });

    expect(bundle).toBeNull();
    expect(warnings.some((w) => w.includes("GitHub App"))).toBe(true);
  });

  it("a non-connectable (self-hosted) remote never triggers the prompt, even in a TTY", async () => {
    const dir = createRepo();
    dirs.push(dir);
    setRemote(dir, "https://git.internal.acme-corp.example/team/repo.git");
    commit(dir, {
      message: "x",
      authorName: "You",
      authorEmail: "you@example.com",
      files: { "a.ts": "1\n" },
    });

    let promptCalled = false;
    const bundle = await buildBundleInteractively({
      repoPath: dir,
      author: ["you@example.com"],
      yes: true,
      toolVersion: "0.1.0",
      configDir: tempConfigDir(),
      warn: () => {},
      isTTY: true,
      promptContinueLocallyFn: async () => {
        promptCalled = true;
        return true;
      },
    });

    expect(promptCalled).toBe(false);
    expect(bundle).not.toBeNull();
  });
});

describe("executeScanCommand — connectable-repo decline (TTY)", () => {
  it("prints nothing to stdout and produces no bundle when the user declines", async () => {
    const dir = connectableRepo();
    const logs: string[] = [];
    const warnings: string[] = [];

    await executeScanCommand({
      repoPath: dir,
      author: ["you@example.com"],
      yes: true,
      toolVersion: "0.1.0",
      configDir: tempConfigDir(),
      log: (m) => logs.push(m),
      warn: (m) => warnings.push(m),
      isTTY: true,
      promptContinueLocallyFn: async () => false,
    });

    expect(logs).toHaveLength(0);
    expect(warnings.some((w) => w.includes("GitHub App"))).toBe(true);
  });
});

describe("executeScanCommand — --json treats a connectable-repo TTY run as non-interactive", () => {
  it("--json on a real TTY never invokes the 'Continue locally?' prompt — it warns (stderr) and continues straight to JSON, same as a piped run", async () => {
    const dir = connectableRepo();
    const logs: string[] = [];
    const warnings: string[] = [];
    let promptCalled = false;

    await executeScanCommand({
      repoPath: dir,
      author: ["you@example.com"],
      yes: true,
      toolVersion: "0.1.0",
      configDir: tempConfigDir(),
      log: (m) => logs.push(m),
      warn: (m) => warnings.push(m),
      isTTY: true,
      json: true,
      promptContinueLocallyFn: async () => {
        promptCalled = true;
        return false; // if this ever fired, declining would prove it fired.
      },
    });

    expect(promptCalled).toBe(false);
    expect(warnings.some((w) => w.includes("This repo appears connectable through GitHub."))).toBe(true);
    expect(logs).toHaveLength(1);
    expect(() => JSON.parse(logs[0])).not.toThrow();
  });
});

describe("executeSubmitCommand — connectable-repo decline (TTY)", () => {
  it("uploads nothing and prints nothing to stdout when the user declines", async () => {
    const server = await startMockServer(() => ({ status: 200, body: { id: "should-not-be-called" } }));
    servers.push(server);
    const originalSiteUrl = process.env.REDENTIAL_SITE_URL;
    process.env.REDENTIAL_SITE_URL = server.url;

    const dir = connectableRepo();
    const configDir = tempConfigDir();
    saveCredentials({ access_token: "t", site_url: server.url, obtained_at: "now" }, configDir);

    const logs: string[] = [];
    const warnings: string[] = [];
    try {
      await executeSubmitCommand({
        repoPath: dir,
        author: ["you@example.com"],
        yes: true,
        confirmUpload: true,
        toolVersion: "0.1.0",
        configDir,
        log: (m) => logs.push(m),
        warn: (m) => warnings.push(m),
        isTTY: true,
        promptContinueLocallyFn: async () => false,
      });
    } finally {
      process.env.REDENTIAL_SITE_URL = originalSiteUrl;
    }

    expect(logs).toHaveLength(0);
    expect(server.requests.filter((r) => r.url === "/api/cli/bundles")).toHaveLength(0);
    expect(warnings.some((w) => w.includes("GitHub App"))).toBe(true);
  });
});
