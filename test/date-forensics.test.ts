import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanup, createRepoWithDualDateHistory, type DualDateCommit } from "./support/fixtures.js";
import { runScan } from "../src/scan.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) cleanup(dirs.pop()!);
});

function tempConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "redential-config-"));
  dirs.push(dir);
  return dir;
}

const MS_PER_DAY = 86_400_000;
const AUTHOR_EMAIL = "you@example.com";

/**
 * These two fixtures exist to prove `integrity.date_forensics` (see
 * docs/schema.md's `date_forensics` section) actually separates the two
 * shapes it was designed to separate: a scripted full-history replay vs. an
 * ordinary history that happens to include a real, partial rebase.
 *
 * Built via `createRepoWithDualDateHistory` (a single `git fast-import`
 * stream), not one `git commit` process per commit — see that helper's doc
 * comment for why: the per-commit-spawn version of this fixture was
 * expensive enough on a resource-constrained CI runner
 * (`windows-latest`/Node 22) to push an *unrelated* test file's temp-dir
 * cleanup past its retry budget, surfacing as an `EBUSY` failure with no
 * connection to date parsing itself (both cases here passed on that same
 * run).
 */
describe("integrity.date_forensics", () => {
  it("flags the incriminating signature of a scripted full-history replay", async () => {
    // 20 commits, author dates fabricated 60 days apart across ~3 years —
    // but every commit object is actually written (committer date) within
    // one 19-minute sitting, as a naive replay script would produce.
    const COMMIT_COUNT = 20;
    const AUTHOR_START_MS = new Date("2020-01-01T00:00:00Z").getTime();
    const AUTHOR_STEP_MS = 60 * MS_PER_DAY;
    const COMMITTER_START_MS = new Date("2026-07-10T00:00:00Z").getTime();
    const COMMITTER_STEP_MS = 60_000;

    const commits: DualDateCommit[] = [];
    for (let i = 0; i < COMMIT_COUNT; i++) {
      commits.push({
        path: `f${i}.ts`,
        content: `${i}\n`,
        authorDate: new Date(AUTHOR_START_MS + i * AUTHOR_STEP_MS).toISOString(),
        committerDate: new Date(COMMITTER_START_MS + i * COMMITTER_STEP_MS).toISOString(),
      });
    }

    const dir = createRepoWithDualDateHistory("You", AUTHOR_EMAIL, commits);
    dirs.push(dir);

    const bundle = await runScan({
      repoPath: dir,
      authors: [AUTHOR_EMAIL],
      confirmed: true,
      toolVersion: "0.1.0",
      configDir: tempConfigDir(),
    });

    const forensics = bundle.integrity.date_forensics;
    // Fabricated author span survives intact: (20 - 1) * 60 days.
    expect(forensics.author_span_days).toBe(19 * 60);
    // Every commit object was actually written in the same ~19-minute
    // sitting — nowhere near a full day.
    expect(forensics.committer_span_days).toBe(0);
    // Every commit's committer date is years off its own author date.
    expect(forensics.mismatch_ratio).toBe(1);
    // All 20 committer dates land inside a single 24h window.
    expect(forensics.committer_burst_ratio).toBe(1);
  });

  it("stays moderate for an ordinary history with a small, real partial rebase", async () => {
    // 20 commits, author dates spread naturally 45 days apart across ~2.3
    // years. 15 of them were never touched again (committer date == author
    // date). 5 (a real partial rebase) were rewritten together in one
    // recent sitting — a shape that DOES move mismatch_ratio and
    // committer_burst_ratio off zero, but nowhere near the replay
    // fixture's 1.0/1.0 above.
    const COMMIT_COUNT = 20;
    const REBASED_INDEXES = new Set([3, 7, 11, 15, 19]);
    const AUTHOR_START_MS = new Date("2023-01-01T00:00:00Z").getTime();
    const AUTHOR_STEP_MS = 45 * MS_PER_DAY;
    const REBASE_COMMITTER_START_MS = new Date("2026-07-10T09:00:00Z").getTime();

    const commits: DualDateCommit[] = [];
    let minCommitterMs = Infinity;
    let maxCommitterMs = -Infinity;
    let rebaseIndex = 0;
    for (let i = 0; i < COMMIT_COUNT; i++) {
      const authorMs = AUTHOR_START_MS + i * AUTHOR_STEP_MS;
      const committerMs = REBASED_INDEXES.has(i)
        ? REBASE_COMMITTER_START_MS + rebaseIndex++ * 60_000
        : authorMs;
      minCommitterMs = Math.min(minCommitterMs, committerMs);
      maxCommitterMs = Math.max(maxCommitterMs, committerMs);

      commits.push({
        path: `f${i}.ts`,
        content: `${i}\n`,
        authorDate: new Date(authorMs).toISOString(),
        committerDate: new Date(committerMs).toISOString(),
      });
    }

    const dir = createRepoWithDualDateHistory("You", AUTHOR_EMAIL, commits);
    dirs.push(dir);

    const bundle = await runScan({
      repoPath: dir,
      authors: [AUTHOR_EMAIL],
      confirmed: true,
      toolVersion: "0.1.0",
      configDir: tempConfigDir(),
    });

    const forensics = bundle.integrity.date_forensics;
    // Real history, untouched: (20 - 1) * 45 days.
    expect(forensics.author_span_days).toBe(19 * 45);
    // Ground truth from the same min/max this fixture was built from —
    // the rebase burst pushes the committer range past the author range.
    expect(forensics.committer_span_days).toBe(Math.floor((maxCommitterMs - minCommitterMs) / MS_PER_DAY));
    // Only the 5 rebased commits actually moved.
    expect(forensics.mismatch_ratio).toBe(REBASED_INDEXES.size / COMMIT_COUNT);
    // The 5 rebased commits are the only same-24h cluster; the other 15
    // are each 45+ days apart from their neighbors.
    expect(forensics.committer_burst_ratio).toBe(REBASED_INDEXES.size / COMMIT_COUNT);

    // The replay signature — both ratios near 1.0 together — is
    // qualitatively distinct from an ordinary partial rebase.
    expect(forensics.mismatch_ratio).toBeLessThan(0.5);
    expect(forensics.committer_burst_ratio).toBeLessThan(0.5);
  });
});
