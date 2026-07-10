import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanup, createRepoWithGeneratedHistory } from "../support/fixtures.js";
import { runScan } from "../../src/scan.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) cleanup(dirs.pop()!);
});

function tempConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "redential-config-"));
  dirs.push(dir);
  return dir;
}

const COMMIT_COUNT = 20_000;

/**
 * Separate from the default `npm test` run (package.json's "test" script
 * excludes test/slow/**) — building and scanning 20,000 commits still only
 * takes a few seconds, but it's slow enough, and narrow enough in what it
 * proves, that it doesn't belong gating every quick local test run. CI runs
 * it as its own job, on ubuntu-latest only (see .github/workflows/ci.yml) —
 * the goal is proving the 60s budget holds somewhere real, not on every OS.
 */
describe("scan on a huge repository", () => {
  it(`scans a ${COMMIT_COUNT.toLocaleString("en-US")}-commit repo in under 60 seconds`, async () => {
    const dir = createRepoWithGeneratedHistory(COMMIT_COUNT);
    dirs.push(dir);
    const configDir = tempConfigDir();

    const start = Date.now();
    const bundle = await runScan({
      repoPath: dir,
      authors: ["perf@example.com"],
      confirmed: true,
      toolVersion: "0.1.0",
      configDir,
    });
    const elapsedMs = Date.now() - start;

    expect(bundle.commits.user_total).toBe(COMMIT_COUNT);
    expect(elapsedMs).toBeLessThan(60_000);
  }, 120_000);

  it("does not hold the whole history's diff content in memory at once (batched, not per-commit-in-memory)", async () => {
    const dir = createRepoWithGeneratedHistory(COMMIT_COUNT);
    dirs.push(dir);
    const configDir = tempConfigDir();

    // Not a precise memory-profiler assertion (heap use varies with the
    // Node runtime/GC), but a coarse regression guard: if a future change
    // reverted to holding every commit's full diff text in the RawCommit
    // array simultaneously (rather than fetching diffs in bounded batches
    // — see skill-detect.ts's DIFF_BATCH_SIZE), heap usage here would be
    // dramatically higher than this, not just marginally.
    const before = process.memoryUsage().heapUsed;
    await runScan({
      repoPath: dir,
      authors: ["perf@example.com"],
      confirmed: true,
      toolVersion: "0.1.0",
      configDir,
    });
    const heapGrowthMb = (process.memoryUsage().heapUsed - before) / (1024 * 1024);

    expect(heapGrowthMb).toBeLessThan(200);
  }, 120_000);

  it("streams progress and reaches the final scanned === total count", async () => {
    const dir = createRepoWithGeneratedHistory(COMMIT_COUNT);
    dirs.push(dir);
    const configDir = tempConfigDir();

    const progressCalls: Array<[number, number]> = [];
    await runScan({
      repoPath: dir,
      authors: ["perf@example.com"],
      confirmed: true,
      toolVersion: "0.1.0",
      configDir,
      onProgress: (scanned, total) => progressCalls.push([scanned, total]),
    });

    expect(progressCalls.length).toBeGreaterThan(0);
    const [, total] = progressCalls[0];
    expect(total).toBe(COMMIT_COUNT);
    const [lastScanned, lastTotal] = progressCalls[progressCalls.length - 1];
    expect(lastScanned).toBe(COMMIT_COUNT);
    expect(lastTotal).toBe(COMMIT_COUNT);
  }, 120_000);
});
