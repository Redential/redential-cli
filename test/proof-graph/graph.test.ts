import { describe, expect, it } from "vitest";
import { TscParserAdapter } from "../../src/proof-graph/parser-adapter.js";
import { buildGraph } from "../../src/proof-graph/graph.js";
import type { ParsedFile } from "../../src/proof-graph/parser-adapter.js";

const adapter = new TscParserAdapter();

// Integration through the real adapter (per the milestone's test plan), not
// hand-built ParsedFile literals — a helper just to keep each test's parse
// call terse.
function parse(path: string, source: string): ParsedFile {
  return adapter.parse(path, source);
}

function callByChain(file: ParsedFile, chain: string) {
  const call = file.calls.find((c) => c.chain.join(".") === chain);
  if (!call) throw new Error(`test setup error: no call with chain "${chain}" in ${file.path}`);
  return call;
}

describe("buildGraph — import edges", () => {
  it("resolves a relative specifier through each of the five candidate forms", () => {
    const importer = parse(
      "src/importer.ts",
      [
        'import a from "./exact";',
        'import b from "./tsOnly";',
        'import c from "./tsxOnly";',
        'import d from "./dirTs";',
        'import e from "./dirTsx";',
      ].join("\n")
    );
    const exact = parse("src/exact", "export const x = 1;\n");
    const tsOnly = parse("src/tsOnly.ts", "export const x = 1;\n");
    const tsxOnly = parse("src/tsxOnly.tsx", "export const x = 1;\n");
    const dirTs = parse("src/dirTs/index.ts", "export const x = 1;\n");
    const dirTsx = parse("src/dirTsx/index.tsx", "export const x = 1;\n");

    const graph = buildGraph([importer, exact, tsOnly, tsxOnly, dirTs, dirTsx]);

    expect(graph.importEdgesOf("src/importer.ts")).toEqual([
      { specifier: "./exact", resolvedPath: "src/exact" },
      { specifier: "./tsOnly", resolvedPath: "src/tsOnly.ts" },
      { specifier: "./tsxOnly", resolvedPath: "src/tsxOnly.tsx" },
      { specifier: "./dirTs", resolvedPath: "src/dirTs/index.ts" },
      { specifier: "./dirTsx", resolvedPath: "src/dirTsx/index.tsx" },
    ]);
    // Same resolution is available as a standalone query, independent of an
    // existing ParsedImport.
    expect(graph.resolveImport("src/importer.ts", "./tsOnly")).toBe("src/tsOnly.ts");
  });

  it("resolves an unresolvable relative specifier to a null resolvedPath, still listed as an edge", () => {
    const importer = parse("src/a.ts", 'import x from "./missing";');
    const graph = buildGraph([importer]);

    expect(graph.importEdgesOf("src/a.ts")).toEqual([{ specifier: "./missing", resolvedPath: null }]);
    expect(graph.resolveImport("src/a.ts", "./missing")).toBeNull();
  });

  it("keeps a non-relative (external) specifier out of importEdgesOf but queryable via externalImportsOf", () => {
    const importer = parse("src/a.ts", 'import Stripe from "stripe";');
    const graph = buildGraph([importer]);

    expect(graph.importEdgesOf("src/a.ts")).toEqual([]);
    expect(graph.externalImportsOf("src/a.ts")).toEqual([
      { specifier: "stripe", bindings: [{ local: "Stripe", imported: "default", kind: "default" }] },
    ]);
  });

  // Named explicitly in the milestone goal: a real parser (unlike the
  // regex-based signature tier) never mistakes import-shaped TEXT inside a
  // comment or a string for an actual import — so there is nothing for the
  // graph to even consider an edge candidate.
  it("produces no import edges for import-shaped text that only appears inside a comment", () => {
    const importer = parse("src/a.ts", '// import Stripe from "./stripe-handler";\nconst x = 1;\n');
    const graph = buildGraph([importer]);

    expect(graph.importEdgesOf("src/a.ts")).toEqual([]);
    expect(graph.externalImportsOf("src/a.ts")).toEqual([]);
  });

  it("produces no import edges for import-shaped text inside a template literal", () => {
    const importer = parse("src/a.ts", 'const s = `import Stripe from "./stripe-handler";`;\n');
    const graph = buildGraph([importer]);

    expect(graph.importEdgesOf("src/a.ts")).toEqual([]);
  });
});

describe("buildGraph — contains (functions)", () => {
  it("returns a file's declared functions", () => {
    const file = parse(
      "src/a.ts",
      "export function handleWebhook() {}\nfunction helper() {}\n"
    );
    const graph = buildGraph([file]);

    expect(graph.files()).toEqual(["src/a.ts"]);
    expect(graph.functionsOf("src/a.ts").map((f) => f.name)).toEqual(["handleWebhook", "helper"]);
  });

  it("returns [] for functionsOf on an unknown path", () => {
    const graph = buildGraph([parse("src/a.ts", "function f() {}\n")]);
    expect(graph.functionsOf("src/does-not-exist.ts")).toEqual([]);
  });

  it("parsedFile returns the underlying ParsedFile, or undefined for an unknown path", () => {
    const file = parse("src/a.ts", "function f() {}\n");
    const graph = buildGraph([file]);

    expect(graph.parsedFile("src/a.ts")).toEqual(file);
    expect(graph.parsedFile("src/nope.ts")).toBeUndefined();
  });
});

describe("buildGraph — calls", () => {
  it("resolves a same-file call to a declared function (rule 1)", () => {
    const file = parse(
      "src/a.ts",
      "function helper() {\n  return 1;\n}\nfunction main() {\n  helper();\n}\n"
    );
    const graph = buildGraph([file]);

    const call = callByChain(file, "helper");
    expect(graph.resolveCallTargets("src/a.ts", call)).toEqual([{ path: "src/a.ts", name: "helper" }]);

    // callsFrom surfaces the same call by function-node identity.
    expect(graph.callsFrom({ path: "src/a.ts", name: "main" })).toEqual([call]);
  });

  it("resolves a cross-file call via a named import (rule 2)", () => {
    const userFile = parse(
      "src/user.ts",
      'import { helper } from "./helper";\nfunction main() {\n  helper();\n}\n'
    );
    const helperFile = parse("src/helper.ts", "export function helper() {\n  return 1;\n}\n");
    const graph = buildGraph([userFile, helperFile]);

    const call = callByChain(userFile, "helper");
    expect(graph.resolveCallTargets("src/user.ts", call)).toEqual([{ path: "src/helper.ts", name: "helper" }]);
  });

  it("resolves a cross-file call via a renamed named import (imported name wins, not the local alias)", () => {
    const userFile = parse(
      "src/user.ts",
      'import { helper as h } from "./helper";\nfunction main() {\n  h();\n}\n'
    );
    const helperFile = parse("src/helper.ts", "export function helper() {\n  return 1;\n}\n");
    const graph = buildGraph([userFile, helperFile]);

    const call = callByChain(userFile, "h");
    expect(graph.resolveCallTargets("src/user.ts", call)).toEqual([{ path: "src/helper.ts", name: "helper" }]);
  });

  it("resolves a cross-file call via a namespace import (rule 3)", () => {
    const userFile = parse(
      "src/user.ts",
      'import * as api from "./api";\nfunction main() {\n  api.fn();\n}\n'
    );
    const apiFile = parse("src/api.ts", "export function fn() {\n  return 1;\n}\n");
    const graph = buildGraph([userFile, apiFile]);

    const call = callByChain(userFile, "api.fn");
    expect(graph.resolveCallTargets("src/user.ts", call)).toEqual([{ path: "src/api.ts", name: "fn" }]);
  });

  it("returns [] for an unresolvable chain rather than guessing", () => {
    const userFile = parse("src/user.ts", "function main() {\n  something.notImported();\n}\n");
    const graph = buildGraph([userFile]);

    const call = callByChain(userFile, "something.notImported");
    expect(graph.resolveCallTargets("src/user.ts", call)).toEqual([]);
  });

  it("returns [] when the namespace's target function isn't declared in the resolved file", () => {
    const userFile = parse(
      "src/user.ts",
      'import * as api from "./api";\nfunction main() {\n  api.missing();\n}\n'
    );
    const apiFile = parse("src/api.ts", "export function fn() {\n  return 1;\n}\n");
    const graph = buildGraph([userFile, apiFile]);

    const call = callByChain(userFile, "api.missing");
    expect(graph.resolveCallTargets("src/user.ts", call)).toEqual([]);
  });

  it("returns [] for a member-access call off a default/named-imported binding (not a bare name)", () => {
    const userFile = parse(
      "src/user.ts",
      'import { stripe } from "./stripe-client";\nfunction main() {\n  stripe.webhooks.constructEvent();\n}\n'
    );
    const stripeFile = parse("src/stripe-client.ts", "export function stripe() {}\n");
    const graph = buildGraph([userFile, stripeFile]);

    const call = callByChain(userFile, "stripe.webhooks.constructEvent");
    expect(graph.resolveCallTargets("src/user.ts", call)).toEqual([]);
  });

  it("callsFrom returns module-level calls (enclosingFunction null) for { module: true }", () => {
    const file = parse("src/a.ts", "setup();\nfunction main() {\n  helper();\n}\n");
    const graph = buildGraph([file]);

    expect(graph.callsFrom({ path: "src/a.ts", module: true })).toEqual([callByChain(file, "setup")]);
  });

  it("callsFrom returns [] for an unknown path or unknown function name", () => {
    const file = parse("src/a.ts", "function main() {\n  helper();\n}\n");
    const graph = buildGraph([file]);

    expect(graph.callsFrom({ path: "src/does-not-exist.ts", module: true })).toEqual([]);
    expect(graph.callsFrom({ path: "src/a.ts", name: "notAFunction" })).toEqual([]);
  });
});

describe("buildGraph — determinism", () => {
  it("produces identical files() and edge/call query results regardless of input array order", () => {
    const a = parse("src/a.ts", 'import { helper } from "./helper";\nfunction main() {\n  helper();\n}\n');
    const b = parse("src/helper.ts", "export function helper() {\n  return 1;\n}\n");
    const c = parse("src/c.ts", 'import "stripe";\nfunction f() {}\n');

    const graph1 = buildGraph([a, b, c]);
    const graph2 = buildGraph([c, a, b]);
    const graph3 = buildGraph([b, c, a]);

    expect(graph1.files()).toEqual(graph2.files());
    expect(graph1.files()).toEqual(graph3.files());
    expect(graph1.files()).toEqual(["src/a.ts", "src/c.ts", "src/helper.ts"]);

    for (const graph of [graph2, graph3]) {
      expect(graph.importEdgesOf("src/a.ts")).toEqual(graph1.importEdgesOf("src/a.ts"));
      expect(graph.externalImportsOf("src/c.ts")).toEqual(graph1.externalImportsOf("src/c.ts"));
      const call = callByChain(a, "helper");
      expect(graph.resolveCallTargets("src/a.ts", call)).toEqual(graph1.resolveCallTargets("src/a.ts", call));
    }
  });
});
