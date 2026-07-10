import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanup, commit, createRepo, setRemote } from "../support/fixtures.js";
import { startMockServer, type MockServer } from "../support/mock-server.js";
import { saveCredentials } from "../../src/credentials.js";
import { executeSubmitCommand } from "../../src/submit-command.js";
import { checkVisibilityGate } from "../../src/submit.js";
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

describe("submit never leaks the token or the bundle through an error message", () => {
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

describe("what submit prints is byte-for-byte what it uploads", () => {
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
