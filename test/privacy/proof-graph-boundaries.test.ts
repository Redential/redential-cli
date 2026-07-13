// H3 of the proof-graph spike (see docs/proof-graph-spike.md): the privacy
// boundary test proving the spike's central "in-memory only" invariant —
// the proof graph is built and walked entirely in memory for the duration
// of the process and NEVER reaches `scan`'s output, the bundle, or disk.
// Every principle here has the same status as the rest of test/privacy/
// (docs/principles.md: "If a change breaks one of these tests, the change
// is wrong — not the test") even though the spike itself ships nothing on
// `main` yet — the whole point of writing this now, before any go decision,
// is that the boundary is provably true from H1 onward, not asserted after
// the fact once the signal is tempting to wire in.
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
import { fixtureDirectPattern, USER } from "../proof-graph/fixtures.js";
import { runScan } from "../../src/scan.js";
import type { Bundle } from "../../src/types.js";

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
  // drive it with. The proof-graph modules are never invoked by runScan
  // today (that's exactly what assertion 3 below proves mechanically) —
  // this call exists so assertion 1/2 prove the CURRENT bundle contract,
  // over a repo that structurally contains the full webhook pattern, is
  // already clean of graph vocabulary.
  bundle = await runScan({
    repoPath: dir,
    authors: [USER.email],
    confirmed: true,
    toolVersion: "0.1.0",
    configDir,
  });
  bundleJson = JSON.stringify(bundle);
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
    // fields (confidence/attributed/claimed/edgeDistance/anchors),
    // src/proof-graph/anchors.ts's Stripe signature-verification call shape
    // (constructEvent/stripe-signature), and the module's own name
    // (proof-graph). Hardcoded rather than derived from the fixture because
    // these are the GRAPH MODULE's own terms, not fixture file content —
    // they wouldn't be caught by the file/function-name extraction above,
    // and they are exactly the field names docs/proof-graph-spike.md's
    // "Draft bundle signal" section proposes for a FUTURE bundle version
    // that does not exist today.
    const graphVocabulary = [
      "anchors",
      "edgeDistance",
      "confidence",
      "attributed",
      "claimed",
      "constructEvent",
      "stripe-signature",
      "proof-graph",
    ];
    for (const term of graphVocabulary) {
      expect(bundleJson, `bundle must not contain graph vocabulary "${term}"`).not.toContain(term);
    }
  });

  // Principle: "The structural signal stays OUT of the bundle for the whole
  // spike" (docs/proof-graph-spike.md's Approved decisions #2) — the
  // structural slug must never appear in a real bundle at any point during
  // the spike, full stop, regardless of what the (never-wired-in) graph
  // pipeline would classify. The positive control (payments/stripe DOES
  // appear) is what makes the negative assertion meaningful: it proves this
  // scan actually looked at, and detected skills in, this exact fixture
  // repo — a negative assertion against an empty/no-op scan would prove
  // nothing.
  it("the structural slug never enters the bundle; the plain import-tier slug (positive control) does", () => {
    expect(bundleJson).not.toContain("payments/payment-webhook-flow");
    expect(bundle.detected_skills.map((s) => s.slug)).toContain("payments/stripe");
  });

  // Principle: the boundary is structural, not incidental — the modules
  // that build and emit the bundle (scan.ts, build-bundle.ts,
  // scan-command.ts) and the modules that ship it over the network
  // (submit.ts, submit-command.ts) must not even IMPORT or REFERENCE the
  // proof-graph module, so a future refactor can't accidentally start
  // threading graph output into the bundle without this test catching the
  // very first `import ... from "./proof-graph/...")` line that would make
  // it possible. Source inspection (readFileSync of the real files), same
  // technique test/privacy/zero-network.test.ts already uses for its
  // network-API allowlist checks — this repo has no source-inspection
  // privacy test for proof-graph specifically, so this is the first one.
  it("bundle-producing/submitting modules never reference proof-graph (no import, no mention)", () => {
    const srcUrl = new URL("../../src/", import.meta.url);
    const boundaryFiles = ["scan.ts", "build-bundle.ts", "scan-command.ts", "submit.ts", "submit-command.ts"];
    for (const file of boundaryFiles) {
      const contents = readFileSync(new URL(file, srcUrl), "utf8");
      expect(contents, `src/${file} must not reference "proof-graph"`).not.toContain("proof-graph");
    }
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
