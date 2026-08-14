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
 * Console-UX overhaul (2026-08): the pre-scan connectable-repo guardrail
 * (public-remote.ts's publicHostWarning + the interactive "Continue
 * locally? (Y/n)" follow-up) is GONE entirely — `buildBundleInteractively`
 * no longer prints anything about a connectable remote at all, and never
 * asks a question about it. `scan`'s own connectable-repo notice moved to
 * the END of `executeScanCommand`'s output instead (a one-line, non-
 * blocking `connectableRepoNotice`, public-remote.ts — see
 * `test/scan-command.test.ts`'s "connectable-repo notice (end of output)"
 * block for that). `submit` no longer prints any pre-emptive notice about a
 * connectable remote either — its real, definitive answer is the network
 * visibility gate (`checkVisibilityGate`, submit.ts), which still refuses
 * confirmed-public repos, and which falls back to `publicHostWarning`'s own
 * message only on a genuinely inconclusive probe result.
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

describe("buildBundleInteractively — connectable-repo remote: no notice, no prompt, always a bundle", () => {
  it("non-TTY: never mentions the remote, and a bundle is always returned", async () => {
    const dir = connectableRepo();
    const warnings: string[] = [];

    const bundle = await buildBundleInteractively({
      repoPath: dir,
      author: ["you@example.com"],
      yes: true,
      toolVersion: "0.1.0",
      configDir: tempConfigDir(),
      warn: (m) => warnings.push(m),
      // isTTY omitted — same as a piped/non-interactive run.
    });

    expect(warnings.some((w) => w.includes("appears connectable"))).toBe(false);
    expect(bundle.commits.user_total).toBe(1);
  });

  it("TTY: never mentions the remote either, and never asks anything about it", async () => {
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
    });

    expect(warnings.some((w) => w.includes("appears connectable"))).toBe(false);
    expect(bundle.commits.user_total).toBe(1);
  });

  it("a non-connectable (self-hosted) remote behaves identically — nothing to distinguish here anymore", async () => {
    const dir = createRepo();
    dirs.push(dir);
    setRemote(dir, "https://git.internal.acme-corp.example/team/repo.git");
    commit(dir, {
      message: "x",
      authorName: "You",
      authorEmail: "you@example.com",
      files: { "a.ts": "1\n" },
    });

    const bundle = await buildBundleInteractively({
      repoPath: dir,
      author: ["you@example.com"],
      yes: true,
      toolVersion: "0.1.0",
      configDir: tempConfigDir(),
      warn: () => {},
      isTTY: true,
    });

    expect(bundle.commits.user_total).toBe(1);
  });
});

describe("executeScanCommand — connectable-repo notice (end of output, both modes, never blocks)", () => {
  it("TTY: prints the notice to stderr AFTER the summary, and the scan still fully completes", async () => {
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
    });

    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("PRIVATE WORK, LOCALLY DERIVED");
    const noticeIndex = warnings.findIndex((w) => w.includes("GitHub App"));
    expect(noticeIndex).toBeGreaterThanOrEqual(0);
    // Owner-mandated ordering (2026-08): the notice prints right after the
    // summary, BEFORE whatever comes last (here, no stored session -> a
    // plain login+submit reminder) — never after it. See scan-command.ts's
    // executeScanCommand doc comment.
    expect(warnings[warnings.length - 1]).toContain("Log in and run `redential submit`");
    expect(noticeIndex).toBeLessThan(warnings.length - 1);
  });

  it("piped/non-TTY: still warns (stderr), stdout stays exactly the raw JSON", async () => {
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
    });

    expect(logs).toHaveLength(1);
    expect(() => JSON.parse(logs[0])).not.toThrow();
    expect(warnings.some((w) => w.includes("GitHub App"))).toBe(true);
  });

  it("a self-hosted remote never prints the notice", async () => {
    const dir = createRepo();
    dirs.push(dir);
    setRemote(dir, "https://git.internal.acme-corp.example/team/repo.git");
    commit(dir, {
      message: "x",
      authorName: "You",
      authorEmail: "you@example.com",
      files: { "a.ts": "1\n" },
    });

    const warnings: string[] = [];
    await executeScanCommand({
      repoPath: dir,
      author: ["you@example.com"],
      yes: true,
      toolVersion: "0.1.0",
      configDir: tempConfigDir(),
      log: () => {},
      warn: (m) => warnings.push(m),
    });

    expect(warnings.some((w) => w.includes("GitHub App"))).toBe(false);
  });
});

// 30s timeout: this describe builds a real git fixture repo and runs the
// full submit flow against a mock server, which can exceed vitest's 5s
// default on loaded CI runners (same fix as test/submit.test.ts).
describe("executeSubmitCommand — connectable-repo remote (TTY)", { timeout: 30_000 }, () => {
  it("submit prints no pre-emptive connectable-repo notice — its real guard is the visibility gate below", async () => {
    const server = await startMockServer(() => ({ status: 200, body: { id: "b1" } }));
    servers.push(server);
    const originalSiteUrl = process.env.REDENTIAL_SITE_URL;
    process.env.REDENTIAL_SITE_URL = server.url;

    const dir = connectableRepo();
    const configDir = tempConfigDir();
    saveCredentials({ access_token: "t", site_url: server.url, obtained_at: "now" }, configDir);

    const warnings: string[] = [];
    let probeCalled = false;
    try {
      // `probeFn` stubs the gate's network probe to return 404 (not
      // publicly reachable), which lets the run flow through the gate
      // unblocked and on to the upload — the gate's own blocked/unblocked
      // outcomes are covered separately in test/submit.test.ts; this test
      // only cares that the gate is what actually runs.
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
        probeFn: async () => {
          probeCalled = true;
          return { status: 404 };
        },
        checkForUpdateFn: async () => {},
      });
    } finally {
      process.env.REDENTIAL_SITE_URL = originalSiteUrl;
    }

    expect(probeCalled).toBe(true);
    expect(warnings.some((w) => w.includes("appears connectable"))).toBe(false);
    expect(server.requests.some((r) => r.url === "/api/cli/bundles")).toBe(true);
  });
});
