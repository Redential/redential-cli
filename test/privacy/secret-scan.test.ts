import { afterEach, describe, expect, it } from "vitest";
import { assertNoSecrets, findSecretPatterns } from "../../src/secret-scan.js";
import { ScanError } from "../../src/errors.js";
import { runScan } from "../../src/scan.js";
import { cleanup, commit, createRepo } from "../support/fixtures.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// AWS's own canonical example key, used throughout their public docs —
// obviously fake, but structurally shaped like a real one (matches
// CLAUDE.md's "usar xxx-EXAMPLE-xxx" convention while still exercising the
// detector's actual pattern).
const FAKE_AWS_KEY = "AKIAIOSFODNN7EXAMPLE";

describe("secret-scan", () => {
  it("flags an AWS access key ID", () => {
    expect(findSecretPatterns(`{"note":"${FAKE_AWS_KEY}"}`)).toContain("AWS access key ID");
  });

  it("flags a PEM private key header", () => {
    const payload = "-----BEGIN RSA PRIVATE KEY-----\nxxx-EXAMPLE-FAKE-KEY-xxx\n-----END RSA PRIVATE KEY-----";
    expect(findSecretPatterns(payload)).toContain("PEM private key");
  });

  it("flags a generic api_key/secret/token assignment", () => {
    expect(findSecretPatterns('api_key = "xxx-EXAMPLE-FAKE-TOKEN-xxxxxxxxxx"')).toContain(
      "API key/secret/token/password assignment"
    );
  });

  it("flags a .env-style KEY=VALUE assignment", () => {
    expect(findSecretPatterns("DATABASE_PASSWORD=xxx-EXAMPLE-FAKE-PASSWORD-xxx")).toContain(
      ".env-style KEY=VALUE assignment"
    );
  });

  it("does not flag a clean, schema-shaped bundle payload", () => {
    const cleanPayload = JSON.stringify(
      {
        schema_version: "1.0.0",
        runner: "local",
        repo: { host_type: "github", age_days: 42, repo_fingerprint: "a".repeat(64) },
        identity: { author_identity_hashes: ["b".repeat(64)], other_contributors_count: 2 },
        languages: [{ extension: ".ts", share: 0.5 }],
        categories: [{ name: "backend", commit_count: 3, churn_share: 1 }],
      },
      null,
      2
    );
    expect(findSecretPatterns(cleanPayload)).toEqual([]);
  });

  it("assertNoSecrets throws ScanError without leaking the matched value", () => {
    let caught: unknown;
    try {
      assertNoSecrets(`leaked key: ${FAKE_AWS_KEY}`);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ScanError);
    expect((caught as Error).message).not.toContain(FAKE_AWS_KEY);
    expect((caught as Error).message).toContain("AWS access key ID");
  });

  it("assertNoSecrets does not throw on clean input", () => {
    expect(() => assertNoSecrets('{"schema_version":"1.0.0"}')).not.toThrow();
  });

  describe("wired into runScan itself", () => {
    const dirs: string[] = [];
    afterEach(() => {
      while (dirs.length > 0) cleanup(dirs.pop()!);
    });

    it("refuses to return a bundle when a secret-shaped value reaches the payload", () => {
      const dir = createRepo();
      dirs.push(dir);
      const configDir = mkdtempSync(join(tmpdir(), "redential-config-"));
      dirs.push(configDir);
      commit(dir, {
        message: "x",
        authorName: "You",
        authorEmail: "you@example.com",
        files: { "a.ts": "1\n" },
      });

      // tool_version is attacker-controllable only in theory (it normally
      // comes from package.json) — used here purely to prove the gate is
      // actually reached from runScan's own return path, not just testable
      // in isolation on assertNoSecrets/findSecretPatterns directly.
      expect(() =>
        runScan({
          repoPath: dir,
          authors: ["you@example.com"],
          confirmed: true,
          toolVersion: FAKE_AWS_KEY,
          configDir,
        })
      ).toThrow(ScanError);
    });
  });
});
