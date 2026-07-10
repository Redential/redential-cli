import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanup, commit, createRepo, setRemote } from "../support/fixtures.js";
import { validateAgainstSchema } from "../support/schema-validate.js";
import { runScan } from "../../src/scan.js";

const schema = JSON.parse(
  readFileSync(new URL("../../schema/bundle.v1.json", import.meta.url), "utf8")
);

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) cleanup(dirs.pop()!);
});

function tempConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "redential-config-"));
  dirs.push(dir);
  return dir;
}

/**
 * A repo deliberately full of things that must never reach the bundle:
 * planted fake secrets (xxx-EXAMPLE-xxx style, per CLAUDE.md), a revealing
 * path and remote naming the (fictional) employer, a confidential commit
 * message, and a second contributor's identity.
 */
function buildHostileRepo(): string {
  const dir = createRepo();
  dirs.push(dir);

  setRemote(dir, "https://github.com/acme-corp-internal/secret-payroll-system.git");

  commit(dir, {
    message: "Fix Q3 layoff calculation bug for Project Phoenix (CONFIDENTIAL - do not share)",
    authorName: "You",
    authorEmail: "you@example.com",
    files: {
      ".env":
        "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\n" +
        "AWS_SECRET_ACCESS_KEY=xxx-EXAMPLE-FAKE-SECRET-xxx\n" +
        "DATABASE_PASSWORD=xxx-EXAMPLE-FAKE-PASSWORD-xxx\n",
      "src/internal/acme-corp-payroll/salary-calculator.ts":
        "export function calculateSalary() { /* proprietary formula */ }\n",
    },
  });

  commit(dir, {
    message: "Add colleague's fix for the Phoenix rollout",
    authorName: "Colleague",
    authorEmail: "colleague@acme-corp-internal.example",
    files: {
      "src/internal/acme-corp-payroll/salary-calculator.ts":
        "export function calculateSalary() { /* proprietary formula, patched */ }\n",
    },
  });

  return dir;
}

describe("bundle boundaries (hostile fixture)", () => {
  it("never leaks paths, secrets, commit messages, remote URL, or other contributors", async () => {
    const dir = buildHostileRepo();
    const configDir = tempConfigDir();

    const bundle = await runScan({
      repoPath: dir,
      authors: ["you@example.com"],
      confirmed: true,
      toolVersion: "0.1.0",
      configDir,
    });
    const json = JSON.stringify(bundle);

    // Planted secrets.
    expect(json).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(json).not.toContain("xxx-EXAMPLE-FAKE-SECRET-xxx");
    expect(json).not.toContain("xxx-EXAMPLE-FAKE-PASSWORD-xxx");

    // File/directory names and source code.
    expect(json).not.toContain(".env");
    expect(json).not.toContain("salary-calculator");
    expect(json).not.toContain("calculateSalary");
    expect(json).not.toContain("proprietary formula");

    // Commit messages.
    expect(json).not.toContain("Q3 layoff");
    expect(json).not.toContain("Project Phoenix");
    expect(json).not.toContain("CONFIDENTIAL");

    // Remote URL / employer identity — only host_type may survive.
    expect(json).not.toContain("acme-corp");
    expect(json).not.toContain("secret-payroll-system");
    expect(json).not.toContain("github.com/acme-corp-internal");
    expect(bundle.repo.host_type).toBe("github");

    // Other contributors: aggregate count only, never their name or email.
    expect(json).not.toContain("colleague@acme-corp-internal.example");
    expect(json).not.toContain("Colleague");
    expect(bundle.identity.other_contributors_count).toBe(1);

    // The selected author's own email is hashed, never plaintext.
    expect(json).not.toContain("you@example.com");
    expect(bundle.identity.author_identity_hashes[0]).toMatch(/^[0-9a-f]{64}$/);

    // What IS allowed to survive: bounded, closed-vocabulary fields.
    expect(bundle.languages.every((l) => /^\.[a-z0-9]+$/.test(l.extension))).toBe(true);
    expect(
      bundle.categories.every((c) =>
        [
          "auth",
          "payments",
          "infra",
          "frontend",
          "backend",
          "data",
          "testing",
          "ai-workflow",
          "docs",
          "other",
        ].includes(c.name)
      )
    ).toBe(true);

    expect(validateAgainstSchema(schema, bundle)).toEqual([]);
  });
});
