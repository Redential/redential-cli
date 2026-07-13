// H3 of the proof-graph spike (see docs/proof-graph-spike.md): the privacy
// boundary test proving the spike's central "in-memory only" invariant —
// the proof graph is built and walked entirely in memory for the duration
// of the process, and the ONLY thing that ever crosses out of it into the
// bundle is the small, closed-vocabulary surface H7 (docs/schema-change-h7.md)
// deliberately opened: a claimed finding's slug plus its evidence/confidence
// pair. Every principle here has the same status as the rest of test/privacy/
// (docs/principles.md: "If a change breaks one of these tests, the change
// is wrong — not the test"). Originally written pre-H7, before any go
// decision, precisely so the boundary was provably true from H1 onward
// rather than asserted after the fact once the signal became tempting to
// wire in; H7 is that go decision landing for real, and this file moved with
// it — see each assertion below for exactly what changed and why.
//
// Two techniques, both borrowed from existing privacy tests:
//   - Run the REAL scan pipeline against a REAL fixture repo and assert on
//     the REAL serialized bundle (test/privacy/bundle-boundaries.test.ts's
//     style) — proves the boundary holds end-to-end, not just in a unit.
//   - Read the SOURCE of the bundle-producing modules and the graph module
//     mechanically (test/privacy/zero-network.test.ts's source-inspection
//     style) — proves the boundary is structural (the bundle code literally
//     cannot see the graph code), not an accident of today's call graph.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { cleanup } from "../support/fixtures.js";
import { fixtureDirectPattern, fixtureOtherAuthor, fixtureStripeUnused, USER } from "../proof-graph/fixtures.js";
import { runScan } from "../../src/scan.js";
import type { Bundle } from "../../src/types.js";

// H6 phase 2c — the 6 structural slugs STRUCTURAL_PATTERNS (infer.ts) can
// ever produce, kept as a plain literal list here (not imported from
// infer.ts) so this privacy test's own negative assertions stay independent
// of the production module it's checking — importing STRUCTURAL_PATTERNS
// itself would make a future accidental drop of an entry from that table
// silently narrow what this test even checks, defeating the point of a
// fixed, hand-verified list.
const ALL_STRUCTURAL_SLUGS = [
  "payments/payment-webhook-flow",
  "payments/paypal-webhook-flow",
  "payments/mercadopago-flow",
  "payments/lemonsqueezy-webhook-flow",
  "payments/paddle-webhook-flow",
  "payments/iap-subscription-flow",
];

const dirs: string[] = [];
afterAll(() => {
  while (dirs.length > 0) cleanup(dirs.pop()!);
});

function tempConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "redential-config-"));
  dirs.push(dir);
  return dir;
}

/**
 * Recursively lists every file under `dir` (excluding `.git`), relative to
 * `dir`. Used so the fixture's own paths/basenames below are read off disk,
 * not hardcoded — a future edit to test/proof-graph/fixtures.ts's file
 * layout keeps being caught instead of silently rotting this test.
 */
function listFixtureFiles(dir: string, sub = ""): string[] {
  const abs = join(dir, sub);
  const out: string[] = [];
  for (const entry of readdirSync(abs)) {
    if (entry === ".git") continue;
    const rel = sub ? join(sub, entry) : entry;
    if (statSync(join(dir, rel)).isDirectory()) {
      out.push(...listFixtureFiles(dir, rel));
    } else {
      out.push(rel);
    }
  }
  return out;
}

/**
 * Extracts every `function <name>(` identifier declared in `source` — used
 * to pull the fixture's own function names (e.g. handleWebhook) directly
 * out of the file it actually wrote to disk, same rot-proofing rationale as
 * listFixtureFiles above.
 */
function extractFunctionNames(source: string): string[] {
  const names: string[] = [];
  const pattern = /\bfunction\s+(\w+)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    names.push(match[1]);
  }
  return names;
}

let bundle: Bundle;
let bundleJson: string;
let fixtureFiles: string[];
let fixtureBasenames: string[];
let fixtureFunctionNames: string[];

// H7 (docs/schema-change-h7.md) — the two ADDITIVE scans below replace the
// old paypalBundle scan this file used to run. Pre-H7, that second scan
// existed purely to extend a NEGATIVE assertion ("no structural slug ever
// enters") to a second, non-Stripe fixture. H7 deliberately moved that
// boundary — a CLAIMED structural finding's slug now DOES enter the bundle
// — so what's left worth proving with a second and third scan is the two
// cases the contract still says must never travel: an AMBIGUOUS finding
// (fixtureStripeUnused: stripe imported but never wired in) and an
// UNATTRIBUTED one (fixtureOtherAuthor: the full pattern present, but only
// in someone else's commit). Two extra scans, same "runtime budget" posture
// the old comment already established for this file.
let ambiguousBundle: Bundle;
let ambiguousBundleJson: string;
let unattributedBundle: Bundle;
let unattributedBundleJson: string;

beforeAll(async () => {
  const dir = fixtureDirectPattern();
  dirs.push(dir);
  const configDir = tempConfigDir();

  fixtureFiles = listFixtureFiles(dir);
  fixtureBasenames = fixtureFiles.map((f) => basename(f));
  fixtureFunctionNames = fixtureFiles.flatMap((f) =>
    extractFunctionNames(readFileSync(join(dir, f), "utf8"))
  );
  // Sanity check on the fixture itself: if either of these came back empty,
  // the negative assertions below would be checking nothing meaningful.
  expect(fixtureFiles.length).toBeGreaterThan(0);
  expect(fixtureFunctionNames.length).toBeGreaterThan(0);

  // The REAL scan entry point (src/scan.ts's runScan) — same call shape
  // test/privacy/bundle-boundaries.test.ts and test/privacy/zero-network.test.ts
  // drive it with. As of H7, runScan DOES invoke the proof-graph pipeline
  // (scan.ts's computeStructuralSkills) — that's exactly why this fixture
  // (the full, connected, CLAIMED webhook pattern) is the right one to prove
  // assertion 1 below on: even with the structural tier wired in and
  // legitimately claiming a finding here, nothing beyond the closed
  // evidence/confidence vocabulary leaks out.
  bundle = await runScan({
    repoPath: dir,
    authors: [USER.email],
    confirmed: true,
    toolVersion: "0.1.0",
    configDir,
  });
  bundleJson = JSON.stringify(bundle);

  // AMBIGUOUS case — see this block's own comment above.
  const ambiguousDir = fixtureStripeUnused();
  dirs.push(ambiguousDir);
  ambiguousBundle = await runScan({
    repoPath: ambiguousDir,
    authors: [USER.email],
    confirmed: true,
    toolVersion: "0.1.0",
    configDir: tempConfigDir(),
  });
  ambiguousBundleJson = JSON.stringify(ambiguousBundle);

  // UNATTRIBUTED case — see this block's own comment above.
  const unattributedDir = fixtureOtherAuthor();
  dirs.push(unattributedDir);
  unattributedBundle = await runScan({
    repoPath: unattributedDir,
    authors: [USER.email],
    confirmed: true,
    toolVersion: "0.1.0",
    configDir: tempConfigDir(),
  });
  unattributedBundleJson = JSON.stringify(unattributedBundle);
});

describe("proof-graph privacy boundary (H3, docs/proof-graph-spike.md's Invariants)", () => {
  // Principle: "In-memory only — the graph ... is never serialized to
  // disk, never written to scan output, and never included in the bundle"
  // (docs/proof-graph-spike.md). fixtureDirectPattern's src/webhook.ts
  // contains the full connected webhook pattern (see
  // test/proof-graph/fixtures.ts) precisely so this fixture has real,
  // distinctive graph-shaped content to leak if the boundary is ever
  // broken. If any of these strings shows up in the bundle, someone wired
  // proof-graph output (or its underlying source) into scan's output path
  // — that is a product bug, not a test bug, regardless of how "harmless"
  // the leaked fragment looks.
  it("bundle/scan output contains zero graph-derived data from the fixture repo", () => {
    for (const path of fixtureFiles) {
      expect(bundleJson, `bundle must not contain fixture path "${path}"`).not.toContain(path);
    }
    for (const name of fixtureBasenames) {
      expect(bundleJson, `bundle must not contain fixture basename "${name}"`).not.toContain(name);
    }
    for (const name of fixtureFunctionNames) {
      expect(bundleJson, `bundle must not contain fixture function name "${name}"`).not.toContain(name);
    }

    // Graph-internal vocabulary: src/proof-graph/infer.ts's StructuralFinding
    // fields (attributed/claimed/edgeDistance/anchors/connection/
    // searchBounded), src/proof-graph/anchors.ts's provider-matching field
    // (providerSlug) and its Stripe signature-verification call shape
    // (constructEvent/stripe-signature), and the module's own name
    // (proof-graph). Hardcoded rather than derived from the fixture because
    // these are the GRAPH MODULE's own terms, not fixture file content —
    // they wouldn't be caught by the file/function-name extraction above.
    //
    // H7 (docs/schema-change-h7.md): "confidence" was on this list pre-H7,
    // when the whole structural tier was unwired and NOTHING graph-derived
    // was allowed to leave the machine under any name. H7 deliberately moved
    // that boundary — `confidence` (alongside `evidence`) is now the exact,
    // closed-enum, contract-defined surface the proof graph is allowed to
    // expose (docs/schema-change-h7.md's "Nothing else graph-derived may
    // ever enter the bundle" — `evidence`/`confidence` are the whole
    // exception, not a crack in the ceiling). Removing it here is not a
    // weakening of what this test checks: the assertion below still proves
    // the module's own internal field NAMES (anchors, edgeDistance,
    // attributed, claimed, connection, searchBounded, providerSlug) and its
    // Stripe-specific call-shape vocabulary never leak, which is the part of
    // the pre-H7 boundary the contract did NOT move.
    const graphVocabulary = [
      "anchors",
      "edgeDistance",
      "attributed",
      "claimed",
      "searchBounded",
      "connection",
      "providerSlug",
      "constructEvent",
      "stripe-signature",
      "proof-graph",
    ];
    for (const term of graphVocabulary) {
      expect(bundleJson, `bundle must not contain graph vocabulary "${term}"`).not.toContain(term);
    }
  });

  // H7 (docs/schema-change-h7.md) — REPLACES the pre-H7 invariant that used
  // to live here ("the structural signal stays OUT of the bundle for the
  // whole spike", docs/proof-graph-spike.md's Approved decisions #2). H7 is
  // exactly the milestone that deliberately moved that boundary: a CLAIMED
  // structural finding's slug now DOES enter the bundle, carrying exactly
  // the contract's evidence/confidence pair. The positive control
  // (payments/stripe, Tier 1 import matching) is unchanged in spirit from
  // before — it still proves the scan actually looked, and it still shows
  // that an import-tier entry never picks up the new fields it doesn't earn.
  it("a CLAIMED structural finding's slug enters with evidence/confidence per the contract; the plain import-tier slug (positive control) carries neither field", () => {
    const structuralEntry = bundle.detected_skills.find((s) => s.slug === "payments/payment-webhook-flow");
    expect(structuralEntry, "a claimed structural finding must produce a bundle entry (H7)").toBeDefined();
    expect(structuralEntry?.evidence).toBe("structural");
    expect(structuralEntry?.confidence).toBe("direct");

    const importEntry = bundle.detected_skills.find((s) => s.slug === "payments/stripe");
    expect(importEntry, "Tier 1 import-tier positive control").toBeDefined();
    expect(importEntry?.evidence).toBeUndefined();
    expect(importEntry?.confidence).toBeUndefined();

    // Narrower than a blanket "no structural data at all" (the pre-H7
    // assertion this replaces): fixtureDirectPattern only ever contains the
    // Stripe pattern, so none of the OTHER 5 structural slugs the pipeline
    // can ever produce should show up in this particular bundle.
    for (const slug of ALL_STRUCTURAL_SLUGS) {
      if (slug === "payments/payment-webhook-flow") continue;
      expect(bundleJson, `bundle must not contain unrelated structural slug "${slug}"`).not.toContain(slug);
    }
  });

  // H7 (docs/schema-change-h7.md's "AMBIGUOUS findings are never emitted"
  // and "Unattributed findings are never emitted") — the two cases the
  // contract still guarantees never travel, now that a CLAIMED finding does.
  // This REPLACES the old "none of the 6 structural slugs ever enter either
  // scanned bundle" test, which asserted a blanket negative that H7
  // deliberately made false for the claimed case above; what's left of that
  // invariant is exactly these two carve-outs.
  it("an AMBIGUOUS structural finding's slug never enters the bundle, and neither does an UNATTRIBUTED one", () => {
    // AMBIGUOUS: stripe imported but never wired into a verified flow.
    // Positive control (payments/stripe, Tier 1) proves this scan looked.
    expect(ambiguousBundleJson).not.toContain("payments/payment-webhook-flow");
    expect(ambiguousBundle.detected_skills.map((s) => s.slug)).toContain("payments/stripe");

    // UNATTRIBUTED: the full pattern is present in the repo, but only in
    // OTHER's commit — USER's own commits never touch it, so this scan's
    // userCommits population (author-filtered, same as every other tier)
    // never even surfaces the plain Tier 1 import match either.
    expect(unattributedBundleJson).not.toContain("payments/payment-webhook-flow");
    expect(unattributedBundle.detected_skills.map((s) => s.slug)).not.toContain("payments/payment-webhook-flow");
  });

  // H7 (docs/schema-change-h7.md) — NARROWS the pre-H7 mechanical boundary.
  // Before H7, NONE of the bundle-producing/submitting modules (including
  // scan.ts) were allowed to reference proof-graph at all, because the
  // structural tier was entirely unwired. H7 deliberately wires it in, with
  // scan.ts as its single, documented integration point (see src/scan.ts's
  // own computeStructuralSkills comment) — so the boundary this test now
  // enforces is "everything EXCEPT scan.ts still never references
  // proof-graph", plus an explicit assertion that scan.ts's reference IS
  // there, so a future accidental removal (silently killing the structural
  // tier) or a future accidental SECOND integration point elsewhere (e.g.
  // build-bundle.ts also starting to read the graph directly) both get
  // caught by this same test. Source inspection (readFileSync of the real
  // files), same technique test/privacy/zero-network.test.ts already uses
  // for its network-API allowlist checks.
  it("only scan.ts, of the bundle-producing/submitting modules, references proof-graph — build-bundle/scan-command/submit/submit-command still never do", () => {
    const srcUrl = new URL("../../src/", import.meta.url);
    const neverReferences = ["build-bundle.ts", "scan-command.ts", "submit.ts", "submit-command.ts"];
    for (const file of neverReferences) {
      const contents = readFileSync(new URL(file, srcUrl), "utf8");
      expect(contents, `src/${file} must not reference "proof-graph"`).not.toContain("proof-graph");
    }
    const scanContents = readFileSync(new URL("scan.ts", srcUrl), "utf8");
    expect(scanContents, "src/scan.ts is the single documented proof-graph integration point (H7)").toContain(
      "proof-graph"
    );
  });

  /**
   * Strips `//` line comments and `/* *\/` block comments from TypeScript
   * source before pattern-matching it. Deliberately naive (no
   * string-literal awareness) — checked that none of src/proof-graph/*.ts
   * contains "//" or "/*" inside a string literal, so this is safe for the
   * sources this test actually reads today. Needed because
   * src/proof-graph/graph.ts and src/proof-graph/infer.ts each legitimately
   * DISCUSS "toJSON" in a comment, documenting that this exact
   * serialization surface must never be added — matching raw source would
   * flag that comment as a violation of the very invariant it documents.
   * Tightening the pattern (strip comments, then match) rather than
   * allowlisting those two files broadly keeps the assertion meaningful for
   * every other pattern in the list, and for any future file added to
   * src/proof-graph/.
   */
  function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  }

  // Principle: "never serialized to disk, never written to scan output"
  // (docs/proof-graph-spike.md's Invariants) — enforced one level deeper
  // than assertion 3 above: even if something in src/ ever did import
  // proof-graph code, the graph module itself has no serialization or
  // file-write primitive to call in the first place. JSON.parse is
  // allowed (reading taxonomy.json is legitimate, read-only, and not a
  // graph write); JSON.stringify, toJSON, and any file-write call are not.
  it("src/proof-graph/*.ts has no serialization or file-write surface outside comments documenting its absence", () => {
    const graphUrl = new URL("../../src/proof-graph/", import.meta.url);
    const files = readdirSync(graphUrl).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);

    const forbidden = ["toJSON", "JSON.stringify(", "writeFile", "createWriteStream", "appendFile"];
    for (const file of files) {
      const raw = readFileSync(new URL(file, graphUrl), "utf8");
      const code = stripComments(raw);
      for (const term of forbidden) {
        expect(code.includes(term), `src/proof-graph/${file} must not contain "${term}" outside a comment`).toBe(
          false
        );
      }
    }
  });
});
