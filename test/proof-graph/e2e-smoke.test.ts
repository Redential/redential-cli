import { describe, expect, it } from "vitest";
import { readHeadSnapshot } from "../../src/proof-graph/snapshot.js";
import { TscParserAdapter } from "../../src/proof-graph/parser-adapter.js";
import { buildGraph } from "../../src/proof-graph/graph.js";

// End-to-end smoke test for H1 of the proof-graph spike (see
// docs/proof-graph-spike.md): builds the graph of THIS repository's own HEAD
// commit — under vitest, process.cwd() is the repo root, and this repo is
// itself a real, non-trivial TypeScript ESM codebase (relative imports
// written with the ".js" runtime extension, per this repo's own
// package.json "type": "module" + tsconfig NodeNext setup), which makes it a
// good real-world stand-in for a user's repo without needing a programmatic
// fixture. Generous CI-safe bound (30s) — the real single-digit-second
// target is checked by the orchestrator reading the console.log'd number
// below, not asserted here, since CI runners are slower and noisier than a
// dev machine.
describe("proof-graph e2e smoke (this repo's own HEAD)", () => {
  it("snapshots, parses, and builds a graph of this repo within a generous time bound", async () => {
    const repoPath = process.cwd();
    const adapter = new TscParserAdapter();

    const start = performance.now();
    const snapshot = await readHeadSnapshot(repoPath);
    const parsed = snapshot.map((f) => adapter.parse(f.path, f.content));
    const graph = buildGraph(parsed);
    const elapsedMs = performance.now() - start;

    // eslint-disable-next-line no-console -- deliberate: this is the number
    // the milestone report reads to evaluate the spike's real-world
    // performance, not routine test noise.
    console.log(`[proof-graph e2e] snapshot+parse+build of ${graph.files().length} files: ${elapsedMs.toFixed(1)}ms`);

    expect(graph.files().length).toBeGreaterThan(20);
    expect(elapsedMs).toBeLessThan(30000);

    // At least one import edge must resolve somewhere in this repo. This
    // repo's own relative imports are written with a ".js"/".jsx" runtime
    // extension (TypeScript ESM convention — see graph.ts's
    // candidateSpecifiers doc comment) even though the file on disk is
    // ".ts"/".tsx"; without the ".js"-swap candidate this assertion would
    // fail on this exact repo, which is why that candidate exists.
    const anyResolved = graph
      .files()
      .some((path) => graph.importEdgesOf(path).some((edge) => edge.resolvedPath !== null));
    expect(anyResolved).toBe(true);
  }, 30000);
});
