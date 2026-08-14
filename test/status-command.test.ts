import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeStatusCommand } from "../src/status-command.js";
import { saveCredentials } from "../src/credentials.js";
import { saveLastSubmission } from "../src/submission-record.js";
import { getSiteUrl } from "../src/config.js";
import { cleanup } from "./support/fixtures.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) cleanup(dirs.pop()!);
});

function tempConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "redential-config-"));
  dirs.push(dir);
  return dir;
}

describe("executeStatusCommand", () => {
  it("works when logged out, with no submission history — never crashes, states both plainly", () => {
    const configDir = tempConfigDir();
    const logs: string[] = [];
    executeStatusCommand({ toolVersion: "1.2.3", configDir, log: (m) => logs.push(m) });

    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("redential 1.2.3");
    expect(logs[0]).toContain(configDir);
    expect(logs[0]).toMatch(/Logged in: no/);
    expect(logs[0]).toContain("Last submission: none recorded locally");
  });

  it("shows logged-in state and site_url when a matching session is stored", () => {
    const configDir = tempConfigDir();
    const siteUrl = getSiteUrl();
    saveCredentials({ access_token: "super-secret-token-value", site_url: siteUrl, obtained_at: "now" }, configDir);

    const logs: string[] = [];
    executeStatusCommand({ toolVersion: "1.2.3", configDir, log: (m) => logs.push(m) });

    expect(logs[0]).toMatch(/Logged in: yes/);
    expect(logs[0]).toContain(siteUrl);
    // The token itself must never appear in status output.
    expect(logs[0]).not.toContain("super-secret-token-value");
  });

  it("shows the stored account_label alongside the logged-in state, never the token", () => {
    const configDir = tempConfigDir();
    const siteUrl = getSiteUrl();
    saveCredentials(
      {
        access_token: "super-secret-token-value",
        site_url: siteUrl,
        obtained_at: "now",
        account_label: "jane@example-EXAMPLE.com",
      },
      configDir
    );

    const logs: string[] = [];
    executeStatusCommand({ toolVersion: "1.2.3", configDir, log: (m) => logs.push(m) });

    expect(logs[0]).toMatch(/Logged in: yes/);
    expect(logs[0]).toContain("jane@example-EXAMPLE.com");
    expect(logs[0]).toContain(siteUrl);
    expect(logs[0]).not.toContain("super-secret-token-value");
  });

  it("shows the exact same logged-in line as before this feature when no account_label is stored (old credentials.json)", () => {
    const configDir = tempConfigDir();
    const siteUrl = getSiteUrl();
    // Simulates a credentials.json written by an older CLI version, before
    // account_label existed.
    saveCredentials({ access_token: "super-secret-token-value", site_url: siteUrl, obtained_at: "now" }, configDir);

    const logs: string[] = [];
    executeStatusCommand({ toolVersion: "1.2.3", configDir, log: (m) => logs.push(m) });

    expect(logs[0]).toContain(`Logged in: yes (${siteUrl})`);
  });

  it("flags a stored session for a different site as not usable here, without discarding the info", () => {
    const configDir = tempConfigDir();
    saveCredentials(
      { access_token: "t", site_url: "https://a-different-site.example", obtained_at: "now" },
      configDir
    );

    const logs: string[] = [];
    executeStatusCommand({ toolVersion: "1.2.3", configDir, log: (m) => logs.push(m) });

    expect(logs[0]).not.toMatch(/Logged in: yes/);
    expect(logs[0]).toContain("a-different-site.example");
    expect(logs[0]).toContain("redential login");
  });

  it("shows the last submission's timestamp, and bundle-hash/repo-fingerprint PREFIXES only, never the full values", () => {
    const configDir = tempConfigDir();
    const siteUrl = getSiteUrl();
    saveLastSubmission(
      {
        site_url: siteUrl,
        bundle_hash: "a".repeat(64),
        submitted_at: "2026-01-01T00:00:00.000Z",
        repo_fingerprint: "b".repeat(64),
      },
      configDir
    );

    const logs: string[] = [];
    executeStatusCommand({ toolVersion: "1.2.3", configDir, log: (m) => logs.push(m) });

    expect(logs[0]).toContain("2026-01-01T00:00:00.000Z");
    expect(logs[0]).not.toContain("a".repeat(64));
    expect(logs[0]).not.toContain("b".repeat(64));
    expect(logs[0]).toMatch(/a{8,}/); // some prefix of the hash is shown
    expect(logs[0]).toMatch(/b{8,}/); // some prefix of the fingerprint is shown
  });

  it("handles a pre-existing submission record with no repo_fingerprint field (recorded before it existed) without crashing", () => {
    const configDir = tempConfigDir();
    const siteUrl = getSiteUrl();
    // Simulates an older local-record shape, written before repo_fingerprint
    // existed — the field is optional in SubmissionRecord specifically so
    // this compiles, proving readLastSubmission/status degrade gracefully
    // on old on-disk data rather than crashing.
    saveLastSubmission(
      { site_url: siteUrl, bundle_hash: "c".repeat(64), submitted_at: "2025-01-01T00:00:00.000Z" },
      configDir
    );

    const logs: string[] = [];
    expect(() =>
      executeStatusCommand({ toolVersion: "1.2.3", configDir, log: (m) => logs.push(m) })
    ).not.toThrow();
    expect(logs[0]).toContain("unknown");
  });
});
