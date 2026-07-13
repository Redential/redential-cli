// H1 of the proof-graph spike (see docs/proof-graph-spike.md): an in-memory
// graph over one HEAD snapshot's ParsedFile[] (parser-adapter.ts). Query
// surface ONLY — the graph is built once by buildGraph and never mutated
// afterward, and (per the spike's in-memory-only invariant) there is
// deliberately no toJSON/serialize/save/write method anywhere in this file,
// nor any other way to render the graph to a string or to disk. It lives for
// the duration of the process that built it and dies with it.
//
// Nodes: one per file (its `path`) and one per declared function within a
// file (`path` + ParsedFunction.name — a function is only unique WITHIN its
// file, so every lookup below is keyed by the pair, never by name alone).
// Edges: "contains" (file -> its functions, i.e. functionsOf), "import"
// (file -> file, relative specifiers only — see resolveImport), "call"
// (function-or-module-top-level -> resolved target function(s) — see
// resolveCallTargets). Same syntactic, no-type-checker posture as
// parser-adapter.ts: every resolution rule here is "does the AST shape
// unambiguously say so," never a guess.
import type { ParsedCall, ParsedFile, ParsedFunction, ParsedImport } from "./parser-adapter.js";

export interface FunctionNodeId {
  path: string;
  name: string;
}

export interface ImportEdge {
  specifier: string;
  resolvedPath: string | null;
}

// callsFrom's argument: either a specific declared function, or the file's
// module-top-level scope (ParsedCall.enclosingFunction === null covers both
// "a call that sits directly at module scope" and, by construction, has no
// FunctionNodeId of its own since it isn't a declared function).
export type CallSite = FunctionNodeId | { path: string; module: true };

function isFunctionNodeId(site: CallSite): site is FunctionNodeId {
  return "name" in site;
}

// Path handling below is a small hand-rolled POSIX-only implementation, not
// node:path: every path flowing through this file originates from git tree
// paths (readHeadSnapshot / listHeadTreeBlobs), which git always reports
// with forward slashes regardless of OS — and this repo's own CI matrix
// (see CLAUDE.md) runs on Windows, where node:path's platform-default join
// would use backslashes and silently break every specifier resolution
// below. node:path DOES expose a `posix` namespace that would do this
// correctly, but this repo intentionally has no @types/node dependency
// (see src/node-shims.d.ts's own comment) and its hand-written "node:path"
// ambient module only declares the narrow join/resolve/extname surface
// git.ts needs — extending that shared shim is out of this module's scope,
// so a few lines of dependency-free posix logic here are simpler than
// widening a shim owned by another part of the spike.
function isRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

// Directory portion of a posix-style repo-relative path (no leading slash
// in practice — git tree paths never have one). "src/a.ts" -> "src";
// "a.ts" (no slash at all) -> "" (module at repo root).
function posixDirname(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
}

// Joins a directory and a (possibly "./"/"../"-prefixed) relative specifier
// into a single normalized posix path, resolving "." and ".." segments —
// the same job posix.join + posix.normalize would do together. Doesn't
// need to handle a leading "/" (absolute) input: every caller here only
// ever passes a directory derived from a repo-relative file path and a
// specifier that starts with "./" or "../" (isRelativeSpecifier already
// gated at the only call site), so an absolute-path branch would be dead
// code this file has no way to exercise or verify.
function joinPosix(dir: string, specifier: string): string {
  const combined = dir === "" ? specifier : `${dir}/${specifier}`;
  const out: string[] = [];
  for (const segment of combined.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      // Walking above the repo root (more ".." segments than there are
      // directories to pop) has no sensible normalized form — drop it
      // silently rather than accumulate a leading "..", which could never
      // match anything in fileSet anyway and would just be dead weight in
      // the returned string.
      if (out.length > 0) out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join("/");
}

// The five candidate forms specified for H1, in this exact priority order,
// PLUS one spike-specific addition documented below. Anything not covered
// here (tsconfig paths/aliases, package "exports" maps, workspace
// resolution) is an explicit spike exclusion (see docs/proof-graph-spike.md)
// — an unresolved specifier is a valid, conservative answer (resolveImport
// returns null), never a guess.
function candidateSpecifiers(specifier: string): string[] {
  const candidates = [specifier, `${specifier}.ts`, `${specifier}.tsx`, `${specifier}/index.ts`, `${specifier}/index.tsx`];
  // Real ESM TypeScript repos (this one included — see e.g. every relative
  // import in src/) write the specifier with the RUNTIME ".js"/".jsx"
  // extension even though the file on disk is ".ts"/".tsx": Node's ESM
  // resolver requires the specifier to match the file the compiler will
  // eventually emit, and `tsc` deliberately does NOT rewrite extensions in
  // import specifiers. The snapshot this graph is built from only ever
  // contains .ts/.tsx source (readHeadSnapshot filters everything else out
  // before parsing), so a bare ".js"/".jsx" specifier would never match
  // candidate 1 above without this extra candidate. Appended last (after
  // the five spec-ordered candidates) so it never takes priority over a
  // more literal match for a specifier that happens to already resolve.
  if (specifier.endsWith(".js")) candidates.push(`${specifier.slice(0, -".js".length)}.ts`);
  else if (specifier.endsWith(".jsx")) candidates.push(`${specifier.slice(0, -".jsx".length)}.tsx`);
  return candidates;
}

// Shared by both the constructor's cached edge computation and the public
// resolveImport query — same resolution logic either way, just called at a
// different time, so the two can never disagree on what a specifier
// resolves to.
function resolveRelative(fromPath: string, specifier: string, fileSet: ReadonlySet<string>): string | null {
  if (!isRelativeSpecifier(specifier)) return null;
  const dir = posixDirname(fromPath);
  for (const candidate of candidateSpecifiers(specifier)) {
    const resolved = joinPosix(dir, candidate);
    if (fileSet.has(resolved)) return resolved;
  }
  return null;
}

function findImportBinding(
  file: ParsedFile,
  localName: string
): { imp: ParsedImport; binding: ParsedImport["bindings"][number] } | undefined {
  for (const imp of file.imports) {
    // A side-effect import (`import "./x"`) has an empty bindings array by
    // construction (parser-adapter.ts), so it can never match here — no
    // special-casing needed.
    for (const binding of imp.bindings) {
      if (binding.local === localName) return { imp, binding };
    }
  }
  return undefined;
}

/**
 * Query-only view over one HEAD snapshot's parsed files. Construct via
 * buildGraph, never directly — the constructor is where the (private,
 * cached) import-edge and external-import computation happens, once, so
 * every query method below is a plain lookup rather than repeated work.
 */
export class ProofGraph {
  private readonly filesByPath: Map<string, ParsedFile>;
  private readonly sortedPaths: string[];
  private readonly fileSet: ReadonlySet<string>;
  private readonly importEdgesByPath: Map<string, ImportEdge[]>;
  private readonly externalImportsByPath: Map<string, ParsedImport[]>;

  // Only buildGraph constructs a ProofGraph — kept internal (not exported)
  // so "sorted by path, deduplicated" stays a guarantee this file's own
  // entry point enforces, not something every call site has to remember to
  // do itself before handing files in.
  constructor(sortedFiles: ParsedFile[]) {
    this.filesByPath = new Map(sortedFiles.map((f) => [f.path, f]));
    this.sortedPaths = sortedFiles.map((f) => f.path);
    this.fileSet = new Set(this.sortedPaths);

    this.importEdgesByPath = new Map();
    this.externalImportsByPath = new Map();
    for (const file of sortedFiles) {
      const relativeEdges: ImportEdge[] = [];
      const external: ParsedImport[] = [];
      for (const imp of file.imports) {
        if (isRelativeSpecifier(imp.specifier)) {
          relativeEdges.push({
            specifier: imp.specifier,
            resolvedPath: resolveRelative(file.path, imp.specifier, this.fileSet),
          });
        } else {
          // Non-relative specifiers (bare package names like "stripe",
          // "node:path", or an unresolvable tsconfig-alias-style path) never
          // produce a file edge — there is no file in the snapshot's own
          // tree to point at — but they stay queryable as data via
          // externalImportsOf, which H2 needs for "stripe is imported here"
          // as a signal independent of whether it's structurally used.
          external.push(imp);
        }
      }
      this.importEdgesByPath.set(file.path, relativeEdges);
      this.externalImportsByPath.set(file.path, external);
    }
  }

  /** All file paths in the graph, sorted — the graph's own canonical order,
   * independent of the order buildGraph's input array happened to be in. */
  files(): string[] {
    return [...this.sortedPaths];
  }

  /** Declared functions of a file, in source order. [] for an unknown path
   * (a query about a node that isn't in the graph yields no results, not an
   * error — same conservative posture as resolveCallTargets returning []
   * for anything it can't resolve). */
  functionsOf(path: string): ParsedFunction[] {
    return [...(this.filesByPath.get(path)?.functions ?? [])];
  }

  /** Resolves a RELATIVE specifier written in `fromPath` to a path in this
   * graph's own file set, or null if it's non-relative or doesn't resolve
   * against any of the five (plus one, see candidateSpecifiers) candidate
   * forms. Exposed as its own query (not just used internally for
   * importEdgesOf) so a caller can resolve a one-off specifier — e.g. a
   * future recognizer checking where a specific binding's module lives —
   * without needing a ParsedImport to already exist for it. */
  resolveImport(fromPath: string, specifier: string): string | null {
    return resolveRelative(fromPath, specifier, this.fileSet);
  }

  /** RELATIVE import edges of a file — one entry per relative ParsedImport,
   * with its resolution (null if unresolved). Non-relative imports never
   * appear here; see externalImportsOf for those. [] for an unknown path. */
  importEdgesOf(path: string): ImportEdge[] {
    return [...(this.importEdgesByPath.get(path) ?? [])];
  }

  /** Non-relative imports of a file (bare package specifiers, "node:..."),
   * kept as data — never a file edge, since there is no file in the
   * snapshot to point at. [] for an unknown path. */
  externalImportsOf(path: string): ParsedImport[] {
    return [...(this.externalImportsByPath.get(path) ?? [])];
  }

  /** Calls made from one declared function, or from a file's module-level
   * scope (pass `{ path, module: true }`). [] for an unknown path or an
   * unknown function name. */
  callsFrom(site: CallSite): ParsedCall[] {
    const file = this.filesByPath.get(site.path);
    if (!file) return [];
    if (isFunctionNodeId(site)) {
      return file.calls.filter((c) => c.enclosingFunction === site.name);
    }
    return file.calls.filter((c) => c.enclosingFunction === null);
  }

  /**
   * Resolves a call's target function(s) — deliberately syntactic and
   * conservative, per the spike's "no type-checker" posture (see
   * parser-adapter.ts and docs/proof-graph-spike.md's Exclusions). Tries
   * each rule in order and returns the first that applies; [] is a valid,
   * final answer whenever none does — this function never guesses.
   *
   * Rule 1 (same-file): the call is a bare name (`chain.length === 1`) and
   * that name is a function declared in the SAME file. Resolving anything
   * with a longer chain against a same-file function would require
   * modeling `this`/class-instance calls, which the spike explicitly
   * doesn't (see parser-adapter.ts's FunctionLikeNode exclusions).
   *
   * Rule 2 (imported default/named): the chain's root name is the LOCAL
   * name of a default or named import binding in this file, whose
   * specifier resolves (via resolveImport) to another file in the graph.
   * The call must still be a bare name (`chain.length === 1`) — a member
   * access off an imported binding (`importedThing.method()`) isn't
   * covered by this rule (see the `AmbientRecordable "*"`-style caveat:
   * these are syntactic chains, no way to tell "the imported value is a
   * function I called `.foo()` on" from "the imported value is an object
   * whose `foo` I'm calling" without semantic resolution). The target
   * function inside that file must have a name EQUAL to the binding's
   * `imported` field — for a named import that's the real exported name
   * (`import { foo as bar }` -> imported "foo"); for a default import the
   * adapter records `imported: "default"` literally (parser-adapter.ts
   * never resolves which declared function is a module's actual default
   * export — that's semantic, not syntactic), so this rule only resolves a
   * default-imported call when the target file happens to declare a
   * function literally named "default", which in practice means default
   * imports mostly resolve to [] here — an intentional, documented
   * limitation rather than a guess at which function is the real export.
   *
   * Rule 3 (imported namespace): the chain's root name is the local name
   * of a NAMESPACE import (`import * as api from "./x"`) whose specifier
   * resolves to another file, and the chain is exactly two segments long
   * (`["api", "fn"]`). The second segment is looked up as a function name
   * declared in that file.
   */
  resolveCallTargets(path: string, call: ParsedCall): FunctionNodeId[] {
    const file = this.filesByPath.get(path);
    if (!file) return [];

    // Rule 1: same-file, bare name.
    if (call.chain.length === 1) {
      const name = call.chain[0];
      if (file.functions.some((f) => f.name === name)) {
        return [{ path, name }];
      }
    }

    const found = findImportBinding(file, call.chain[0]);
    if (!found) return [];
    const { imp, binding } = found;
    const targetPath = resolveRelative(path, imp.specifier, this.fileSet);
    if (targetPath === null) return [];
    const targetFile = this.filesByPath.get(targetPath);
    if (!targetFile) return []; // resolveRelative only returns paths present in fileSet, but stay defensive

    // Rule 2: imported default/named binding, bare name only.
    if ((binding.kind === "default" || binding.kind === "named") && call.chain.length === 1) {
      const targetName = binding.imported;
      if (targetFile.functions.some((f) => f.name === targetName)) {
        return [{ path: targetPath, name: targetName }];
      }
      return [];
    }

    // Rule 3: imported namespace, exactly ["local", "fn"].
    if (binding.kind === "namespace" && call.chain.length === 2) {
      const targetName = call.chain[1];
      if (targetFile.functions.some((f) => f.name === targetName)) {
        return [{ path: targetPath, name: targetName }];
      }
      return [];
    }

    return [];
  }

  /** The full ParsedFile for a path, or undefined if it isn't in the graph
   * — an escape hatch for callers (e.g. a future recognizer) that need
   * fields this query surface doesn't expose directly (ParsedBinding, most
   * notably — the graph itself has no binding-resolution query in H1). */
  parsedFile(path: string): ParsedFile | undefined {
    return this.filesByPath.get(path);
  }
}

/**
 * Builds a ProofGraph from a HEAD snapshot's parsed files. Deterministic
 * regardless of input order: `files` is sorted by path FIRST, before
 * anything else reads it, so the same set of ParsedFile values (in any
 * order) always produces identical files()/edge query results — matching
 * readHeadSnapshot's own "sorted, not tree-walk order" determinism
 * guarantee one layer up.
 */
export function buildGraph(files: ParsedFile[]): ProofGraph {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return new ProofGraph(sorted);
}
