import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanup, commit, createRepo } from "../support/fixtures.js";
import { runScan, ScanError } from "../../src/scan.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) cleanup(dirs.pop()!);
});

function tempConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "redential-config-"));
  dirs.push(dir);
  return dir;
}

function tempSignaturesDir(signature: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "redential-hostile-signatures-"));
  dirs.push(dir);
  writeFileSync(join(dir, "hostile.json"), JSON.stringify(signature));
  return dir;
}

function tempPackageMapFile(map: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "redential-hostile-map-"));
  dirs.push(dir);
  const path = join(dir, "package-map.json");
  writeFileSync(path, JSON.stringify({ map }));
  return path;
}

/**
 * Exercises the REAL `runScan` call path (not a standalone unit test of
 * `detectSkills` in isolation) — proves the closed-vocabulary guarantee
 * (docs/principles.md principle 3: "a slug outside taxonomy.json
 * invalidates the whole bundle") holds where it actually matters: before a
 * bundle is ever constructed, let alone printed or submitted. A signature
 * naming a slug outside taxonomy.json must never produce a bundle at all.
 */
describe("skill detection: a slug outside taxonomy.json can never reach a bundle", () => {
  it("rejects before producing a bundle when a signature names a slug not in taxonomy.json", async () => {
    const dir = createRepo();
    dirs.push(dir);
    const configDir = tempConfigDir();
    commit(dir, {
      message: "add code",
      authorName: "Mallory",
      authorEmail: "mallory@example.com",
      files: { "src/index.ts": "console.log('hello');\n" },
    });

    // Shape-valid (matches the bundle schema's slug pattern) but not a
    // taxonomy.json member — and its pattern is deliberately broad enough
    // to match virtually any commit, so if the closed-vocabulary check
    // were ever silently unwired, this would reliably prove it.
    const hostileDir = tempSignaturesDir({
      slug: "evil/not-in-taxonomy",
      importPatterns: ["console"],
      fixtures: { positive: [], negative: [] },
    });

    await expect(
      runScan({
        repoPath: dir,
        authors: ["mallory@example.com"],
        confirmed: true,
        toolVersion: "0.1.0",
        configDir,
        skillDetectOptions: { signaturesDir: hostileDir },
      })
    ).rejects.toThrow(ScanError);
  });

  it("rejects before producing a bundle when a package-map.json entry names a slug not in taxonomy.json", async () => {
    const dir = createRepo();
    dirs.push(dir);
    const configDir = tempConfigDir();
    commit(dir, {
      message: "add dependency",
      authorName: "Mallory",
      authorEmail: "mallory@example.com",
      files: { "src/index.ts": 'import evil from "some-innocuous-package";\n' },
    });

    // Same guarantee as the hostile signature above, but for Tier 1 (the
    // flat package-name -> slug map): a map entry is pure data, not code,
    // but it can still name a slug outside taxonomy.json, and that must be
    // caught by the same closed-vocabulary check `detectSkills` runs on
    // Tier 2 signatures.
    const hostileMapPath = tempPackageMapFile({
      "some-innocuous-package": "evil/not-in-taxonomy",
    });

    await expect(
      runScan({
        repoPath: dir,
        authors: ["mallory@example.com"],
        confirmed: true,
        toolVersion: "0.1.0",
        configDir,
        skillDetectOptions: { packageMapPath: hostileMapPath },
      })
    ).rejects.toThrow(ScanError);
  });

  it("still scans normally against the real, shipped signatures/taxonomy.json", async () => {
    const dir = createRepo();
    dirs.push(dir);
    const configDir = tempConfigDir();
    commit(dir, {
      message: "add code",
      authorName: "Alice",
      authorEmail: "alice@example.com",
      files: { "src/index.ts": "console.log('hello');\n" },
    });

    // No skillDetectOptions override — the default (real) signatures/
    // and taxonomy.json, proving the guard above isn't why real scans work.
    await expect(
      runScan({
        repoPath: dir,
        authors: ["alice@example.com"],
        confirmed: true,
        toolVersion: "0.1.0",
        configDir,
      })
    ).resolves.not.toThrow();
  });
});
