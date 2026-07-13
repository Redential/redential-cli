// H1 of the proof-graph spike (see docs/proof-graph-spike.md): wraps the
// TypeScript compiler API in a narrow ParserAdapter so the rest of the spike
// (graph builder, recognizers) never imports `typescript` directly — the
// dependency stays behind one seam, exactly like import-detect.ts hides its
// per-language regex tables behind extractImportedPackages. That seam is
// also what makes the spike's tree-sitter option (see "Approved decisions"
// in the doc) a swap of this one file, not a rewrite.
//
// PARSE-ONLY, deliberately: ts.createSourceFile + a plain AST walk. No
// ts.createProgram, no type-checker, no ts.sys filesystem access — the
// adapter never touches disk or network itself, only the source text it's
// handed. That keeps it inside the spike's "zero network, in-memory only"
// invariants and avoids the cost (and surface area) of a full program: this
// is syntactic structure, not semantic resolution, by design (see the
// spike doc's Exclusions).
import ts from "typescript";

export interface SourceSpan {
  startLine: number; // 1-based, inclusive
  endLine: number; // 1-based, inclusive
}

export type ImportBindingKind = "default" | "named" | "namespace" | "side-effect";

export interface ParsedImport {
  specifier: string; // exactly as written: "./db", "../x", "stripe", "node:path"
  bindings: { local: string; imported: string; kind: ImportBindingKind }[]; // [] for side-effect imports
}

export interface ParsedFunction {
  // "fnName"; methods as "ClassName.method"; anonymous/arrow assigned to a
  // const uses the const name; truly anonymous -> "<anonymous:L<line>>".
  name: string;
  span: SourceSpan;
  exported: boolean;
}

export interface ParsedCall {
  // Receiver chain left-to-right, e.g. stripe.webhooks.constructEvent(...)
  // -> ["stripe","webhooks","constructEvent"]; computed access obj[x]() ->
  // "*" for that segment; bare call f() -> ["f"].
  chain: string[];
  line: number; // 1-based
  enclosingFunction: string | null; // ParsedFunction.name of the innermost enclosing declared function, or null at module top level
}

export type BindingSource =
  | { kind: "new"; chain: string[] } // const stripe = new Stripe(...) -> chain ["Stripe"]
  | { kind: "call"; chain: string[] } // const db = createClient(...) -> ["createClient"]; const c = a.b(...) -> ["a","b"]
  | { kind: "alias"; chain: string[] }; // const w = stripe.webhooks -> ["stripe","webhooks"]

export interface ParsedBinding {
  name: string;
  source: BindingSource;
} // same-file const/let/var bindings only

export interface ParsedFile {
  path: string;
  imports: ParsedImport[];
  functions: ParsedFunction[];
  calls: ParsedCall[];
  bindings: ParsedBinding[];
}

export interface ParserAdapter {
  parse(path: string, source: string): ParsedFile;
}

function emptyParsedFile(path: string): ParsedFile {
  return { path, imports: [], functions: [], calls: [], bindings: [] };
}

// The four syntax kinds the spike treats as a "declared function" — the
// unit both `functions` entries and `enclosingFunction` attribution are
// built from. Get/set accessors and constructors are deliberately NOT
// included: the spike's one recognizer target (webhook handler -> DB write
// -> idempotency guard, see the spike doc) never needs them, and every
// exclusion here is one less shape the naming rules below have to define
// behavior for.
type FunctionLikeNode = ts.FunctionDeclaration | ts.MethodDeclaration | ts.FunctionExpression | ts.ArrowFunction;

function isFunctionLikeNode(node: ts.Node): node is FunctionLikeNode {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node)
  );
}

function lineOf(sourceFile: ts.SourceFile, pos: number): number {
  return sourceFile.getLineAndCharacterOfPosition(pos).line + 1; // ts positions are 0-based
}

function spanOf(node: ts.Node, sourceFile: ts.SourceFile): SourceSpan {
  return {
    startLine: lineOf(sourceFile, node.getStart(sourceFile)),
    endLine: lineOf(sourceFile, node.getEnd()),
  };
}

function anonymousName(node: ts.Node, sourceFile: ts.SourceFile): string {
  return `<anonymous:L${lineOf(sourceFile, node.getStart(sourceFile))}>`;
}

function hasExportModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  const modifiers = ts.getModifiers(node);
  return !!modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

// A node "IS" the const/let/var it's assigned to only when it sits directly
// as that declaration's initializer with a plain identifier name (not a
// destructuring pattern — the spike doesn't track those, see ParsedBinding's
// contract). Shared by the arrow/function-expression naming rule below and
// by an anonymous class expression picking up its const's name the same way.
function assignedIdentifierName(node: ts.Node): string | undefined {
  const parent = node.parent;
  if (parent && ts.isVariableDeclaration(parent) && parent.initializer === node && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  return undefined;
}

function nearestClassAncestor(node: ts.Node): ts.ClassLikeDeclaration | undefined {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (ts.isClassDeclaration(cur) || ts.isClassExpression(cur)) return cur;
    cur = cur.parent;
  }
  return undefined;
}

function classDisplayName(cls: ts.ClassLikeDeclaration): string {
  if (cls.name) return cls.name.text;
  return assignedIdentifierName(cls) ?? "<anonymous class>";
}

function methodPropertyName(node: ts.MethodDeclaration): string {
  const name = node.name;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  // Computed method name (e.g. `[Symbol.iterator]()`, `[dynamicKey]()`) —
  // same "*" wildcard convention as computed member access in chainOf,
  // since neither can be resolved without evaluating the expression.
  return "*";
}

// `export default <expr>;` is an ExportAssignment node, not a
// VariableStatement — an anonymous arrow/function-expression exported this
// way (`export default () => {}`) is exported but has no assigned name at
// all, so it still falls through to the anonymous-name rule below.
function isExportDefaultExpression(node: ts.Node): boolean {
  const parent = node.parent;
  return !!parent && ts.isExportAssignment(parent) && !parent.isExportEquals && parent.expression === node;
}

// Single source of truth for a ParsedFunction's derived fields — called both
// while building the `functions` array and (for the innermost enclosing
// function-like ancestor of a call) while building `enclosingFunction`, so
// the two can never disagree on what a given node is named.
function describeFunctionLike(node: FunctionLikeNode, sourceFile: ts.SourceFile): ParsedFunction {
  const span = spanOf(node, sourceFile);
  if (ts.isFunctionDeclaration(node)) {
    const name = node.name ? node.name.text : anonymousName(node, sourceFile);
    return { name, span, exported: hasExportModifier(node) };
  }
  if (ts.isMethodDeclaration(node)) {
    const cls = nearestClassAncestor(node);
    const className = cls ? classDisplayName(cls) : "<anonymous class>";
    // A method's export status isn't its own — it rides on whether the
    // enclosing class declaration is exported (a method has no modifier of
    // its own that means "exported").
    const exported = !!cls && hasExportModifier(cls);
    return { name: `${className}.${methodPropertyName(node)}`, span, exported };
  }
  // FunctionExpression | ArrowFunction
  const ownName = ts.isFunctionExpression(node) && node.name ? node.name.text : undefined;
  const assignedName = assignedIdentifierName(node);
  let exported = isExportDefaultExpression(node);
  if (!exported && assignedName) {
    // `export const foo = () => {}` — the export modifier lives on the
    // enclosing VariableStatement (VariableDeclaration -> its parent
    // VariableDeclarationList -> ITS parent VariableStatement), not on the
    // arrow/function-expression node itself.
    const declList = node.parent?.parent;
    const varStatement = declList?.parent;
    exported = !!varStatement && ts.isVariableStatement(varStatement) && hasExportModifier(varStatement);
  }
  const name = ownName ?? assignedName ?? anonymousName(node, sourceFile);
  return { name, span, exported };
}

function enclosingFunctionName(node: ts.Node, sourceFile: ts.SourceFile): string | null {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (isFunctionLikeNode(cur)) return describeFunctionLike(cur, sourceFile).name;
    cur = cur.parent;
  }
  return null; // module top level
}

// Walks a receiver expression into a left-to-right chain of names. Only
// Identifier / `this` / property access / element access are resolvable
// syntactically (no type-checker, per this adapter's parse-only contract):
// anything else (a call result, a parenthesized/conditional expression, ...)
// isn't a name at all, so it becomes a single "*" segment — same convention
// element access uses for a computed key — rather than inventing one.
function chainOf(expr: ts.Expression): string[] {
  if (ts.isIdentifier(expr)) return [expr.text];
  if (expr.kind === ts.SyntaxKind.ThisKeyword) return ["this"];
  if (ts.isPropertyAccessExpression(expr)) return [...chainOf(expr.expression), expr.name.text];
  if (ts.isElementAccessExpression(expr)) return [...chainOf(expr.expression), "*"];
  return ["*"];
}

function toImport(node: ts.ImportDeclaration): ParsedImport | null {
  if (!ts.isStringLiteralLike(node.moduleSpecifier)) return null; // not reachable from valid syntax; defensive only
  const specifier = node.moduleSpecifier.text;
  const clause = node.importClause;
  if (!clause) return { specifier, bindings: [] }; // `import "foo";` — side-effect only

  const bindings: ParsedImport["bindings"] = [];
  if (clause.name) {
    bindings.push({ local: clause.name.text, imported: "default", kind: "default" });
  }
  const named = clause.namedBindings;
  if (named && ts.isNamespaceImport(named)) {
    bindings.push({ local: named.name.text, imported: "*", kind: "namespace" });
  } else if (named && ts.isNamedImports(named)) {
    for (const el of named.elements) {
      // `import { foo as bar }` -> propertyName is the exported name
      // ("foo"), name is the local binding ("bar"); a plain `import { foo }`
      // has no propertyName, so the imported name IS the local name.
      const imported = (el.propertyName ?? el.name).text;
      bindings.push({ local: el.name.text, imported, kind: "named" });
    }
  }
  return { specifier, bindings };
}

function toCall(node: ts.CallExpression, sourceFile: ts.SourceFile): ParsedCall {
  return {
    chain: chainOf(node.expression),
    line: lineOf(sourceFile, node.getStart(sourceFile)),
    enclosingFunction: enclosingFunctionName(node, sourceFile),
  };
}

function toBinding(decl: ts.VariableDeclaration): ParsedBinding | null {
  if (!ts.isIdentifier(decl.name) || !decl.initializer) return null; // destructuring / no initializer: not tracked
  const init = decl.initializer;
  if (ts.isNewExpression(init)) {
    return { name: decl.name.text, source: { kind: "new", chain: chainOf(init.expression) } };
  }
  if (ts.isCallExpression(init)) {
    return { name: decl.name.text, source: { kind: "call", chain: chainOf(init.expression) } };
  }
  if (ts.isPropertyAccessExpression(init) || ts.isElementAccessExpression(init)) {
    // Plain aliasing (no call): the WHOLE initializer expression is the
    // chain, unlike the "new"/"call" cases above where only the callee
    // (init.expression) is — there's no trailing call to strip here.
    return { name: decl.name.text, source: { kind: "alias", chain: chainOf(init) } };
  }
  return null; // any other initializer shape (literal, JSX, other expression, ...) isn't a tracked binding source
}

function collectNodes(sourceFile: ts.SourceFile): {
  importNodes: ts.ImportDeclaration[];
  functionNodes: FunctionLikeNode[];
  callNodes: ts.CallExpression[];
  varDecls: ts.VariableDeclaration[];
} {
  const importNodes: ts.ImportDeclaration[] = [];
  const functionNodes: FunctionLikeNode[] = [];
  const callNodes: ts.CallExpression[] = [];
  const varDecls: ts.VariableDeclaration[] = [];

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node)) importNodes.push(node);
    else if (isFunctionLikeNode(node)) functionNodes.push(node);
    else if (ts.isCallExpression(node)) callNodes.push(node);
    else if (ts.isVariableDeclaration(node)) varDecls.push(node);
    // Recurse into every node's children regardless of which branch above
    // matched — e.g. a function-like node's own body still needs walking for
    // nested calls/functions, and a call expression's arguments can contain
    // further nested calls or function expressions.
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return { importNodes, functionNodes, callNodes, varDecls };
}

// `ts.forEachChild` already visits children in source order, so the arrays
// above come out ordered in practice — but sorting explicitly by start
// offset makes "stable ordering by source position" a guarantee of this
// function's own logic rather than an incidental property of the traversal,
// so it can't silently regress if the traversal implementation changes.
function bySourcePosition<T extends ts.Node>(nodes: T[], sourceFile: ts.SourceFile): T[] {
  return [...nodes].sort((a, b) => a.getStart(sourceFile) - b.getStart(sourceFile));
}

function buildParsedFile(path: string, sourceFile: ts.SourceFile): ParsedFile {
  const { importNodes, functionNodes, callNodes, varDecls } = collectNodes(sourceFile);
  const imports = bySourcePosition(importNodes, sourceFile)
    .map(toImport)
    .filter((x): x is ParsedImport => x !== null);
  const functions = bySourcePosition(functionNodes, sourceFile).map((n) => describeFunctionLike(n, sourceFile));
  const calls = bySourcePosition(callNodes, sourceFile).map((n) => toCall(n, sourceFile));
  const bindings = bySourcePosition(varDecls, sourceFile)
    .map(toBinding)
    .filter((x): x is ParsedBinding => x !== null);
  return { path, imports, functions, calls, bindings };
}

export class TscParserAdapter implements ParserAdapter {
  parse(path: string, source: string): ParsedFile {
    const scriptKind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    let sourceFile: ts.SourceFile;
    try {
      // setParentNodes = true: every downstream helper above (nearest class
      // ancestor, innermost enclosing function, "is this the initializer of
      // a const") walks UP via node.parent, which only exists when this
      // flag is on. Still parse-only — parent pointers come from the parser
      // itself, not from a Program/binder/type-checker.
      sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, scriptKind);
    } catch {
      return emptyParsedFile(path); // defensive: createSourceFile itself doesn't throw in practice, but never let a parse failure propagate
    }

    // `parseDiagnostics` is how the parser's own output (NOT a Program or
    // the type-checker — still inside this adapter's parse-only boundary)
    // surfaces "this couldn't be parsed cleanly." It's an internal
    // (undocumented) field, but reading it here is the only way to
    // distinguish "genuinely malformed input" from "valid syntax this
    // adapter simply doesn't model" without a full Program. On any
    // diagnostic, degrade to a fully empty ParsedFile per this adapter's
    // contract — never a throw, never a partial/best-effort result that
    // downstream code might mistake for a complete parse.
    const diagnostics = (sourceFile as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics;
    if (diagnostics && diagnostics.length > 0) return emptyParsedFile(path);

    try {
      return buildParsedFile(path, sourceFile);
    } catch {
      // Any AST shape this adapter doesn't model (or a future TS syntax
      // form) degrades to "nothing detected" rather than crashing the
      // caller — the same fail-open posture as import-detect.ts's
      // language extractors.
      return emptyParsedFile(path);
    }
  }
}
