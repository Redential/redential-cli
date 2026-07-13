// H3 of the proof-graph spike (see docs/proof-graph-spike.md): the real
// end-to-end pipeline (HEAD snapshot -> parse -> graph -> anchors -> author
// attribution -> classification) exercised against small, programmatically
// built git repos (test/proof-graph/fixtures.ts) — never hand-built
// ParsedFile/ProofGraph/AnchorHit values (that integration level is already
// covered by anchors.test.ts and infer.test.ts). Same zero-network,
// deterministic posture as every other module in this spike: every git read
// here is local (readHeadSnapshot, getAllCommits), nothing is written
// anywhere, and the same input always classifies the same way.
import { afterEach, describe, expect, it } from "vitest";
import { readHeadSnapshot } from "../../src/proof-graph/snapshot.js";
import { TscParserAdapter } from "../../src/proof-graph/parser-adapter.js";
import { buildGraph } from "../../src/proof-graph/graph.js";
import { findAnchors } from "../../src/proof-graph/anchors.js";
import { collectUserTouchedFiles, inferStructuralSkills, STRUCTURAL_SKILL_SLUG } from "../../src/proof-graph/infer.js";
import { getAllCommits } from "../../src/git.js";
import { detectSkills } from "../../src/skill-detect.js";
import { cleanup } from "../support/fixtures.js";
import {
  USER,
  fixtureCommentsOnly,
  fixtureDirectPattern,
  fixtureLayeredPattern,
  fixtureOtherAuthor,
  fixtureStripeUnused,
} from "./fixtures.js";

const adapter = new TscParserAdapter();

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) cleanup(dirs.pop()!);
});

/**
 * Runs the real pipeline the spike's structural tier is built from, minus
 * the bundle step (out of scope for the whole spike — see
 * docs/proof-graph-spike.md's "Approved decisions" #2): HEAD snapshot ->
 * parse each file with the real TscParserAdapter -> build the in-memory
 * graph -> recognize anchors -> obtain the selected author's own commits via
 * the SAME git.ts primitive + author-email filter scan.ts uses for its own
 * `userCommits` (see src/scan.ts: `getAllCommits` then
 * `allCommits.filter((c) => authorSet.has(c.email))`) -> reduce those
 * commits to a touched-files set -> classify.
 */
async function runPipeline(repoPath: string, authorEmail: string) {
  const snapshot = await readHeadSnapshot(repoPath);
  const parsed = snapshot.map((f) => adapter.parse(f.path, f.content));
  const graph = buildGraph(parsed);
  const anchors = findAnchors(graph);

  const allCommits = await getAllCommits(repoPath);
  const userCommits = allCommits.filter((c) => c.email === authorEmail);
  const userTouchedFiles = await collectUserTouchedFiles(repoPath, userCommits);

  const findings = inferStructuralSkills(graph, anchors, userTouchedFiles);
  return { anchors, findings, userCommits };
}

describe("proof-graph H3 end-to-end fixtures (docs/proof-graph-spike.md)", () => {
  it("one file, webhook verification + DB read/write in the same function -> DIRECT (same-function), attributed, claimed", async () => {
    const dir = fixtureDirectPattern();
    dirs.push(dir);

    const { anchors, findings } = await runPipeline(dir, USER.email);

    expect(anchors.length).toBeGreaterThan(0);
    expect(findings).toHaveLength(1);
    const finding = findings[0];
    expect(finding.slug).toBe(STRUCTURAL_SKILL_SLUG);
    expect(finding.confidence).toBe("direct");
    expect(finding.attributed).toBe(true);
    expect(finding.claimed).toBe(true);
    // Asserting the actual connection kind the pipeline yields, not a
    // loosened "truthy" check — all three anchors sit in the same function
    // (handleWebhook), so this must be "same-function", not the weaker
    // "same-file".
    expect(finding.connection).toEqual({ kind: "same-function", edgeDistance: 0 });
  });

  it("three files connected only by relative imports (handler -> service -> repo) -> INFERRED, claimed, edgeDistance <= 3, anchors span >= 2 files", async () => {
    const dir = fixtureLayeredPattern();
    dirs.push(dir);

    const { findings } = await runPipeline(dir, USER.email);

    expect(findings).toHaveLength(1);
    const finding = findings[0];
    expect(finding.confidence).toBe("inferred");
    expect(finding.claimed).toBe(true);
    expect(finding.connection).not.toBeNull();
    expect(finding.connection!.kind).toBe("cross-file");
    expect(finding.connection!.edgeDistance).toBeGreaterThan(0);
    expect(finding.connection!.edgeDistance).toBeLessThanOrEqual(3);
    const distinctAnchorFiles = new Set(finding.anchors.map((a) => a.path));
    expect(distinctAnchorFiles.size).toBeGreaterThanOrEqual(2);
  });

  it("stripe imported but structurally unused -> ambiguous, structural skill NOT claimed (deliberate false negative)", async () => {
    const dir = fixtureStripeUnused();
    dirs.push(dir);

    const { findings, userCommits } = await runPipeline(dir, USER.email);

    expect(findings).toHaveLength(1);
    const finding = findings[0];
    expect(finding.confidence).toBe("ambiguous");
    expect(finding.claimed).toBe(false);

    // The two tiers deliberately coexist (see docs/proof-graph-spike.md's H3
    // entry): Tier 1 (src/skill-detect.ts's plain import matching) still
    // reports "payments/stripe" from the same bare `import Stripe from
    // "stripe"` line, even though the structural tier refuses to claim
    // payment-webhook-flow for the exact same commit/file. Neither result
    // contradicts the other — Tier 1 answers "was stripe imported," the
    // structural tier answers "was it wired into a webhook flow."
    const detected = await detectSkills(userCommits, dir);
    expect(detected.map((s) => s.slug)).toContain("payments/stripe");
  });

  it("pattern committed by a different author -> DIRECT overall, but unattributed and unclaimed for the selected user", async () => {
    const dir = fixtureOtherAuthor();
    dirs.push(dir);

    const { findings } = await runPipeline(dir, USER.email);

    expect(findings).toHaveLength(1);
    const finding = findings[0];
    expect(finding.confidence).toBe("direct");
    expect(finding.attributed).toBe(false);
    expect(finding.claimed).toBe(false);
  });

  it("stripe/prisma/constructEvent appear only in comments and string literals -> no anchors, no finding at all", async () => {
    const dir = fixtureCommentsOnly();
    dirs.push(dir);

    const { anchors, findings } = await runPipeline(dir, USER.email);

    expect(anchors).toEqual([]);
    expect(findings).toEqual([]);
  });
});
