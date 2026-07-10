// Tier 1 of skill detection (see docs/signatures.md): generic import
// parsing, language-by-language, over a commit's ADDED diff lines only.
// Returns normalized package names for src/skill-detect.ts to look up in
// signatures/package-map.json. Never sends anything anywhere — pure string
// parsing, no I/O.
//
// Deliberately regex-based, not a real parser per language (that would mean
// 5 new dependencies — CLAUDE.md's dependency policy forbids that without
// written justification). The tradeoff: perfect syntactic correctness isn't
// the goal, bounded false positives are (principle 3) — every extractor is
// anchored to reject the three near-miss classes that matter in practice:
// comments, package names embedded in string literals, and doc files.

export type ImportLanguage =
  | "js"
  | "python"
  | "go"
  | "ruby"
  | "php"
  | "rust"
  | "java"
  | "kotlin"
  | "csharp"
  | "swift";

const DOC_EXTENSIONS = new Set([".md", ".mdx", ".txt", ".rst", ".markdown"]);

function languageForPath(filePath: string): ImportLanguage | null {
  const lower = filePath.toLowerCase();
  const ext = lower.slice(lower.lastIndexOf("."));
  if (DOC_EXTENSIONS.has(ext)) return null; // never scan docs for imports
  if ([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts"].includes(ext)) return "js";
  if (ext === ".py") return "python";
  if (ext === ".go") return "go";
  if (ext === ".rb" || lower.endsWith("/gemfile") || lower === "gemfile") return "ruby";
  if (ext === ".php" || lower.endsWith("/composer.json") || lower === "composer.json") return "php";
  if (ext === ".rs" || lower.endsWith("/cargo.toml") || lower === "cargo.toml") return "rust";
  if (ext === ".java") return "java";
  if (ext === ".kt" || ext === ".kts") return "kotlin";
  if (ext === ".cs" || ext === ".csproj") return "csharp";
  // Package.swift is itself a .swift file (SPM manifests are Swift source
  // using the PackageDescription DSL) — extractSwift tells it apart from
  // ordinary source by filename, same pattern as extractRust/extractCSharp
  // telling a manifest apart from source by filePath.
  if (ext === ".swift") return "swift";
  return null;
}

// A line is "commented out" if, once trimmed, it starts with a comment
// marker — catches a same-line "// import x from 'y'" near-miss. Multi-line
// regions (block comments, template literals, triple-quoted strings) are
// NOT line-prefix detectable at all — handled separately by
// `stripNonCodeRegions`, called once before any language extractor runs.
const COMMENT_PREFIXES = ["//", "#", "/*", "*", "<!--", "--"];
function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();
  return COMMENT_PREFIXES.some((p) => trimmed.startsWith(p));
}

// Replaces the CONTENTS of three multi-line region types with spaces
// (never removing lines — every other position in the text must keep its
// original line/column so isRealStatement's line lookups stay correct):
// block comments, JS/TS template literals, and Python triple-quoted
// strings. Without this, import-shaped text inside any of them is real
// text sitting at the start of ITS OWN line once the region spans multiple
// lines — isCommentLine/isInsideStringLiteral only ever look at a single
// line, so they can't catch a false positive that only exists because of
// what an EARLIER line opened.
function stripNonCodeRegions(text: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, " ");
  let out = text.replace(/\/\*[\s\S]*?\*\//g, blank);
  out = out.replace(/`(?:[^`\\]|\\.)*`/g, blank);
  out = out.replace(/("""[\s\S]*?"""|'''[\s\S]*?''')/g, blank);
  return out;
}

// Rejects a match whose containing line has an odd number of unescaped
// quote characters before the match start — i.e. the match sits inside an
// outer string literal ("const s = 'import x from \"y\"';"), not as real
// syntax. A cheap, deliberately approximate stand-in for real string
// tracking: good enough to kill the near-miss this is meant to kill,
// without a full tokenizer.
function isInsideStringLiteral(line: string, matchStart: number): boolean {
  const before = line.slice(0, matchStart);
  let quoteChar: string | null = null;
  let count = 0;
  for (let i = 0; i < before.length; i++) {
    const c = before[i];
    if (c === "\\") {
      i++; // skip escaped char
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      if (quoteChar === null) {
        quoteChar = c;
        count = 1;
      } else if (c === quoteChar) {
        quoteChar = null;
        count = 0;
      }
    }
  }
  return count > 0;
}

function lineAndOffsetAt(text: string, index: number): { line: string; offsetInLine: number } {
  const lineStart = text.lastIndexOf("\n", index - 1) + 1;
  let lineEnd = text.indexOf("\n", index);
  if (lineEnd === -1) lineEnd = text.length;
  return { line: text.slice(lineStart, lineEnd), offsetInLine: index - lineStart };
}

// A candidate match is accepted only if: (1) the statement-starting line
// (where the keyword itself begins, even for multi-line statements) isn't
// a comment, and (2) the keyword isn't sitting inside an outer string
// literal on that line.
function isRealStatement(text: string, keywordIndex: number): boolean {
  const { line, offsetInLine } = lineAndOffsetAt(text, keywordIndex);
  if (isCommentLine(line)) return false;
  if (isInsideStringLiteral(line, offsetInLine)) return false;
  return true;
}

function normalizeJs(raw: string): string {
  if (raw.startsWith("@")) return raw.split("/").slice(0, 2).join("/");
  return raw.split("/")[0];
}

function extractJs(text: string): string[] {
  const found: string[] = [];
  // import ... from "pkg" / export ... from "pkg" (also covers `export * from`,
  // `export { x } from`, and multi-line named-import lists via [\s\S]*?).
  // `d` (hasIndices) exposes the captured package name's own start offset —
  // needed because `[\s\S]*?\bfrom` is a lazy bridge that can walk INTO an
  // unrelated string literal later on the same line (e.g. a SQL string
  // containing the word "from") even when the line legitimately starts
  // with a real `import`/`export` keyword. Checking string-nesting at the
  // keyword's position alone (isRealStatement) doesn't catch that — the
  // capture's OWN position must be checked too.
  const fromRe = /^[ \t]*(import|export)\b[\s\S]*?\bfrom\s+["']([^"'\n]+)["']/gmd;
  for (const m of text.matchAll(fromRe)) {
    if (!isRealStatement(text, m.index!)) continue;
    // Check quote parity up to (but not including) the OPENING quote of the
    // captured package string itself — not the package text's own start.
    // Using the package text's start would count that opening quote as
    // "already inside a string," which is trivially true for every real
    // match (a quoted string always opens with a quote right before its
    // content) and would reject every legitimate import.
    const indices = (m as RegExpMatchArray & { indices: Array<[number, number]> }).indices;
    const openQuotePos = indices[2][0] - 1;
    const { line, offsetInLine } = lineAndOffsetAt(text, openQuotePos);
    if (isInsideStringLiteral(line, offsetInLine)) continue;
    found.push(normalizeJs(m[2]));
  }
  // import "pkg"; (side-effect import, no `from`)
  const bareImportRe = /^[ \t]*import\s+["']([^"'\n]+)["']\s*;?/gm;
  for (const m of text.matchAll(bareImportRe)) {
    if (isRealStatement(text, m.index!)) found.push(normalizeJs(m[1]));
  }
  // require("pkg") / import("pkg") — dynamic import, anywhere a real
  // statement could reasonably put it (assignment, await, bare call).
  const requireRe = /\b(?:require|import)\(\s*["']([^"'\n]+)["']\s*\)/g;
  for (const m of text.matchAll(requireRe)) {
    const { line, offsetInLine } = lineAndOffsetAt(text, m.index!);
    if (isCommentLine(line)) continue;
    if (isInsideStringLiteral(line, offsetInLine)) continue;
    found.push(normalizeJs(m[1]));
  }
  return found;
}

function extractPython(text: string): string[] {
  const found: string[] = [];
  // import pkg[.sub][ as alias][, pkg2[ as alias2] ...] — each item can
  // carry its own "as alias" before the next comma, which must be allowed
  // inside the repeated group or the chain breaks and everything after the
  // first alias silently falls out of the match.
  const importRe = /^[ \t]*import\s+([\w.]+(?:\s+as\s+\w+)?(?:\s*,\s*[\w.]+(?:\s+as\s+\w+)?)*)/gm;
  for (const m of text.matchAll(importRe)) {
    if (!isRealStatement(text, m.index!)) continue;
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/)[0];
      if (name) found.push(name.split(".")[0]);
    }
  }
  // from pkg[.sub] import x
  const fromRe = /^[ \t]*from\s+([\w.]+)\s+import\b/gm;
  for (const m of text.matchAll(fromRe)) {
    if (isRealStatement(text, m.index!)) found.push(m[1].split(".")[0]);
  }
  return found;
}

function extractGo(text: string): string[] {
  const found: string[] = [];
  const normalize = (p: string) => p.replace(/\/v\d+$/, "");
  // Single-line: import "path" or import alias "path"
  const singleRe = /^[ \t]*import\s+(?:\w+\s+)?["']([^"'\n]+)["']/gm;
  for (const m of text.matchAll(singleRe)) {
    if (isRealStatement(text, m.index!)) found.push(normalize(m[1]));
  }
  // Block: import (\n  "path1"\n  alias "path2"\n)
  const blockRe = /^[ \t]*import\s*\(([\s\S]*?)\)/gm;
  for (const m of text.matchAll(blockRe)) {
    if (!isRealStatement(text, m.index!)) continue;
    const pathRe = /["']([^"'\n]+)["']/g;
    for (const p of m[1].matchAll(pathRe)) found.push(normalize(p[1]));
  }
  return found;
}

function extractRuby(text: string, filePath: string): string[] {
  const found: string[] = [];
  const isGemfile = /gemfile$/i.test(filePath);
  if (isGemfile) {
    // gem "name"[, "~> 1.0"] — a Gemfile dependency declaration.
    const gemRe = /^[ \t]*gem\s+["']([^"'\n]+)["']/gm;
    for (const m of text.matchAll(gemRe)) {
      if (isRealStatement(text, m.index!)) found.push(m[1].split("/")[0]);
    }
    return found;
  }
  // require "pkg" — require_relative is deliberately excluded (it loads a
  // local file, not a third-party package; matching it would misattribute
  // a plain relative require to some unrelated real gem sharing the name).
  const requireRe = /^[ \t]*require\s+["']([^"'\n]+)["']/gm;
  for (const m of text.matchAll(requireRe)) {
    if (isRealStatement(text, m.index!)) found.push(m[1].split("/")[0]);
  }
  return found;
}

function extractPhp(text: string, filePath: string): string[] {
  const found: string[] = [];
  if (/composer\.json$/i.test(filePath)) {
    // Structured JSON — no regex needed, and safest possible source: no
    // comment/string-literal ambiguity exists in JSON added-lines at all.
    try {
      const parsed = JSON.parse(text) as { require?: Record<string, string> };
      if (parsed.require) found.push(...Object.keys(parsed.require).filter((k) => k !== "php"));
    } catch {
      // A partial diff (added lines only) is rarely valid standalone JSON —
      // fall through to returning whatever we found (nothing), rather than
      // guessing at a malformed fragment.
    }
    return found;
  }
  // use Vendor\Sub\Class; — namespace-to-composer-package mapping isn't
  // mechanical in PHP, so this only extracts the first namespace segment
  // (lowercased) as the lookup key. That's enough for framework-level
  // detection (e.g. `use Illuminate\...` -> "illuminate") but deliberately
  // doesn't attempt vendor/package-accurate resolution — see docs/signatures.md.
  const useRe = /^[ \t]*use\s+([A-Za-z0-9_]+)\\/gm;
  for (const m of text.matchAll(useRe)) {
    if (isRealStatement(text, m.index!)) found.push(m[1].toLowerCase());
  }
  return found;
}

// Rust `use` roots that name something LOCAL (the current crate, a parent
// module, or the standard library) rather than a third-party dependency —
// never worth a map lookup, and `std`/`core`/`alloc` would otherwise pollute
// every Rust repo's candidate list with the same three noise entries.
const RUST_LOCAL_USE_ROOTS = new Set(["crate", "self", "super", "std", "core", "alloc"]);

// Cargo.toml publishes crate names with hyphens (crates.io convention,
// e.g. "actix-web"), but a Rust identifier can't contain one — `use`
// statements reference the SAME crate as "actix_web". Normalizing both
// extraction paths to the underscore form is what lets a Cargo.toml
// addition and the `use` statement that consumes it resolve to the same
// package-map key.
function normalizeRustCrateName(name: string): string {
  return name.replace(/-/g, "_");
}

function extractRustUse(text: string): string[] {
  const found: string[] = [];
  // Optional `pub`/`pub(crate)`/`pub(super)` before `use` (a re-export),
  // then the first path segment — `use tokio::{net::TcpListener, sync::Mutex}`
  // and `use tokio::main;` both only need that first segment; the group
  // contents after `::` never change which crate this is.
  const useRe = /^[ \t]*(?:pub(?:\([^)]*\))?\s+)?use\s+([A-Za-z_][A-Za-z0-9_]*)/gm;
  for (const m of text.matchAll(useRe)) {
    if (!isRealStatement(text, m.index!)) continue;
    const name = normalizeRustCrateName(m[1]);
    if (!RUST_LOCAL_USE_ROOTS.has(name)) found.push(name);
  }
  return found;
}

// Cargo.toml dependency sections come in two shapes:
//   [dependencies]                    [dependencies.tokio]
//   tokio = { version = "1", ... }    version = "1"
//   serde = "1.0"                     features = ["full"]
// The first shape needs every `key = ...` line under the plain header read
// as a crate name; the second shape's crate name is IN the header itself
// (`tokio`), and its body (`version`, `features`, ...) must NOT be
// key-scanned — those are Cargo.toml keys, not crate names. Getting this
// wrong is exactly the false-positive class a naive "every `key = value`
// line in the file" scan would hit. `[package]` (name/version/edition/...)
// and anything else are neither shape and are simply skipped — same
// documented-miss tradeoff as composer.json's "only reliable on a diff
// that contains enough context" limitation (docs/signatures.md).
const TOML_PLAIN_DEPS_HEADER = /^\[(dependencies|dev-dependencies|build-dependencies)\]$/;
const TOML_DOTTED_DEPS_HEADER = /^\[(?:dependencies|dev-dependencies|build-dependencies)\.([A-Za-z0-9_-]+)\]$/;
const TOML_ANY_HEADER = /^\[.*\]$/;
const TOML_KV_LINE = /^([A-Za-z0-9_-]+)\s*=\s*(?:"|'|\{)/;

function extractCargoToml(text: string): string[] {
  const found: string[] = [];
  let scanningPlainDepsBody = false;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    if (isCommentLine(rawLine)) continue;
    const line = rawLine.trim();

    const dotted = TOML_DOTTED_DEPS_HEADER.exec(line);
    if (dotted) {
      found.push(normalizeRustCrateName(dotted[1]));
      scanningPlainDepsBody = false;
      continue;
    }
    if (TOML_PLAIN_DEPS_HEADER.test(line)) {
      scanningPlainDepsBody = true;
      continue;
    }
    if (TOML_ANY_HEADER.test(line)) {
      scanningPlainDepsBody = false; // any other section (incl. [package]) ends it
      continue;
    }
    if (scanningPlainDepsBody) {
      const kv = TOML_KV_LINE.exec(line);
      if (kv) found.push(normalizeRustCrateName(kv[1]));
    }
  }
  return found;
}

function extractRust(text: string, filePath: string): string[] {
  return /cargo\.toml$/i.test(filePath) ? extractCargoToml(text) : extractRustUse(text);
}

// Java/Kotlin package roots don't follow a fixed segment count: most
// libraries want 2 segments to collapse every submodule under one entry
// (`org.springframework.boot.SpringApplication` and
// `org.springframework.web.bind.annotation.RestController` should both hit
// `org.springframework`), but a handful of orgs publish many UNRELATED
// libraries under the same 2-segment root (`com.google.gson` vs
// `com.google.inject` vs a hypothetical future `com.google.common`/Guava
// entry — collapsing all of them to `com.google` would make one import
// credit whichever of those happened to be added to the map first, and
// silently misattribute every other). Rather than hardcode which roots are
// "generic" in code (ecosystem knowledge that keeps growing belongs in the
// versioned data file, not the CLI — the same reason slugs are never
// hardcoded), this emits candidate prefixes at every depth up to 3 and lets
// map membership decide which one is real; `test/package-map.test.ts`
// enforces that no dotted map key is ever a strict prefix of another, so
// one import can never accidentally credit two slugs at once.
function dottedPathPrefixes(dotted: string, maxDepth: number): string[] {
  const parts = dotted.split(".").filter(Boolean);
  const prefixes: string[] = [];
  for (let depth = 1; depth <= Math.min(maxDepth, parts.length); depth++) {
    prefixes.push(parts.slice(0, depth).join(".").toLowerCase());
  }
  return prefixes;
}

function extractJavaKotlin(text: string): string[] {
  const found: string[] = [];
  // import [static] a.b.C[.*][;] — Kotlin's `;` is optional, so it's not
  // required in the pattern; `.*` (wildcard) and a trailing `as Alias`
  // (Kotlin) are both consumed without being captured.
  const importRe = /^[ \t]*import\s+(?:static\s+)?([\w.]+)(?:\.\*)?(?:\s+as\s+\w+)?/gm;
  for (const m of text.matchAll(importRe)) {
    if (!isRealStatement(text, m.index!)) continue;
    found.push(...dottedPathPrefixes(m[1], 3));
  }
  return found;
}

// System.* is the one C# root broad enough to need the same multi-depth
// treatment as Java's com.google/org.apache (`System.Text.Json` vs
// `System.Linq` vs `System.Net.Http` are all unrelated) — Microsoft.* in
// practice doesn't need it for the libraries this detector targets
// (`Microsoft.AspNetCore.Mvc` and `Microsoft.AspNetCore.Http` are BOTH
// meant to collapse to `Microsoft.AspNetCore`), so depth 3 candidates cost
// nothing there: they simply never match anything in the map.
function extractCSharpUsing(text: string): string[] {
  const found: string[] = [];
  // using [global ][static ][Alias = ]a.b.C;
  const usingRe = /^[ \t]*(?:global\s+)?using\s+(?:static\s+)?(?:\w+\s*=\s*)?([\w.]+)\s*;/gm;
  for (const m of text.matchAll(usingRe)) {
    if (!isRealStatement(text, m.index!)) continue;
    found.push(...dottedPathPrefixes(m[1], 3));
  }
  return found;
}

// `<!-- ... -->` is XML/.csproj-only syntax — stripped here, not inside the
// shared stripNonCodeRegions, so it can never touch a JS/TS file where
// `<!--` is (rare but legal) real token syntax.
function stripXmlComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));
}

function extractCsprojPackageReferences(text: string): string[] {
  const found: string[] = [];
  const stripped = stripXmlComments(text);
  const re = /<PackageReference\s+[^>]*\bInclude\s*=\s*"([^"]+)"/g;
  for (const m of stripped.matchAll(re)) {
    if (isRealStatement(stripped, m.index!)) found.push(m[1].toLowerCase());
  }
  return found;
}

function extractCSharp(text: string, filePath: string): string[] {
  return /\.csproj$/i.test(filePath) ? extractCsprojPackageReferences(text) : extractCSharpUsing(text);
}

function isPackageSwiftManifest(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return lower === "package.swift" || lower.endsWith("/package.swift");
}

function extractSwiftImport(text: string): string[] {
  const found: string[] = [];
  // import [ModuleKind ]ModuleName — `import struct Foundation.Date` names
  // the MODULE as "Foundation", not the kind keyword "struct"; skipping it
  // is what keeps that case (and `class`/`enum`/`protocol`/`func`/`var`/
  // `let`/`typealias` submodule imports) from capturing the keyword itself.
  const importRe =
    /^[ \t]*(?:@testable\s+)?import\s+(?:(?:struct|class|enum|protocol|func|typealias|var|let)\s+)?([A-Za-z_][A-Za-z0-9_]*)/gm;
  for (const m of text.matchAll(importRe)) {
    if (isRealStatement(text, m.index!)) found.push(m[1].toLowerCase());
  }
  return found;
}

function packageNameFromSpmUrl(url: string): string | null {
  const stripped = url.replace(/\.git$/i, "");
  const segments = stripped.split("/").filter(Boolean);
  let last = segments[segments.length - 1];
  if (!last) return null;
  // A few SPM repos put ".swift" IN the repo name itself (e.g. GRDB.swift,
  // github.com/groue/GRDB.swift) — stripped so the URL-derived candidate
  // matches the module's own `import GRDB` name instead of colliding as a
  // second, dotted map key for the same package (see
  // test/package-map.test.ts's "no dotted key is a strict prefix of
  // another" invariant). Anchored to a literal ".swift" suffix, not just
  // any name ending in "swift" — "RxSwift" has no dot before it and must
  // stay untouched.
  last = last.replace(/\.swift$/i, "");
  return last.toLowerCase();
}

function extractPackageSwiftDependencies(text: string): string[] {
  const found: string[] = [];
  // .package(url: "...") or .package(name: "...", url: "...") — `name:`
  // before `url:` is the older (pre-SwiftPM-5.4) explicit-name form.
  const packageRe = /\.package\(\s*(?:name:\s*["'][^"']+["']\s*,\s*)?url:\s*["']([^"']+)["']/g;
  for (const m of text.matchAll(packageRe)) {
    if (!isRealStatement(text, m.index!)) continue;
    const name = packageNameFromSpmUrl(m[1]);
    if (name) found.push(name);
  }
  return found;
}

function extractSwift(text: string, filePath: string): string[] {
  return isPackageSwiftManifest(filePath) ? extractPackageSwiftDependencies(text) : extractSwiftImport(text);
}

/**
 * Extracts normalized package names from one file's added diff lines.
 * `filePath` selects the language (and, for Ruby/PHP, distinguishes a
 * Gemfile/composer.json from ordinary source). Returns [] for files whose
 * extension isn't recognized, or for excluded doc files (.md etc.) — never
 * throws.
 */
export function extractImportedPackages(addedLines: string, filePath: string): string[] {
  const language = languageForPath(filePath);
  if (!language) return [];
  // composer.json (structured JSON) and Cargo.toml/.csproj (each parsed by
  // their own dedicated, format-aware scanner above, with their own
  // comment handling — TOML's `#`, XML's `<!-- -->`) get the raw text:
  // stripNonCodeRegions only knows `/* */`/backtick/triple-quote syntax,
  // none of which apply, so running it would be a pass with zero possible
  // benefit before a format-specific parser that doesn't need it.
  const isComposerJson = language === "php" && /composer\.json$/i.test(filePath);
  const isCargoToml = language === "rust" && /cargo\.toml$/i.test(filePath);
  const isCsproj = language === "csharp" && /\.csproj$/i.test(filePath);
  const text =
    isComposerJson || isCargoToml || isCsproj ? addedLines : stripNonCodeRegions(addedLines);
  switch (language) {
    case "js":
      return extractJs(text);
    case "python":
      return extractPython(text);
    case "go":
      return extractGo(text);
    case "ruby":
      return extractRuby(text, filePath);
    case "php":
      return extractPhp(text, filePath);
    case "rust":
      return extractRust(text, filePath);
    case "java":
    case "kotlin":
      return extractJavaKotlin(text);
    case "csharp":
      return extractCSharp(text, filePath);
    case "swift":
      return extractSwift(text, filePath);
  }
}
