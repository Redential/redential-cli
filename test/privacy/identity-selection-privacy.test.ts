import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBundleInteractively } from "../../src/build-bundle.js";
import { saveCredentials } from "../../src/credentials.js";
import { executeSubmitCommand } from "../../src/submit-command.js";
import type { Bundle } from "../../src/types.js";
import { cleanup, commit, createRepo } from "../support/fixtures.js";
import { startMockServer, type MockServer } from "../support/mock-server.js";

const dirs: string[] = [];
const servers: MockServer[] = [];
const originalSiteUrl = process.env.REDENTIAL_SITE_URL;

afterEach(async () => {
  while (dirs.length > 0) cleanup(dirs.pop()!);
  while (servers.length > 0) await servers.pop()!.close();
  process.env.REDENTIAL_SITE_URL = originalSiteUrl;
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

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else {
      out.push(full);
    }
  }
  return out.sort();
}

/** Strips the two fields runScan always fills from `new Date()`, so bundles
 * produced by different calls (a few ms apart) can be compared exactly —
 * same helper as test/identity-selection-flow.test.ts. */
function normalizeForComparison(bundle: Bundle): unknown {
  return {
    ...bundle,
    created_at: "STRIPPED",
    attestation: { ...bundle.attestation, confirmed_at: "STRIPPED" },
  };
}

// 30s timeout: this describe builds real git fixture repos and one of its
// tests runs the full submit flow against a mock server, which can exceed
// vitest's 5s default on loaded CI runners (same fix as
// test/submit.test.ts).
describe("identity-selection memory never leaks into the scanned repo or the network", { timeout: 30_000 }, () => {
  it("(a) an interactive scan reusing a stored selection adds no file anywhere under the scanned repo", async () => {
    const dir = repoWithTwoAuthors();
    const configDir = tempConfigDir();

    await buildBundleInteractively({
      repoPath: dir,
      author: [],
      yes: true,
      toolVersion: "0.1.0",
      configDir,
      isTTY: true,
      warn: () => {},
      promptAuthorsFn: async () => ["alice@example.com"],
    });

    const before = walk(dir);

    await buildBundleInteractively({
      repoPath: dir,
      author: [],
      yes: true,
      toolVersion: "0.1.0",
      configDir,
      isTTY: true,
      warn: () => {},
      promptUseSavedSelectionFn: async () => true,
    });

    const after = walk(dir);
    expect(after).toEqual(before);
    // Nothing under the repo is ever named after this feature's own store file.
    expect(after.some((f) => f.endsWith("identity-selections.json"))).toBe(false);
  });

  it("(b) a submit that reuses a stored selection never puts the stored plaintext emails in any request body or header", async () => {
    const dir = repoWithTwoAuthors();
    const configDir = tempConfigDir();

    const server = await startMockServer((req) => {
      if (req.url === "/api/cli/bundles") return { status: 200, body: { id: "bundle-privacy" } };
      return { status: 404, body: {} };
    });
    servers.push(server);
    process.env.REDENTIAL_SITE_URL = server.url;
    saveCredentials({ access_token: "t", site_url: server.url, obtained_at: "now" }, configDir);

    // Establish the stored selection first, exactly as a prior interactive
    // run would have.
    await buildBundleInteractively({
      repoPath: dir,
      author: [],
      yes: true,
      toolVersion: "0.1.0",
      configDir,
      isTTY: true,
      warn: () => {},
      promptAuthorsFn: async () => ["alice@example.com"],
    });

    await executeSubmitCommand({
      repoPath: dir,
      author: [],
      yes: true,
      confirmUpload: true,
      label: "acme-backend",
      toolVersion: "0.1.0",
      configDir,
      isTTY: true,
      warn: () => {},
      log: () => {},
      promptUseSavedSelectionFn: async () => true,
      checkForUpdateFn: async () => {},
    });

    for (const request of server.requests) {
      expect(request.body, `${request.url} body must never contain the stored plaintext email`).not.toContain(
        "alice@example.com"
      );
      for (const [key, value] of Object.entries(request.headers)) {
        expect(
          String(value),
          `${request.url} header "${key}" must never contain the stored plaintext email`
        ).not.toContain("alice@example.com");
      }
    }

    // And, for good measure, never written to disk anywhere under the
    // config dir in plaintext by any file OTHER than the identity-selection
    // store itself (which is documented and expected to hold it locally —
    // see docs/identity-selection-memory.md).
    for (const file of walk(configDir)) {
      if (file.endsWith("identity-selections.json")) continue;
      const contents = readFileSync(file, "utf8");
      expect(contents, `${file} should not contain the stored plaintext email`).not.toContain("alice@example.com");
    }
  });

  it("(c) the bundle produced via stored-selection reuse deep-equals the bundle from an explicit --author run on the same repo", async () => {
    const dir = repoWithTwoAuthors();
    const configDir = tempConfigDir();

    await buildBundleInteractively({
      repoPath: dir,
      author: [],
      yes: true,
      toolVersion: "0.1.0",
      configDir,
      isTTY: true,
      warn: () => {},
      promptAuthorsFn: async () => ["alice@example.com"],
    });

    const bundleFromStore = await buildBundleInteractively({
      repoPath: dir,
      author: [],
      yes: true,
      toolVersion: "0.1.0",
      configDir,
      isTTY: true,
      warn: () => {},
      promptUseSavedSelectionFn: async () => true,
    });

    const bundleFromAuthorFlag = await buildBundleInteractively({
      repoPath: dir,
      author: ["alice@example.com"],
      yes: true,
      toolVersion: "0.1.0",
      configDir,
      warn: () => {},
    });

    expect(normalizeForComparison(bundleFromStore!)).toEqual(normalizeForComparison(bundleFromAuthorFlag!));
  });
});
