import { describe, expect, it } from "vitest";
import { TscParserAdapter } from "../../src/proof-graph/parser-adapter.js";

const adapter = new TscParserAdapter();

describe("TscParserAdapter — imports", () => {
  it("extracts a default import", () => {
    const file = adapter.parse("a.ts", 'import Stripe from "stripe";');
    expect(file.imports).toEqual([
      { specifier: "stripe", bindings: [{ local: "Stripe", imported: "default", kind: "default" }] },
    ]);
  });

  it("extracts a named import", () => {
    const file = adapter.parse("a.ts", 'import { z } from "zod";');
    expect(file.imports).toEqual([
      { specifier: "zod", bindings: [{ local: "z", imported: "z", kind: "named" }] },
    ]);
  });

  it("extracts a named import with a rename (import { foo as bar })", () => {
    const file = adapter.parse("a.ts", 'import { foo as bar } from "./x";');
    expect(file.imports).toEqual([
      { specifier: "./x", bindings: [{ local: "bar", imported: "foo", kind: "named" }] },
    ]);
  });

  it("extracts a namespace import", () => {
    const file = adapter.parse("a.ts", 'import * as path from "node:path";');
    expect(file.imports).toEqual([
      { specifier: "node:path", bindings: [{ local: "path", imported: "*", kind: "namespace" }] },
    ]);
  });

  it("extracts a side-effect import with no bindings", () => {
    const file = adapter.parse("a.ts", 'import "reflect-metadata";');
    expect(file.imports).toEqual([{ specifier: "reflect-metadata", bindings: [] }]);
  });

  it("extracts a multi-line named import list, preserving specifier verbatim", () => {
    const source = 'import {\n  foo,\n  bar,\n} from "../x";\n';
    const file = adapter.parse("a.ts", source);
    expect(file.imports).toEqual([
      {
        specifier: "../x",
        bindings: [
          { local: "foo", imported: "foo", kind: "named" },
          { local: "bar", imported: "bar", kind: "named" },
        ],
      },
    ]);
  });

  it("extracts a default + named combined import", () => {
    const file = adapter.parse("a.ts", 'import Stripe, { Webhooks } from "stripe";');
    expect(file.imports).toEqual([
      {
        specifier: "stripe",
        bindings: [
          { local: "Stripe", imported: "default", kind: "default" },
          { local: "Webhooks", imported: "Webhooks", kind: "named" },
        ],
      },
    ]);
  });

  // The headline advantage over the regex tier (see import-detect.ts):
  // real parsing means import-shaped TEXT that isn't actually an import
  // produces nothing at all, with no near-miss handling required.
  it("does not treat import-shaped text inside a // comment as an import", () => {
    const file = adapter.parse("a.ts", '// import Stripe from "stripe";\nconst x = 1;');
    expect(file.imports).toEqual([]);
  });

  it("does not treat import-shaped text inside a block comment as an import", () => {
    const file = adapter.parse("a.ts", '/* import Stripe from "stripe"; */\nconst x = 1;');
    expect(file.imports).toEqual([]);
  });

  it("does not treat import-shaped text inside a template literal as an import", () => {
    const file = adapter.parse("a.ts", 'const s = `import Stripe from "stripe";`;');
    expect(file.imports).toEqual([]);
  });

  it("does not treat import-shaped text inside a multi-line template literal as an import", () => {
    const file = adapter.parse("a.ts", "const s = `\nimport Stripe from 'stripe';\n`;\nconst x = 1;");
    expect(file.imports).toEqual([]);
  });
});

describe("TscParserAdapter — functions", () => {
  it("records a named function declaration as not exported", () => {
    const file = adapter.parse("a.ts", "function handleWebhook() {}\n");
    expect(file.functions).toEqual([{ name: "handleWebhook", span: { startLine: 1, endLine: 1 }, exported: false }]);
  });

  it("records an exported function declaration", () => {
    const file = adapter.parse("a.ts", "export function handleWebhook() {}\n");
    expect(file.functions).toEqual([{ name: "handleWebhook", span: { startLine: 1, endLine: 1 }, exported: true }]);
  });

  it("records a class method as ClassName.method", () => {
    const source = "class Handler {\n  process() {\n    return 1;\n  }\n}\n";
    const file = adapter.parse("a.ts", source);
    expect(file.functions).toEqual([{ name: "Handler.process", span: { startLine: 2, endLine: 4 }, exported: false }]);
  });

  it("marks a method exported when its class is exported", () => {
    const source = "export class Handler {\n  process() {}\n}\n";
    const file = adapter.parse("a.ts", source);
    expect(file.functions).toEqual([{ name: "Handler.process", span: { startLine: 2, endLine: 2 }, exported: true }]);
  });

  it("records an arrow function assigned to a const, using the const's name", () => {
    const file = adapter.parse("a.ts", "const handleWebhook = (req) => {\n  return req;\n};\n");
    expect(file.functions).toEqual([
      { name: "handleWebhook", span: { startLine: 1, endLine: 3 }, exported: false },
    ]);
  });

  it("marks an exported const arrow function as exported", () => {
    const file = adapter.parse("a.ts", "export const handleWebhook = (req) => req;\n");
    expect(file.functions).toEqual([
      { name: "handleWebhook", span: { startLine: 1, endLine: 1 }, exported: true },
    ]);
  });

  it("names a truly anonymous function expression by its start line", () => {
    const file = adapter.parse("a.ts", "arr.map(function (x) {\n  return x;\n});\n");
    expect(file.functions).toEqual([
      { name: "<anonymous:L1>", span: { startLine: 1, endLine: 3 }, exported: false },
    ]);
  });

  it("names a truly anonymous arrow callback by its start line", () => {
    const file = adapter.parse("a.ts", "arr.map((x) => x + 1);\n");
    expect(file.functions).toEqual([
      { name: "<anonymous:L1>", span: { startLine: 1, endLine: 1 }, exported: false },
    ]);
  });

  it("collects nested function declarations independently, in source order", () => {
    const source = "function outer() {\n  function inner() {}\n  return inner;\n}\n";
    const file = adapter.parse("a.ts", source);
    expect(file.functions.map((f) => f.name)).toEqual(["outer", "inner"]);
  });
});

describe("TscParserAdapter — calls", () => {
  it("resolves a bare call at module top level", () => {
    const file = adapter.parse("a.ts", "f();\n");
    expect(file.calls).toEqual([{ chain: ["f"], line: 1, enclosingFunction: null }]);
  });

  it("resolves a nested member chain call", () => {
    const file = adapter.parse("a.ts", "stripe.webhooks.constructEvent(body, sig, secret);\n");
    expect(file.calls).toEqual([
      { chain: ["stripe", "webhooks", "constructEvent"], line: 1, enclosingFunction: null },
    ]);
  });

  it("resolves computed member access as a '*' segment", () => {
    const file = adapter.parse("a.ts", "obj[key]();\n");
    expect(file.calls).toEqual([{ chain: ["obj", "*"], line: 1, enclosingFunction: null }]);
  });

  it("attributes a call inside a function declaration to that function's name", () => {
    const source = "function handleWebhook() {\n  stripe.webhooks.constructEvent();\n}\n";
    const file = adapter.parse("a.ts", source);
    expect(file.calls).toEqual([
      { chain: ["stripe", "webhooks", "constructEvent"], line: 2, enclosingFunction: "handleWebhook" },
    ]);
  });

  it("attributes a call inside a method to ClassName.method", () => {
    const source = "class Handler {\n  process() {\n    db.write();\n  }\n}\n";
    const file = adapter.parse("a.ts", source);
    expect(file.calls).toEqual([{ chain: ["db", "write"], line: 3, enclosingFunction: "Handler.process" }]);
  });

  it("attributes a call inside a nested arrow to the innermost enclosing function", () => {
    const source = "function outer() {\n  arr.forEach((x) => {\n    db.write(x);\n  });\n}\n";
    const file = adapter.parse("a.ts", source);
    const write = file.calls.find((c) => c.chain.join(".") === "db.write");
    expect(write?.enclosingFunction).toBe("<anonymous:L2>");
  });
});

describe("TscParserAdapter — bindings", () => {
  it("records a 'new' binding source", () => {
    const file = adapter.parse("a.ts", 'const stripe = new Stripe("sk_test");\n');
    expect(file.bindings).toEqual([{ name: "stripe", source: { kind: "new", chain: ["Stripe"] } }]);
  });

  it("records a 'call' binding source for a bare call", () => {
    const file = adapter.parse("a.ts", "const db = createClient();\n");
    expect(file.bindings).toEqual([{ name: "db", source: { kind: "call", chain: ["createClient"] } }]);
  });

  it("records a 'call' binding source for a member-chain call", () => {
    const file = adapter.parse("a.ts", "const c = a.b();\n");
    expect(file.bindings).toEqual([{ name: "c", source: { kind: "call", chain: ["a", "b"] } }]);
  });

  it("records an 'alias' binding source for plain property aliasing", () => {
    const file = adapter.parse("a.ts", "const w = stripe.webhooks;\n");
    expect(file.bindings).toEqual([{ name: "w", source: { kind: "alias", chain: ["stripe", "webhooks"] } }]);
  });

  it("does not record a binding for a plain literal initializer", () => {
    const file = adapter.parse("a.ts", 'const n = 5;\nconst s = "x";\n');
    expect(file.bindings).toEqual([]);
  });

  it("does not record a binding for a destructuring declaration", () => {
    const file = adapter.parse("a.ts", "const { a, b } = something();\n");
    expect(file.bindings).toEqual([]);
  });
});

describe("TscParserAdapter — .tsx parsing", () => {
  it("parses JSX syntax in a .tsx file without throwing and still extracts calls", () => {
    const source =
      'import React from "react";\nexport function Widget() {\n  onClick();\n  return <div className="x">hi</div>;\n}\n';
    const file = adapter.parse("a.tsx", source);
    expect(file.imports).toEqual([
      { specifier: "react", bindings: [{ local: "React", imported: "default", kind: "default" }] },
    ]);
    expect(file.functions).toEqual([{ name: "Widget", span: { startLine: 2, endLine: 5 }, exported: true }]);
    expect(file.calls).toEqual([{ chain: ["onClick"], line: 3, enclosingFunction: "Widget" }]);
  });

  it("would misparse the same generic-call-like syntax as a .ts file (sanity check that scriptKind matters)", () => {
    // `<div>` is only valid as JSX under ScriptKind.TSX; parsing the exact
    // same source as plain .ts hits a real syntax error and must degrade to
    // an empty ParsedFile rather than throwing — this is the direct proof
    // that TscParserAdapter picks ScriptKind by file extension.
    const source = "function Widget() {\n  return <div>hi</div>;\n}\n";
    const file = adapter.parse("a.ts", source);
    expect(file).toEqual({ path: "a.ts", imports: [], functions: [], calls: [], bindings: [] });
  });
});

describe("TscParserAdapter — malformed source", () => {
  it("returns an empty ParsedFile for unparseable source, without throwing", () => {
    expect(() => adapter.parse("a.ts", "function foo( { [[[ ===")).not.toThrow();
    const file = adapter.parse("a.ts", "function foo( { [[[ ===");
    expect(file).toEqual({ path: "a.ts", imports: [], functions: [], calls: [], bindings: [] });
  });

  it("returns an empty ParsedFile for an unclosed block", () => {
    const file = adapter.parse("a.ts", "function foo() {\n  const x = 1;\n");
    expect(file).toEqual({ path: "a.ts", imports: [], functions: [], calls: [], bindings: [] });
  });

  it("is deterministic: the same malformed input returns an equal (empty) result every time", () => {
    const source = "function foo( { [[[ ===";
    expect(adapter.parse("a.ts", source)).toEqual(adapter.parse("a.ts", source));
  });
});

describe("TscParserAdapter — determinism", () => {
  it("returns an equal (deep) result for the same valid input parsed twice", () => {
    const source =
      'import Stripe from "stripe";\nexport function handleWebhook() {\n  const stripe = new Stripe("k");\n  stripe.webhooks.constructEvent();\n}\n';
    expect(adapter.parse("a.ts", source)).toEqual(adapter.parse("a.ts", source));
  });
});
