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
  // String-literal arguments passed DIRECTLY to this call (not nested inside
  // another expression) — a plain string literal or a template literal
  // WITHOUT substitutions (a template WITH substitutions, e.g. `INSERT
  // ${x}`, has no single static text and is deliberately not captured here;
  // see H2's anchors.ts for the documented consequence). Added for H2 (see
  // docs/proof-graph-spike.md): the db-write recognizer needs to see
  // `pool.query("INSERT ...")`'s literal text, which chain/line alone can't
  // give it. Each entry capped at ARG_STRING_MAX_CHARS; longer strings are
  // truncated (kept, not dropped) since even a truncated prefix is still
  // useful for an `/^\s*insert\b/i`-style match.
  stringArgs: string[];
  // Top-level property names of any object-literal argument passed directly
  // to this call, e.g. `f({ idempotencyKey: x })` -> ["idempotencyKey"].
  // Only identifier or string-literal keys are recorded (computed keys
  // aren't a static name without evaluation, same posture as chainOf's "*"
  // for computed member access — but here there's no fixed-arity slot to
  // fill with a placeholder, so a computed key is simply omitted rather than
  // represented). Spread properties (`{ ...rest }`) contribute no name of
  // their own and are skipped. Added for H2's idempotency-guard recognizer
  // (`{ idempotencyKey: ... }`).
  argPropertyNames: string[];
  // Numeric-literal arguments passed DIRECTLY to this call, e.g.
  // `res.status(401)` -> [401]. Added for the auth-flows milestone (issue
  // #5: auth/session-flow, auth/oauth-flow, auth/jwt-refresh-flow), whose
  // route-guard / guard-response anchors are defined as the ACCESS DECISION
  // a handler makes — "redirect, 401/403, or early return". For the status
  // shape the CODE is the entire signal: `res.status(401)` and
  // `res.status(200)` are syntactically identical apart from that number,
  // so without it a recognizer could only claim "some status was set",
  // which is decoration rather than a guard — precisely what that issue's
  // honesty rule ("the verification anchor must be real verification, not
  // decoration") rules out.
  //
  // Mirrors stringArgs exactly in scope: direct arguments only, never
  // nested inside another expression. A NEGATED literal (`-1`) is a
  // PrefixUnaryExpression, not a NumericLiteral, and is deliberately not
  // captured — no HTTP status code is negative, so representing it would
  // add a shape with no consumer.
  numberArgs: number[];
}

// String-literal call arguments are capped at 200 chars (truncated, not
// dropped) — long enough to hold a realistic SQL statement or similar, short
// enough to keep the in-memory graph bounded regardless of how large a
// literal a user's source happens to contain.
const ARG_STRING_MAX_CHARS = 200;

// File-wide literals (ParsedFile.literals, below) use a tighter cap: they
// exist to catch short marker-like strings (header names, event-type
// strings) a recognizer checks for PRESENCE of, not content to pattern-match
// — a literal longer than this is prose/data, not a marker, and is skipped
// entirely (not truncated) so a truncated prefix of a long string can never
// accidentally collide with a short marker literal.
const FILE_LITERAL_MAX_CHARS = 100;

export type BindingSource =
  | { kind: "new"; chain: string[] } // const stripe = new Stripe(...) -> chain ["Stripe"]
  | { kind: "call"; chain: string[] } // const db = createClient(...) -> ["createClient"]; const c = a.b(...) -> ["a","b"]
  | { kind: "alias"; chain: string[] }; // const w = stripe.webhooks -> ["stripe","webhooks"]

export interface ParsedBinding {
  name: string;
  source: BindingSource;
} // same-file const/let/var bindings only

// A single string-literal occurrence anywhere in the file (not just inside
// a call argument) — see ParsedFile.literals below for why this exists
// alongside ParsedCall.stringArgs.
export interface ParsedLiteral {
  value: string; // truncation never applies here — anything over FILE_LITERAL_MAX_CHARS is skipped entirely, not truncated
  line: number; // 1-based
  enclosingFunction: string | null; // same convention as ParsedCall.enclosingFunction
}

// A bare property/element-access chain that is neither a call's callee (see
// ParsedCall) nor nested inside a larger access chain — e.g. the
// `customerInfo.entitlements.active['pro']` in
// `if (customerInfo.entitlements.active['pro']) { ... }`, chain
// ["customerInfo","entitlements","active","*"]. Added to close a gap
// iapEntitlementGateHits' own comment (anchors.ts) used to document as
// accepted spike scope: a call-only recognizer can't see the single most
// idiomatic RevenueCat read shape, since it's a MemberExpression/
// ElementAccessExpression, not a CallExpression, and never reaches
// ParsedCall at all. Deliberately only the OUTERMOST access node of each
// chain is recorded (see collectNodes' isMaximalAccessNode) — walking every
// nested sub-expression too would produce one redundant entry per segment
// (`a.b`, `a.b.c`, `a.b.c.d` for a single `a.b.c.d` read) with no consumer
// that wants the partial chains.
export interface ParsedAccess {
  chain: string[]; // same chainOf() convention as ParsedCall.chain
  line: number; // 1-based
  enclosingFunction: string | null; // same convention as ParsedCall.enclosingFunction
}

export interface ParsedFile {
  path: string;
  imports: ParsedImport[];
  functions: ParsedFunction[];
  calls: ParsedCall[];
  bindings: ParsedBinding[];
  accesses: ParsedAccess[];
  // Every string literal (plain or no-substitution template) in the file
  // whose text is at most FILE_LITERAL_MAX_CHARS long. Added for H2: a
  // recognizer like "the Stripe webhook signature header is read somewhere
  // in this file" (`req.headers['stripe-signature']`) is a MEMBER ACCESS on
  // a literal, not a call — ParsedCall.stringArgs can't see it, since
  // there's no enclosing call to attach it to. This is deliberately
  // file-wide and NOT scoped to calls, unlike stringArgs.
  literals: ParsedLiteral[];
}

export interface ParserAdapter {
  parse(path: string, source: string): ParsedFile;
}

function emptyParsedFile(path: string): ParsedFile {
  return { path, imports: [], functions: [], calls: [], bindings: [], accesses: [], literals: [] };
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

// A node's own static string text — a plain string literal, or a template
// literal with NO substitutions (`` `foo` `` has one; `` `foo ${x}` `` is a
// TemplateExpression, a different node kind entirely, and doesn't reach
// here). undefined for anything else, including a template WITH
// substitutions — that's the one documented gap (see ParsedCall.stringArgs'
// own comment and H2's anchors.ts tests for the concrete consequence).
function staticStringText(node: ts.Node): string | undefined {
  return ts.isStringLiteralLike(node) ? node.text : undefined;
}

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

// Top-level property names of one object-literal argument. Only
// PropertyAssignment / ShorthandPropertyAssignment / method / accessor
// members carry a `.name`; a SpreadAssignment (`{ ...rest }`) doesn't and is
// skipped outright — see ParsedCall.argPropertyNames' own comment for why a
// computed key is also omitted rather than represented.
function objectLiteralPropertyNames(obj: ts.ObjectLiteralExpression): string[] {
  const names: string[] = [];
  for (const prop of obj.properties) {
    if (ts.isSpreadAssignment(prop)) continue;
    const name = prop.name;
    if (name && (ts.isIdentifier(name) || ts.isStringLiteral(name))) names.push(name.text);
  }
  return names;
}

function toCall(node: ts.CallExpression, sourceFile: ts.SourceFile): ParsedCall {
  const stringArgs: string[] = [];
  const argPropertyNames: string[] = [];
  const numberArgs: number[] = [];
  for (const arg of node.arguments) {
    const text = staticStringText(arg);
    if (text !== undefined) stringArgs.push(truncate(text, ARG_STRING_MAX_CHARS));
    else if (ts.isObjectLiteralExpression(arg)) argPropertyNames.push(...objectLiteralPropertyNames(arg));
    // See ParsedCall.numberArgs' own comment. `Number(arg.text)` is exact
    // for the status-code-sized integers this exists to carry; a literal
    // too large for a JS number isn't a shape any recognizer looks for.
    else if (ts.isNumericLiteral(arg)) numberArgs.push(Number(arg.text));
  }
  return {
    chain: chainOf(node.expression),
    line: lineOf(sourceFile, node.getStart(sourceFile)),
    enclosingFunction: enclosingFunctionName(node, sourceFile),
    stringArgs,
    argPropertyNames,
    numberArgs,
  };
}

type AccessNode = ts.PropertyAccessExpression | ts.ElementAccessExpression;

function isAccessNode(node: ts.Node): node is AccessNode {
  return ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node);
}

// True for the OUTERMOST node of an access chain only — the same
// "record once per logical read, not once per sub-expression" posture
// ParsedCall gets for free (a call node's callee is a single expression, no
// sub-node walk needed). An access node is maximal when its parent is
// neither (a) another access node reading further INTO it (`.expression ===
// node`, e.g. the `a.b` inside `a.b.c`), nor (b) a CallExpression/
// NewExpression using it as the CALLEE (`.expression === node`, e.g. the
// `stripe.webhooks` inside `stripe.webhooks.constructEvent()`) — that shape
// is already ParsedCall's job via chainOf, and double-recording it here
// would make every existing call also produce a spurious ParsedAccess with
// the same chain minus the final segment.
function isMaximalAccessNode(node: AccessNode): boolean {
  const parent = node.parent;
  if (!parent) return true;
  if (isAccessNode(parent) && parent.expression === node) return false;
  if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === node) return false;
  return true;
}

function toAccess(node: AccessNode, sourceFile: ts.SourceFile): ParsedAccess {
  return {
    chain: chainOf(node),
    line: lineOf(sourceFile, node.getStart(sourceFile)),
    enclosingFunction: enclosingFunctionName(node, sourceFile),
  };
}

function toLiteral(node: ts.StringLiteralLike, sourceFile: ts.SourceFile): ParsedLiteral {
  return {
    value: node.text,
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
  accessNodes: AccessNode[];
  literalNodes: ts.StringLiteralLike[];
} {
  const importNodes: ts.ImportDeclaration[] = [];
  const functionNodes: FunctionLikeNode[] = [];
  const callNodes: ts.CallExpression[] = [];
  const varDecls: ts.VariableDeclaration[] = [];
  const accessNodes: AccessNode[] = [];
  const literalNodes: ts.StringLiteralLike[] = [];

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node)) importNodes.push(node);
    else if (isFunctionLikeNode(node)) functionNodes.push(node);
    else if (ts.isCallExpression(node)) callNodes.push(node);
    else if (ts.isVariableDeclaration(node)) varDecls.push(node);
    // Not mutually exclusive with the branches above by construction (a
    // string literal is never also an import/function/call/varDecl node),
    // so this stays a plain `if`, not an `else if` chain member — it's
    // still only ever one branch per node in practice, just checked
    // independently for clarity about why it isn't "the same kind of thing"
    // as the other four.
    if (ts.isStringLiteralLike(node)) literalNodes.push(node);
    // Also independent of the else-if chain above, same reasoning: an access
    // node IS a CallExpression's `.expression` in the call-callee case (e.g.
    // `stripe.webhooks.constructEvent` inside a CallExpression), so this
    // can't be folded into the `else if` without losing calls that also
    // start with an access chain. isMaximalAccessNode is what filters those
    // (and any other non-outermost access node) back out.
    if (isAccessNode(node) && isMaximalAccessNode(node)) accessNodes.push(node);
    // Recurse into every node's children regardless of which branch above
    // matched — e.g. a function-like node's own body still needs walking for
    // nested calls/functions, and a call expression's arguments can contain
    // further nested calls or function expressions.
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return { importNodes, functionNodes, callNodes, varDecls, accessNodes, literalNodes };
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
  const { importNodes, functionNodes, callNodes, varDecls, accessNodes, literalNodes } = collectNodes(sourceFile);
  const imports = bySourcePosition(importNodes, sourceFile)
    .map(toImport)
    .filter((x): x is ParsedImport => x !== null);
  const functions = bySourcePosition(functionNodes, sourceFile).map((n) => describeFunctionLike(n, sourceFile));
  const calls = bySourcePosition(callNodes, sourceFile).map((n) => toCall(n, sourceFile));
  const bindings = bySourcePosition(varDecls, sourceFile)
    .map(toBinding)
    .filter((x): x is ParsedBinding => x !== null);
  const accesses = bySourcePosition(accessNodes, sourceFile).map((n) => toAccess(n, sourceFile));
  // Longer literals are skipped entirely here (not truncated) — see
  // FILE_LITERAL_MAX_CHARS' own comment for why.
  const literals = bySourcePosition(literalNodes, sourceFile)
    .filter((n) => n.text.length <= FILE_LITERAL_MAX_CHARS)
    .map((n) => toLiteral(n, sourceFile));
  return { path, imports, functions, calls, bindings, accesses, literals };
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
