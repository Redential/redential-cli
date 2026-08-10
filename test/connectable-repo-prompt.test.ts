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
 *
 * `submit` opts out of this follow-up question entirely
 * (`askContinueLocally: false`, see build-bundle.ts) — it still gets the
 * warning line, but its real answer to a public remote is the network
 * visibility gate at the end of submit.ts, which actually refuses
 * confirmed-public repos. See this file's last `describe` block below.
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

// 30s timeout: this describe builds a real git fixture repo and runs the
// full submit flow against a mock server, which can exceed vitest's 5s
// default on loaded CI runners (same fix as test/submit.test.ts).
describe("executeSubmitCommand — connectable-repo notice (TTY)", { timeout: 30_000 }, () => {
  it("submit never asks 'Continue locally?' — it still prints the warning, but its real guard is the visibility gate below, not this prompt", async () => {
    const server = await startMockServer(() => ({ status: 200, body: { id: "b1" } }));
    servers.push(server);
    const originalSiteUrl = process.env.REDENTIAL_SITE_URL;
    process.env.REDENTIAL_SITE_URL = server.url;

    const dir = connectableRepo();
    const configDir = tempConfigDir();
    saveCredentials({ access_token: "t", site_url: server.url, obtained_at: "now" }, configDir);

    const warnings: string[] = [];
    let promptCalled = false;
    let probeCalled = false;
    try {
      // `probeFn` stubs the gate's network probe to return 404 (not
      // publicly reachable), which lets the run flow through the gate
      // unblocked and on to the upload — the gate's own blocked/unblocked
      // outcomes are covered separately in test/submit.test.ts; this test
      // only cares that the gate (not the removed prompt) is what's run.
      await executeSubmitCommand({
        repoPath: dir,
        author: ["you@example.com"],
        yes: true,
        confirmUpload: true,
        label: "acme-backend",
        toolVersion: "0.1.0",
        configDir,
        log: () => {},
        warn: (m) => warnings.push(m),
        isTTY: true,
        promptContinueLocallyFn: async () => {
          promptCalled = true;
          return false;
        },
        probeFn: async () => {
          probeCalled = true;
          return { status: 404 };
        },
        checkForUpdateFn: async () => {},
      });
    } finally {
      process.env.REDENTIAL_SITE_URL = originalSiteUrl;
    }

    expect(promptCalled).toBe(false);
    expect(probeCalled).toBe(true);
    expect(warnings.some((w) => w.includes("This repo appears connectable through GitHub."))).toBe(true);
    expect(server.requests.some((r) => r.url === "/api/cli/bundles")).toBe(true);
  });
});
