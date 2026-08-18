import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanup, commit, createRepo, setRemote } from "../support/fixtures.js";
import { startMockServer, type MockServer } from "../support/mock-server.js";
import { saveCredentials } from "../../src/credentials.js";
import { executeSubmitCommand } from "../../src/submit-command.js";
import { checkVisibilityGate, fetchNpmPackument } from "../../src/submit.js";
import { checkNpmAnachronisms } from "../../src/npm-anachronism.js";
import { NetworkError } from "../../src/errors.js";

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

function repoWithBetterAuth(remote?: string): string {
  const dir = createRepo();
  dirs.push(dir);
  if (remote) setRemote(dir, remote);
  commit(dir, {
    message: "use better auth",
    authorName: "You",
    authorEmail: "you@example.com",
    authorDate: "2022-06-01T00:00:00Z",
    files: { "auth.ts": 'import { betterAuth } from "better-auth";\n' },
  });
  return dir;
}

function repoWithOneCommit(remote?: string): string {
  const dir = createRepo();
  dirs.push(dir);
  if (remote) setRemote(dir, remote);
  commit(dir, {
    message: "x",
    authorName: "You",
    authorEmail: "you@example.com",
    files: { "a.ts": "1\n" },
  });
  return dir;
}

// 30s timeout: these describes build real git fixture repos and run the
// full submit flow, which can exceed vitest's 5s default on loaded CI
// runners (same fix as test/submit.test.ts).
describe("submit never leaks the token or the bundle through an error message", { timeout: 30_000 }, () => {
  it("a failed upload's error message names the host and status, never the token or bundle", async () => {
    const server = await startMockServer(() => ({ status: 500, body: { error: "boom" } }));
    servers.push(server);
    process.env.REDENTIAL_SITE_URL = server.url;

    const dir = repoWithOneCommit();
    const configDir = tempConfigDir();
    const secretToken = "extremely-secret-bearer-token-xyz";
    saveCredentials({ access_token: secretToken, site_url: server.url, obtained_at: "now" }, configDir);

    let caught: unknown;
    try {
      await executeSubmitCommand({
        repoPath: dir,
        author: ["you@example.com"],
        yes: true,
        confirmUpload: true,
        label: "acme-backend",
        toolVersion: "0.1.0",
        configDir,
        log: () => {},
        warn: () => {},
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(NetworkError);
    const message = (caught as Error).message;
    expect(message).not.toContain(secretToken);
    // A bundle always contains this exact literal key; if the error message
    // ever started interpolating the bundle/response body, this would catch it.
    expect(message).not.toContain("schema_version");
    expect(message).toContain("500");
  });
});

describe("the visibility probe never fires against a credentialed remote URL", () => {
  it("does not call probeFn when the remote URL embeds credentials, even on a known public host", async () => {
    let probeCalled = false;
    const result = await checkVisibilityGate("https://user:token@github.com/acme/example.git", async () => {
      probeCalled = true;
      return { status: 200 };
    });

    expect(probeCalled).toBe(false);
    expect(result.blocked).toBe(false);
  });

  it("does not call probeFn for a self-hosted remote", async () => {
    let probeCalled = false;
    const result = await checkVisibilityGate("https://git.internal.acme-corp.example/team/repo.git", async () => {
      probeCalled = true;
      return { status: 200 };
    });

    expect(probeCalled).toBe(false);
    expect(result.blocked).toBe(false);
  });
});

describe("npm release lookup privacy boundary", { timeout: 30_000 }, () => {
  it("runs a bounded public-package GET after visibility and before upload, without Redential or repository data", async () => {
    const events: string[] = [];
    const registry = await startMockServer((req) => {
      events.push("npm");
      return { status: 200, body: { time: { created: "2023-09-18T00:00:00.000Z" } } };
    });
    servers.push(registry);
    const site = await startMockServer((req) => {
      if (req.url === "/api/cli/identity/emails") {
        events.push("identity");
        return { status: 404, body: {} };
      }
      if (req.url === "/api/cli/bundles") {
        events.push("upload");
        return { status: 200, body: { id: "ok" } };
      }
      if (req.url === "/api/cli/private-label") return { status: 204, body: {} };
      return { status: 404, body: {} };
    });
    servers.push(site);
    process.env.REDENTIAL_SITE_URL = site.url;

    const remote = "https://github.com/acme/private-employer-repo.git";
    const label = "Private employer work";
    const token = "xxx-EXAMPLE-token";
    const dir = repoWithBetterAuth(remote);
    const configDir = tempConfigDir();
    saveCredentials({ access_token: token, site_url: site.url, obtained_at: "now" }, configDir);
    const logs: string[] = [];
    const warnings: string[] = [];

    await executeSubmitCommand({
      repoPath: dir,
      author: ["you@example.com"],
      yes: true,
      confirmUpload: true,
      label,
      toolVersion: "0.13.0",
      configDir,
      log: (message) => logs.push(message),
      warn: (message) => {
        warnings.push(message);
        if (message.includes("timeline conflicts")) events.push("warning");
      },
      probeFn: async () => {
        events.push("visibility");
        return { status: 404 };
      },
      checkNpmAnachronismsFn: (bundle) =>
        checkNpmAnachronisms(bundle, fetchNpmPackument, { registryBaseUrl: registry.url }),
      checkForUpdateFn: async () => {},
    });

    expect(events).toEqual(["visibility", "npm", "warning", "identity", "upload"]);
    expect(registry.requests).toHaveLength(1);
    const npmRequest = registry.requests[0];
    expect(npmRequest.method).toBe("GET");
    expect(npmRequest.url).toBe("/better-auth");
    expect(npmRequest.url).not.toContain("?");
    expect(npmRequest.body).toBe("");
    expect(npmRequest.headers.accept).toBe("application/json");
    expect(npmRequest.headers.authorization).toBeUndefined();
    expect(npmRequest.headers.cookie).toBeUndefined();

    const serializedRequest = JSON.stringify(npmRequest);
    for (const forbidden of [token, remote, label, site.url, "schema_version", "repo_fingerprint"]) {
      expect(serializedRequest).not.toContain(forbidden);
    }
    const printedBundle = logs.find((line) => line.trim().startsWith("{"));
    const uploaded = site.requests.find((request) => request.url === "/api/cli/bundles");
    expect(uploaded?.body).toBe(printedBundle);
    expect(warnings.some((message) => message.includes("upload will continue"))).toBe(true);
    expect(logs.join("\n")).not.toContain("timeline conflicts");
  });
});

describe("what submit prints is byte-for-byte what it uploads", { timeout: 30_000 }, () => {
  it("the request body equals the exact string logged before the upload confirmation", async () => {
    const server = await startMockServer((req) => {
      if (req.url === "/api/cli/bundles") return { status: 200, body: { id: "ok" } };
      return { status: 404, body: {} };
    });
    servers.push(server);
    process.env.REDENTIAL_SITE_URL = server.url;

    const dir = repoWithOneCommit();
    const configDir = tempConfigDir();
    saveCredentials({ access_token: "t", site_url: server.url, obtained_at: "now" }, configDir);

    const logs: string[] = [];
    await executeSubmitCommand({
      repoPath: dir,
      author: ["you@example.com"],
      yes: true,
      confirmUpload: true,
      label: "acme-backend",
      toolVersion: "0.1.0",
      configDir,
      log: (m) => logs.push(m),
      warn: () => {},
    });

    const printedBundle = logs.find((l) => l.trim().startsWith("{"));
    expect(printedBundle).toBeDefined();
    // The identity-corroboration GET (see submit-command.ts) now also hits
    // this server before the bundle POST, so filter down to the bundle
    // request specifically rather than assuming it's requests[0].
    const bundleRequest = server.requests.find((r) => r.url === "/api/cli/bundles");
    expect(bundleRequest).toBeDefined();
    expect(bundleRequest!.body).toBe(printedBundle);
    // Sanity: it really did print before uploading, not after.
    expect(logs.indexOf(printedBundle!)).toBeLessThan(logs.findIndex((l) => l.includes("Uploaded")));
  });
});
