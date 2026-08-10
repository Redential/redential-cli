import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanup, commit, createRepo } from "../support/fixtures.js";
import { startMockServer, type MockServer } from "../support/mock-server.js";
import { saveCredentials } from "../../src/credentials.js";
import { executeSubmitCommand } from "../../src/submit-command.js";
import { ScanError } from "../../src/errors.js";

/**
 * The private label — see docs/private-label.md. This is the ONLY change
 * to this milestone's discussion record that touches WHAT leaves the
 * machine, so it gets its own dedicated privacy test file, same as
 * identity-corroboration.test.ts and submit-guardrail.test.ts before it.
 * Pins the specific ceiling the design doc promises: the bundle itself
 * (schema, bytes, fields) is completely unchanged by this feature — the
 * label only ever travels as a second, separate request's body.
 */

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

function repoWithOneCommit(): string {
  const dir = createRepo();
  dirs.push(dir);
  commit(dir, {
    message: "x",
    authorName: "You",
    authorEmail: "you@example.com",
    files: { "a.ts": "1\n" },
  });
  return dir;
}

const noCheckForUpdate = async () => {};

// 30s timeout: these describes build real git fixture repos and run the
// full submit flow, which can exceed vitest's 5s default on loaded CI
// runners (same fix as test/submit.test.ts).
describe("private label never enters the bundle", { timeout: 30_000 }, () => {
  it("the uploaded bundle body never contains the label string, TTY or not", async () => {
    const server = await startMockServer((req) => {
      if (req.url === "/api/cli/bundles") return { status: 200, body: { id: "bundle-1" } };
      if (req.url === "/api/cli/private-label") return { status: 204, body: {} };
      return { status: 404, body: {} };
    });
    servers.push(server);
    process.env.REDENTIAL_SITE_URL = server.url;

    const dir = repoWithOneCommit();
    const configDir = tempConfigDir();
    saveCredentials({ access_token: "t", site_url: server.url, obtained_at: "now" }, configDir);

    const distinctiveLabel = "Zzyzx-Distinctive-Employer-Nickname-42";
    const logs: string[] = [];
    await executeSubmitCommand({
      repoPath: dir,
      author: ["you@example.com"],
      yes: true,
      confirmUpload: true,
      label: distinctiveLabel,
      toolVersion: "0.1.0",
      configDir,
      log: (m) => logs.push(m),
      warn: () => {},
      checkForUpdateFn: noCheckForUpdate,
      isTTY: true,
    });

    const bundleReq = server.requests.find((r) => r.url === "/api/cli/bundles");
    expect(bundleReq).toBeDefined();
    expect(bundleReq!.body).not.toContain(distinctiveLabel);

    // Nor in the printed "exact payload" JSON line itself — the one line
    // the docs promise is byte-for-byte what gets sent.
    const printedBundleLine = logs.find((l) => l.trim().startsWith("{"));
    expect(printedBundleLine).toBeDefined();
    expect(printedBundleLine).not.toContain(distinctiveLabel);
    // Sanity: the label DID travel somewhere (the label line + the second
    // request) — this isn't a test that just never rendered the label at
    // all.
    expect(logs.some((l) => l.includes(distinctiveLabel))).toBe(true);
    const labelReq = server.requests.find((r) => r.url === "/api/cli/private-label");
    expect(labelReq!.body).toContain(distinctiveLabel);
  });

  it("the bundle request body is byte-identical whether the label is \"X\" or \"Y\" (label independence)", async () => {
    // Same repo dir AND same configDir for both calls — only the git
    // history and the device salt (persisted in configDir, see salt.ts)
    // feed into the bundle's content (repo_fingerprint,
    // author_identity_hashes). Reusing two different repos/configDirs here
    // would also legitimately vary those, which would defeat the point of
    // this test: it isolates "does the label alone change the bundle", not
    // "do two different repos/devices produce different bundles" (obviously
    // true, uninteresting).
    const dir = repoWithOneCommit();
    const configDir = tempConfigDir();

    async function uploadWithLabel(label: string): Promise<string> {
      const server = await startMockServer((req) => {
        if (req.url === "/api/cli/bundles") return { status: 200, body: { id: "bundle-x" } };
        if (req.url === "/api/cli/private-label") return { status: 204, body: {} };
        return { status: 404, body: {} };
      });
      servers.push(server);
      process.env.REDENTIAL_SITE_URL = server.url;

      saveCredentials({ access_token: "t", site_url: server.url, obtained_at: "now" }, configDir);

      await executeSubmitCommand({
        repoPath: dir,
        author: ["you@example.com"],
        yes: true,
        confirmUpload: true,
        label,
        toolVersion: "0.1.0",
        configDir,
        log: () => {},
        warn: () => {},
        checkForUpdateFn: noCheckForUpdate,
      });

      const bundleReq = server.requests.find((r) => r.url === "/api/cli/bundles");
      return bundleReq!.body;
    }

    const bodyWithX = await uploadWithLabel("X");
    const bodyWithY = await uploadWithLabel("Y");
    // The only fields allowed to differ between two otherwise-identical
    // scans are the wall-clock-derived ones (created_at,
    // attestation.confirmed_at) — parse both and strip those before
    // comparing, same fields submission-record.ts's own bundleContentHash
    // strips for the same reason (a scan a moment apart shouldn't look
    // "different" for reasons unrelated to what's being tested here).
    function stripVolatile(json: string): unknown {
      const parsed = JSON.parse(json) as Record<string, unknown>;
      const { created_at: _createdAt, attestation, ...rest } = parsed;
      const { confirmed_at: _confirmedAt, ...attestationRest } = attestation as Record<string, unknown>;
      return { ...rest, attestation: attestationRest };
    }
    expect(stripVolatile(bodyWithX)).toEqual(stripVolatile(bodyWithY));
  });
});

describe("private label consent-surface ordering", { timeout: 30_000 }, () => {
  it("the label line prints before the upload prompt is invoked", async () => {
    const server = await startMockServer((req) => {
      if (req.url === "/api/cli/bundles") return { status: 200, body: { id: "bundle-order" } };
      if (req.url === "/api/cli/private-label") return { status: 204, body: {} };
      return { status: 404, body: {} };
    });
    servers.push(server);
    process.env.REDENTIAL_SITE_URL = server.url;

    const dir = repoWithOneCommit();
    const configDir = tempConfigDir();
    saveCredentials({ access_token: "t", site_url: server.url, obtained_at: "now" }, configDir);

    const logs: string[] = [];
    let logsAtPromptTime: string[] = [];
    await executeSubmitCommand({
      repoPath: dir,
      author: ["you@example.com"],
      yes: true,
      confirmUpload: false,
      label: "Acme Corp",
      toolVersion: "0.1.0",
      configDir,
      log: (m) => logs.push(m),
      warn: () => {},
      checkForUpdateFn: noCheckForUpdate,
      isTTY: true,
      promptConfirmUploadFn: async () => {
        logsAtPromptTime = [...logs];
        return false; // decline — nothing must upload; only ordering matters here
      },
    });

    expect(logsAtPromptTime.some((l) => l.includes("Plus your private label:"))).toBe(true);
    expect(logsAtPromptTime.some((l) => l.includes("Acme Corp"))).toBe(true);
    // And declining after that point uploads nothing.
    expect(server.requests.filter((r) => r.url === "/api/cli/bundles")).toHaveLength(0);
    expect(server.requests.filter((r) => r.url === "/api/cli/private-label")).toHaveLength(0);
  });
});

describe("non-TTY without --label uploads nothing", { timeout: 30_000 }, () => {
  it("throws before any network call — no bundle request, no label request, no request of any kind", async () => {
    const server = await startMockServer(() => ({ status: 200, body: { id: "should-not-be-called" } }));
    servers.push(server);
    process.env.REDENTIAL_SITE_URL = server.url;

    const dir = repoWithOneCommit();
    const configDir = tempConfigDir();
    saveCredentials({ access_token: "t", site_url: server.url, obtained_at: "now" }, configDir);

    await expect(
      executeSubmitCommand({
        repoPath: dir,
        author: ["you@example.com"],
        yes: true,
        confirmUpload: true,
        toolVersion: "0.1.0",
        configDir,
        log: () => {},
        warn: () => {},
      })
    ).rejects.toBeInstanceOf(ScanError);

    expect(server.requests).toHaveLength(0);
  });
});
