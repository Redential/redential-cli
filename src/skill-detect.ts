import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { getCommitAddedLines, type RawCommit } from "./git.js";
import { isExcludedPath, heuristicallyGeneratedPaths } from "./churn-exclusions.js";
import { ScanError } from "./errors.js";
import type { DetectedSkill } from "./types.js";

export interface FixtureCase {
  path: string;
  diff: string;
}

export interface Signature {
  slug: string;
  importPatterns?: string[];
  apiPatterns?: string[];
  configFilePatterns?: string[];
  fixtures: {
    positive: FixtureCase[];
    negative: FixtureCase[];
  };
}

interface CompiledSignature {
  slug: string;
  importRegexes: RegExp[];
  apiRegexes: RegExp[];
  configFileRegexes: RegExp[];
}

// Default locations ship alongside dist/ in the published package (see
// package.json's "files") — src/ and dist/ sit at the same depth from the
// package root, so this resolves correctly both in dev and post-build.
const DEFAULT_SIGNATURES_DIR = fileURLToPath(new URL("../signatures", import.meta.url));
const DEFAULT_TAXONOMY_PATH = fileURLToPath(new URL("../taxonomy.json", import.meta.url));

// A single added line long enough to be minified/generated noise, not a
// hand-authored import or API call — never worth pattern-matching, and
// bounds worst-case regex time on pathological input.
const MAX_MATCHED_LINE_LENGTH = 2000;

function boundedAddedLines(addedLines: string): string {
  return addedLines
    .split("\n")
    .filter((line) => line.length <= MAX_MATCHED_LINE_LENGTH)
    .join("\n");
}

function listJsonFilesRecursive(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listJsonFilesRecursive(full));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Loads every `signatures/**\/*.json` file. `dir` is overridable ONLY so
 * tests (including the privacy test that proves a hostile signature can't
 * escape) can point detection at a fixture directory instead of the real
 * shipped one — production code always uses the default.
 */
export function loadSignatures(dir: string = DEFAULT_SIGNATURES_DIR): Signature[] {
  return listJsonFilesRecursive(dir).map((file) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      // Never echo file content in the error — just which file is broken.
      throw new ScanError(`Malformed signature file: ${file}`);
    }
    const sig = parsed as Partial<Signature>;
    if (typeof sig.slug !== "string" || !sig.fixtures) {
      throw new ScanError(`Signature file missing required fields: ${file}`);
    }
    return sig as Signature;
  });
}

/** Same override rationale as loadSignatures. */
export function loadTaxonomySlugs(path: string = DEFAULT_TAXONOMY_PATH): Set<string> {
  const taxonomy = JSON.parse(readFileSync(path, "utf8")) as { skills: { slug: string }[] };
  return new Set(taxonomy.skills.map((s) => s.slug));
}

function compile(signatures: Signature[], taxonomySlugs: Set<string>): CompiledSignature[] {
  return signatures.map((sig) => {
    // Defense in depth: the closed-vocabulary rule is enforced HERE, inside
    // the function runScan actually calls (see scan.ts) — not just as a
    // standalone check a future refactor could unwire without failing any
    // test. A signature file naming a slug outside taxonomy.json can never
    // reach matching, let alone the bundle.
    if (!taxonomySlugs.has(sig.slug)) {
      throw new ScanError(`Signature slug "${sig.slug}" is not in taxonomy.json.`);
    }
    try {
      return compileOne(sig);
    } catch {
      // Never echo the (possibly-malformed) pattern source, just which
      // signature it came from.
      throw new ScanError(`Signature "${sig.slug}" has an invalid regex pattern.`);
    }
  });
}

function matches(file: { path: string; addedLines: string }, sig: CompiledSignature): boolean {
  if (sig.configFileRegexes.some((r) => r.test(file.path))) return true;
  const text = boundedAddedLines(file.addedLines);
  if (sig.importRegexes.some((r) => r.test(text))) return true;
  if (sig.apiRegexes.some((r) => r.test(text))) return true;
  return false;
}

function compileOne(sig: Signature): CompiledSignature {
  return {
    slug: sig.slug,
    importRegexes: (sig.importPatterns ?? []).map((p) => new RegExp(p)),
    apiRegexes: (sig.apiPatterns ?? []).map((p) => new RegExp(p)),
    configFileRegexes: (sig.configFilePatterns ?? []).map((p) => new RegExp(p)),
  };
}

/**
 * Test-only entry point (exported so test/skill-detect.test.ts exercises
 * the SAME matching primitive `detectSkills` uses, not a reimplementation
 * of it — same rationale as the fixtures living inside each signature
 * file). Not used by production scanning, which always goes through
 * `detectSkills`'s per-commit loop.
 */
export function fixtureMatches(sig: Signature, fixture: FixtureCase): boolean {
  return matches({ path: fixture.path, addedLines: fixture.diff }, compileOne(sig));
}

export interface PatternCoverage {
  importPatterns: boolean[];
  apiPatterns: boolean[];
  configFilePatterns: boolean[];
}

/** Per-pattern hit map for one fixture against one signature — lets the
 * generic test assert every declared pattern is exercised by at least one
 * positive fixture, catching a dead or typo'd pattern that would otherwise
 * silently never fire. */
export function fixtureCoverage(sig: Signature, fixture: FixtureCase): PatternCoverage {
  const compiled = compileOne(sig);
  return {
    importPatterns: compiled.importRegexes.map((r) => r.test(fixture.diff)),
    apiPatterns: compiled.apiRegexes.map((r) => r.test(fixture.diff)),
    configFilePatterns: compiled.configFileRegexes.map((r) => r.test(fixture.path)),
  };
}

export interface DetectSkillsOptions {
  signaturesDir?: string;
  taxonomyPath?: string;
}

/**
 * Deterministic, local skill detection (principle 3, "Bounded output"):
 * matches ADDED lines of the selected author's own commits against
 * signatures/*.json. Zero network, no LLMs. Merge commits are skipped,
 * same as getAllCommits' own numstat (which emits none for them) — no
 * combined-diff handling needed. Files excluded from churn (lockfiles,
 * build output, single-commit generated dumps — src/churn-exclusions.ts)
 * are excluded here too: a vendored bundle's content matching an import
 * pattern would be a false "you wrote this" signal, not a real one.
 */
export function detectSkills(
  userCommits: RawCommit[],
  repoPath: string,
  opts: DetectSkillsOptions = {}
): DetectedSkill[] {
  const signatures = loadSignatures(opts.signaturesDir);
  const taxonomySlugs = loadTaxonomySlugs(opts.taxonomyPath);
  const compiled = compile(signatures, taxonomySlugs);
  const generatedPaths = heuristicallyGeneratedPaths(userCommits);

  const matchedCommits = new Map<string, Set<string>>();
  const matchedDates = new Map<string, Date[]>();

  for (const commit of userCommits) {
    if (commit.isMerge) continue;
    const files = getCommitAddedLines(repoPath, commit.sha).filter(
      (f) => !isExcludedPath(f.path) && !generatedPaths.has(f.path)
    );
    if (files.length === 0) continue;

    for (const sig of compiled) {
      if (matchedCommits.get(sig.slug)?.has(commit.sha)) continue;
      if (files.some((f) => matches(f, sig))) {
        if (!matchedCommits.has(sig.slug)) matchedCommits.set(sig.slug, new Set());
        matchedCommits.get(sig.slug)!.add(commit.sha);
        if (!matchedDates.has(sig.slug)) matchedDates.set(sig.slug, []);
        matchedDates.get(sig.slug)!.push(commit.authorDate);
      }
    }
  }

  const result: DetectedSkill[] = [];
  for (const [slug, shas] of matchedCommits) {
    const dates = matchedDates.get(slug)!;
    const sorted = [...dates].sort((a, b) => a.getTime() - b.getTime());
    result.push({
      slug,
      commit_count: shas.size,
      first_seen: sorted[0].toISOString(),
      last_seen: sorted[sorted.length - 1].toISOString(),
    });
  }
  // Deterministic output (principle 4, "User-reviewed": the printed bundle
  // must be byte-identical across runs over the same history) — Map
  // insertion order otherwise depends on which commit happened to match
  // which signature first.
  result.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  return result;
}
