import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockServer, type MockServer } from "./support/mock-server.js";
import { cleanup } from "./support/fixtures.js";
import { runLogin } from "../src/login.js";
import { AuthError } from "../src/errors.js";

const dirs: string[] = [];
const servers: MockServer[] = [];
const originalSiteUrl = process.env.REDENTIAL_SITE_URL;

afterEach(async () => {
  while (dirs.length > 0) cleanup(dirs.pop()!);
  while (servers.length > 0) {
    await servers.pop()!.close();
  }
  process.env.REDENTIAL_SITE_URL = originalSiteUrl;
});

function tempConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "redential-config-"));
  dirs.push(dir);
  return dir;
}

const instantSleep = () => Promise.resolve();
// Every test but the two that specifically exercise openFn injects this —
// without it, the default openBrowser would actually shell out and pop a
// real browser window/tab for the mocked verification_uri on every test run.
const noOpen = () => {};

describe("runLogin (device flow against a mocked local server)", () => {
  it("polls until confirmed, then stores a 0600 credentials file scoped to the site", async () => {
    let pollCount = 0;
    const server = await startMockServer((req) => {
      if (req.url === "/api/cli/device/authorize") {
        return {
          status: 200,
          body: {
            device_code: "dc-1",
            user_code: "ABCD-1234",
            verification_uri: "http://example.test/activate",
            expires_in: 600,
            interval: 0,
          },
        };
      }
      if (req.url === "/api/cli/device/token") {
        pollCount++;
        // The real server (RFC 8628 shape) returns authorization_pending as
        // HTTP 400, not 200 — reproducing that here is what actually
        // exercises the poll loop's handling of the real contract.
        if (pollCount < 2) return { status: 400, body: { error: "authorization_pending" } };
        return { status: 200, body: { access_token: "secret-token-abc" } };
      }
      return { status: 404, body: {} };
    });
    servers.push(server);
    process.env.REDENTIAL_SITE_URL = server.url;

    const configDir = tempConfigDir();
    const logs: string[] = [];
    await runLogin({ configDir, log: (m) => logs.push(m), sleepFn: instantSleep, openFn: noOpen });

    expect(pollCount).toBe(2);
    expect(logs.some((l) => l.includes("ABCD-1234"))).toBe(true);

    const credPath = join(configDir, "credentials.json");
    const stored = JSON.parse(readFileSync(credPath, "utf8"));
    expect(stored.access_token).toBe("secret-token-abc");
    expect(stored.site_url).toBe(server.url);

    const mode = statSync(credPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("honors slow_down by backing off, without failing", async () => {
    let pollCount = 0;
    const server = await startMockServer((req) => {
      if (req.url === "/api/cli/device/authorize") {
        return {
          status: 200,
          body: { device_code: "dc-2", user_code: "X", verification_uri: "http://x", expires_in: 600, interval: 0 },
        };
      }
      pollCount++;
      if (pollCount === 1) return { status: 400, body: { error: "slow_down" } };
      return { status: 200, body: { access_token: "tok" } };
    });
    servers.push(server);
    process.env.REDENTIAL_SITE_URL = server.url;

    const configDir = tempConfigDir();
    await runLogin({ configDir, log: () => {}, sleepFn: instantSleep, openFn: noOpen });
    expect(pollCount).toBe(2);
  });

  it("throws AuthError when the user denies authorization", async () => {
    const server = await startMockServer((req) => {
      if (req.url === "/api/cli/device/authorize") {
        return {
          status: 200,
          body: { device_code: "dc-3", user_code: "X", verification_uri: "http://x", expires_in: 600, interval: 0 },
        };
      }
      return { status: 400, body: { error: "access_denied" } };
    });
    servers.push(server);
    process.env.REDENTIAL_SITE_URL = server.url;

    const configDir = tempConfigDir();
    await expect(
      runLogin({ configDir, log: () => {}, sleepFn: instantSleep, openFn: noOpen })
    ).rejects.toBeInstanceOf(AuthError);
  });

  it("throws AuthError when the code expires before confirmation", async () => {
    const server = await startMockServer((req) => {
      if (req.url === "/api/cli/device/authorize") {
        return {
          status: 200,
          body: { device_code: "dc-4", user_code: "X", verification_uri: "http://x", expires_in: 600, interval: 0 },
        };
      }
      return { status: 400, body: { error: "expired_token" } };
    });
    servers.push(server);
    process.env.REDENTIAL_SITE_URL = server.url;

    const configDir = tempConfigDir();
    await expect(
      runLogin({ configDir, log: () => {}, sleepFn: instantSleep, openFn: noOpen })
    ).rejects.toBeInstanceOf(AuthError);
  });

  it("throws AuthError when the deadline passes without a terminal response", async () => {
    const server = await startMockServer((req) => {
      if (req.url === "/api/cli/device/authorize") {
        return {
          // expires_in is negative, so the very first deadline check fails
          // before any polling happens — deterministic without real waits.
          status: 200,
          body: { device_code: "dc-5", user_code: "X", verification_uri: "http://x", expires_in: -1, interval: 0 },
        };
      }
      return { status: 400, body: { error: "authorization_pending" } };
    });
    servers.push(server);
    process.env.REDENTIAL_SITE_URL = server.url;

    const configDir = tempConfigDir();
    await expect(
      runLogin({ configDir, log: () => {}, sleepFn: instantSleep, openFn: noOpen })
    ).rejects.toBeInstanceOf(AuthError);
  });

  it("auto-opens verification_uri via the injected openFn", async () => {
    const server = await startMockServer((req) => {
      if (req.url === "/api/cli/device/authorize") {
        return {
          status: 200,
          body: {
            device_code: "dc-6",
            user_code: "X",
            verification_uri: "http://example.test/activate",
            expires_in: 600,
            interval: 0,
          },
        };
      }
      return { status: 200, body: { access_token: "tok" } };
    });
    servers.push(server);
    process.env.REDENTIAL_SITE_URL = server.url;

    const configDir = tempConfigDir();
    const opened: string[] = [];
    await runLogin({ configDir, log: () => {}, sleepFn: instantSleep, openFn: (url) => opened.push(url) });

    expect(opened).toEqual(["http://example.test/activate"]);
  });

  it("does not fail login when openFn throws", async () => {
    const server = await startMockServer((req) => {
      if (req.url === "/api/cli/device/authorize") {
        return {
          status: 200,
          body: { device_code: "dc-7", user_code: "X", verification_uri: "http://x", expires_in: 600, interval: 0 },
        };
      }
      return { status: 200, body: { access_token: "tok" } };
    });
    servers.push(server);
    process.env.REDENTIAL_SITE_URL = server.url;

    const configDir = tempConfigDir();
    await expect(
      runLogin({
        configDir,
        log: () => {},
        sleepFn: instantSleep,
        openFn: () => {
          throw new Error("no browser available");
        },
      })
    ).resolves.toBeUndefined();
  });
});
