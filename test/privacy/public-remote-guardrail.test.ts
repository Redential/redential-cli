import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isKnownPublicHost, publicHostWarning } from "../../src/public-remote.js";
import { getRemoteUrl } from "../../src/git.js";
import { executeScanCommand } from "../../src/scan-command.js";
import { cleanup, commit, createRepo, setRemote } from "../support/fixtures.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) cleanup(dirs.pop()!);
});

function tempConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "redential-config-"));
  dirs.push(dir);
  return dir;
}

describe("isKnownPublicHost", () => {
  it("recognizes github.com, gitlab.com and bitbucket.org", () => {
    expect(isKnownPublicHost("https://github.com/acme/example.git")).toBe(true);
    expect(isKnownPublicHost("git@github.com:acme/example.git")).toBe(true);
    expect(isKnownPublicHost("https://gitlab.com/acme/example.git")).toBe(true);
    expect(isKnownPublicHost("https://bitbucket.org/acme/example.git")).toBe(true);
  });

  it("does not recognize a self-hosted / enterprise-looking remote", () => {
    expect(isKnownPublicHost("https://git.internal.acme-corp.example/team/repo.git")).toBe(false);
  });

  it("returns false when there's no remote at all", () => {
    expect(isKnownPublicHost(null)).toBe(false);
  });

  it("does not treat a URL with embedded credentials as a known public host", () => {
    expect(isKnownPublicHost("https://user:token@github.com/acme/example.git")).toBe(false);
    expect(isKnownPublicHost("https://github.com/acme/example.git?token=abc123")).toBe(false);
  });

  it("is a pure function of the remote URL — no network call needed to test it", () => {
    // `git remote add` only writes local config; it never dials out, and
    // neither does isKnownPublicHost. This is the "mocked check": a
    // github.com-shaped URL configured purely locally is enough to
    // exercise the guardrail without any real network reachability.
    const dir = createRepo();
    dirs.push(dir);
    setRemote(dir, "https://github.com/acme/example.git");
    expect(isKnownPublicHost(getRemoteUrl(dir))).toBe(true);
  });
});

describe("publicHostWarning", () => {
  it("returns an informational message for a known public host", () => {
    const warning = publicHostWarning("https://github.com/acme/example.git");
    expect(warning).toContain("GitHub App");
    // Must never claim it verified public accessibility.
    expect(warning).not.toMatch(/is public|publicly accessible/i);
  });

  it("returns null for a self-hosted remote or no remote", () => {
    expect(publicHostWarning("https://git.internal.acme-corp.example/team/repo.git")).toBeNull();
    expect(publicHostWarning(null)).toBeNull();
  });
});

describe("scan continues after a known-public-host warning (never blocks)", () => {
  it("prints the warning AND still produces a bundle for a github.com remote", async () => {
    // Regression test: the CLI's primary use case is a PRIVATE employer
    // repo hosted on github.com — known host != publicly accessible, and
    // `scan` has no network access to tell the difference. Blocking here
    // would break the main use case, so this must warn without blocking.
    const dir = createRepo();
    dirs.push(dir);
    setRemote(dir, "https://github.com/acme/example.git");
    commit(dir, {
      message: "x",
      authorName: "You",
      authorEmail: "you@example.com",
      files: { "a.ts": "1\n" },
    });
    const configDir = tempConfigDir();

    const logs: string[] = [];
    const warnings: string[] = [];
    await executeScanCommand({
      repoPath: dir,
      author: ["you@example.com"],
      yes: true,
      toolVersion: "0.1.0",
      configDir,
      log: (message) => logs.push(message),
      warn: (message) => warnings.push(message),
    });

    // Warning goes to a separate channel (stderr in the real CLI) so
    // `scan | jq` (or any bundle consumer reading stdout) never has to
    // skip a leading non-JSON line.
    expect(warnings.some((line) => line.includes("GitHub App"))).toBe(true);
    expect(logs.some((line) => line.includes("GitHub App"))).toBe(false);
    const bundleLine = logs.find((line) => line.trim().startsWith("{"));
    expect(bundleLine).toBeDefined();
    const bundle = JSON.parse(bundleLine!);
    // H7 (docs/schema-change-h7.md): schema_version bumped 1.1.0 -> 1.2.0
    // (additive fields on detected_skills[] entries; unrelated to this
    // guardrail's own behavior, which this test otherwise leaves untouched).
    expect(bundle.schema_version).toBe("1.2.0");
    expect(bundle.commits.user_total).toBe(1);
  });

  it("produces a bundle with no warning for a self-hosted remote", async () => {
    const dir = createRepo();
    dirs.push(dir);
    setRemote(dir, "https://git.internal.acme-corp.example/team/repo.git");
    commit(dir, {
      message: "x",
      authorName: "You",
      authorEmail: "you@example.com",
      files: { "a.ts": "1\n" },
    });
    const configDir = tempConfigDir();

    const logs: string[] = [];
    const warnings: string[] = [];
    await executeScanCommand({
      repoPath: dir,
      author: ["you@example.com"],
      yes: true,
      toolVersion: "0.1.0",
      configDir,
      log: (message) => logs.push(message),
      warn: (message) => warnings.push(message),
    });

    expect(warnings).toEqual([]);
    expect(logs.some((line) => line.trim().startsWith("{"))).toBe(true);
  });
});
