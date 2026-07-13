import { extname } from "node:path";
import {
  getAllCommits,
  getCommitCount,
  getRemoteHostType,
  getRootCommitDate,
  getRootCommitSha,
  type RawCommit,
} from "./git.js";
import { saltedHash } from "./hash.js";
import { getOrCreateSalt } from "./salt.js";
import { merkleRoot } from "./merkle.js";
import { categorize } from "./categorize.js";
import { isExcludedPath, heuristicallyGeneratedPaths } from "./churn-exclusions.js";
import { detectSkills, type DetectSkillsOptions } from "./skill-detect.js";
import { assertNoSecrets } from "./secret-scan.js";
import { parseSince } from "./since.js";
import { debugLog } from "./debug.js";
import { readHeadSnapshot } from "./proof-graph/snapshot.js";
import { TscParserAdapter } from "./proof-graph/parser-adapter.js";
import { buildGraph } from "./proof-graph/graph.js";
import { findAnchors } from "./proof-graph/anchors.js";
import {
  collectUserTouchedFileDetails,
  inferStructuralSkills,
  summarizeTouchedCommits,
} from "./proof-graph/infer.js";
import type { Bundle, CategoryName, DetectedSkill, LanguageShare, CategoryShare, DateForensicsInfo } from "./types.js";

export { ScanError } from "./errors.js";
import { ScanError } from "./errors.js";

export interface AuthorCandidate {
  email: string;
  count: number;
}

export async function listAuthors(repoPath: string): Promise<AuthorCandidate[]> {
  const counts = new Map<string, number>();
  for (const c of await getAllCommits(repoPath)) {
    counts.set(c.email, (counts.get(c.email) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([email, count]) => ({ email, count }))
    .sort((a, b) => b.count - a.count);
}

export interface ScanOptions {
  repoPath: string;
  authors: string[];
  confirmed: boolean;
  toolVersion: string;
  now?: Date;
  configDir?: string;
  // Overrides the signatures/taxonomy locations skill detection reads from.
  // Exists ONLY so tests can point the REAL runScan path at fixture data
  // (including a hostile signature naming a slug outside taxonomy.json, to
  // prove the privacy guarantee holds in the actual call path, not a
  // reimplementation of it) — production callers never set this.
  skillDetectOptions?: DetectSkillsOptions;
  // Raw --since spec ("2years", "18months", "2024-01-01" — see
  // src/since.ts). Limits the WALK to commits at/after this date; no new
  // bundle field is added for it — commits.first_at/span_days simply end
  // up reflecting the analyzed window. See docs/scan.md's "huge
  // repositories" section for exactly what this does and doesn't change.
  since?: string;
  // Commits scanned so far / total commits in the walked window — drives
  // scan-command.ts's stderr progress line for huge repos. Never given
  // anything beyond running counts (no sha, path, or email).
  onProgress?: (scanned: number, total: number) => void;
}

const MS_PER_DAY = 86_400_000;

function normalizeExtension(filePath: string): string | null {
  const ext = extname(filePath).toLowerCase();
  return /^\.[a-z0-9]+$/.test(ext) ? ext : null;
}

export async function runScan(opts: ScanOptions): Promise<Bundle> {
  if (!opts.confirmed) {
    throw new ScanError(
      "Authorization not confirmed. Re-run with --yes after confirming you are authorized to analyze this repository, or answer the interactive prompt."
    );
  }
  if (opts.authors.length === 0) {
    throw new ScanError(
      "No author identity selected. Pass --author <email> (repeatable) or select interactively."
    );
  }

  const now = opts.now ?? new Date();
  const sinceDate = opts.since !== undefined ? parseSince(opts.since, now) : undefined;

  const total = getCommitCount(opts.repoPath, sinceDate);
  const walkStart = Date.now();
  const allCommits = await getAllCommits(opts.repoPath, {
    since: sinceDate,
    onProgress: opts.onProgress ? (scanned) => opts.onProgress!(scanned, total) : undefined,
  });
  debugLog(`commit walk: ${allCommits.length} commits in ${Date.now() - walkStart}ms`);
  if (allCommits.length === 0) {
    if (sinceDate && getCommitCount(opts.repoPath) > 0) {
      throw new ScanError(
        `No commits found after ${sinceDate.toISOString().slice(0, 10)} (--since "${opts.since}"). Try a wider window, or omit --since.`
      );
    }
    throw new ScanError("This repository has no commits yet — nothing to scan.");
  }

  const authorSet = new Set(opts.authors);
  const userCommits = allCommits.filter((c) => authorSet.has(c.email));
  if (userCommits.length === 0) {
    throw new ScanError(`No commits found for the selected author(s): ${opts.authors.join(", ")}`);
  }
  debugLog(`author filter: ${userCommits.length}/${allCommits.length} commits match the selected author(s)`);

  const distinctAuthors = new Set(allCommits.map((c) => c.email));
  const otherContributorsCount = [...distinctAuthors].filter((e) => !authorSet.has(e)).length;

  const salt = getOrCreateSalt(opts.configDir);
  const authorHashes = opts.authors.map((e) => saltedHash(salt, e));

  const rootSha = getRootCommitSha(opts.repoPath);
  // Always the TRUE root of the repo's history, never the start of a
  // `--since` window — repo.age_days answers "how old is this repo", not
  // "how old is the analyzed window" (docs/schema.md, docs/scan.md).
  const repoFirstCommitDate = getRootCommitDate(opts.repoPath, rootSha);
  const ageDays = Math.floor((now.getTime() - repoFirstCommitDate.getTime()) / MS_PER_DAY);
  const hostType = getRemoteHostType(opts.repoPath);
  const repoFingerprint = saltedHash(salt, rootSha);

  const firstAt = userCommits[0].authorDate;
  const lastAt = userCommits[userCommits.length - 1].authorDate;
  const spanDays = Math.floor((lastAt.getTime() - firstAt.getTime()) / MS_PER_DAY);

  const hourHistogram = new Array(24).fill(0) as number[];
  const weekdayHistogram = new Array(7).fill(0) as number[];
  for (const c of userCommits) {
    hourHistogram[c.authorDate.getUTCHours()]++;
    weekdayHistogram[c.authorDate.getUTCDay()]++;
  }

  const signedCount = userCommits.filter((c) => c.signed).length;

  const { languages, categories } = computeChurnBreakdown(userCommits);
  const skillsStart = Date.now();
  const importSkills = await detectSkills(userCommits, opts.repoPath, opts.skillDetectOptions);
  debugLog(`skill detection: ${importSkills.length} skills matched in ${Date.now() - skillsStart}ms`);

  // H7 of the proof-graph spike (docs/proof-graph-spike.md's "Draft bundle
  // signal"): the structural tier's own detection, run over the SAME
  // userCommits population already selected above. Zero network — every
  // step is a local HEAD-snapshot read/parse or a local git diff walk (see
  // computeStructuralSkills' own comment). Structural slugs are disjoint
  // from every import-tier slug (signatures/package-map.json's payments/*
  // entries and every Tier 2 signature's slug are all plain "payments/
  // <provider>" names, never a "-webhook-flow"/"-flow" structural slug —
  // verified by inspection, see docs/proof-graph-spike.md's H6 "Slug-per-
  // provider decision"), so the two arrays below can never collide on slug.
  const structuralStart = Date.now();
  const structuralSkills = await computeStructuralSkills(opts.repoPath, userCommits, opts.skillDetectOptions?.taxonomyPath);
  debugLog(`structural detection: ${structuralSkills.length} claimed finding(s) in ${Date.now() - structuralStart}ms`);

  // Deterministic merge (principle 4, "User-reviewed": byte-identical output
  // across runs over the same history) — same sort convention detectSkills
  // itself already applies to its own array.
  const detectedSkills = [...importSkills, ...structuralSkills].sort((a, b) =>
    a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0
  );

  const dateForensics = computeDateForensics(userCommits);

  const bundle: Bundle = {
    schema_version: "1.2.0",
    runner: "local",
    tool_version: opts.toolVersion,
    created_at: now.toISOString(),
    repo: { host_type: hostType, age_days: ageDays, repo_fingerprint: repoFingerprint },
    identity: {
      author_identity_hashes: authorHashes,
      other_contributors_count: otherContributorsCount,
    },
    commits: {
      user_total: userCommits.length,
      first_at: firstAt.toISOString(),
      last_at: lastAt.toISOString(),
      span_days: spanDays,
      hour_histogram: hourHistogram,
      weekday_histogram: weekdayHistogram,
    },
    signed: { count: signedCount, ratio: signedCount / userCommits.length },
    languages,
    categories,
    detected_skills: detectedSkills,
    ownership: { user_commit_ratio: userCommits.length / allCommits.length },
    integrity: {
      merkle_root: merkleRoot(userCommits.map((c) => c.sha)),
      algorithm: "sha256",
      date_forensics: dateForensics,
    },
    attestation: { authorized_confirmation: true, confirmed_at: now.toISOString() },
  };

  // Final gate before the bundle reaches any caller (scan's stdout, a
  // future submit): the bundle's fields are all structurally bounded today
  // and can't carry a secret, but this is the regression guard for the
  // day a bug or a new field lets one through.
  assertNoSecrets(JSON.stringify(bundle));

  return bundle;
}

/**
 * H7 of the proof-graph spike (docs/proof-graph-spike.md's "Draft bundle
 * signal") — the structural tier's contribution to `detected_skills`. Runs
 * the real proof-graph pipeline (HEAD snapshot -> parse -> graph -> anchors
 * -> classification), the same sequence test/proof-graph/detection.test.ts's
 * `runPipeline` exercises end to end, and maps ONLY claimed findings to
 * bundle entries.
 *
 * Fixed rules (see this milestone's task in GOALS-proof-graph-spike.md):
 *   - Only `claimed === true` findings ever produce an entry. `claimed` is
 *     already the correct gate on the StructuralFinding side (confidence
 *     "direct"/"inferred" AND attributed) — AMBIGUOUS and unattributed
 *     findings never claim (see StructuralFinding.claimed's own comment in
 *     infer.ts), and a `searchBounded` finding always degrades to
 *     "ambiguous" first, so it's excluded the same way.
 *   - An entry carries ONLY { slug, commit_count, first_seen, last_seen,
 *     evidence: "structural", confidence } — no paths, names, counts of
 *     anchors, or connection info. `finding.anchors`/`finding.connection`
 *     are read here ONLY to compute the anchor-file path set passed into
 *     summarizeTouchedCommits, never copied into the returned entry.
 *   - commit_count/first_seen/last_seen derive from the user's own commits
 *     whose added lines touched one of the finding's anchor-bearing files
 *     (summarizeTouchedCommits, infer.ts) — never from the graph itself.
 *
 * Zero network: readHeadSnapshot/collectUserTouchedFileDetails are both
 * local-only (a HEAD tree read and a batched `git show`, respectively);
 * TscParserAdapter/buildGraph/findAnchors/inferStructuralSkills never touch
 * the filesystem or network at all. The graph itself is never returned or
 * held past this function's own scope — only the small, bounded
 * DetectedSkill[] this function returns crosses back into runScan.
 */
async function computeStructuralSkills(
  repoPath: string,
  userCommits: RawCommit[],
  taxonomyPath?: string
): Promise<DetectedSkill[]> {
  const snapshot = await readHeadSnapshot(repoPath);
  const adapter = new TscParserAdapter();
  const parsed = snapshot.map((f) => adapter.parse(f.path, f.content));
  const graph = buildGraph(parsed);
  const anchors = findAnchors(graph);

  const touchedDetails = await collectUserTouchedFileDetails(repoPath, userCommits);
  const userTouchedFiles = new Set(touchedDetails.keys());

  const findings = inferStructuralSkills(graph, anchors, userTouchedFiles, { taxonomyPath });

  const entries: DetectedSkill[] = [];
  for (const finding of findings) {
    if (!finding.claimed) continue;
    // claimed guarantees confidence is "direct" or "inferred" (never
    // "ambiguous" — see StructuralFinding.claimed's own comment) and
    // attributed is true, so at least one of this finding's own anchor
    // paths is present in touchedDetails; summarize over exactly those
    // paths, never the whole repo's touched-file population.
    const summary = summarizeTouchedCommits(
      touchedDetails,
      finding.anchors.map((a) => a.path)
    );
    if (!summary) {
      // Defensive only — see summarizeTouchedCommits' own comment on why
      // this shouldn't be reachable for a claimed finding.
      throw new ScanError(`Internal error: claimed structural finding "${finding.slug}" has no touched-commit summary.`);
    }
    entries.push({
      slug: finding.slug,
      commit_count: summary.count,
      first_seen: summary.first.toISOString(),
      last_seen: summary.last.toISOString(),
      evidence: "structural",
      confidence: finding.confidence as "direct" | "inferred",
    });
  }

  return entries;
}

const MISMATCH_THRESHOLD_MS = 48 * 60 * 60 * 1000;
const BURST_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Rewrite-forensics aggregates from git's two independent dates — see
 * docs/schema.md's `integrity.date_forensics` section for the full
 * measurement contract, expected ranges, and the "heuristic, never a local
 * verdict" caveat. Computed over the same `userCommits` population as
 * `commits.*`/the histograms above (merges included, `--since`-windowed the
 * same way) — no new commit population, only a second date read per commit
 * already being read anyway.
 *
 * Min/max are computed with an explicit loop rather than `Math.max(...arr)`
 * — spreading tens of thousands of arguments into `Math.max` risks blowing
 * the engine's call-argument limit on the huge-repo fixtures this codebase
 * already tests against (see test/slow/huge-repo.test.ts).
 */
function computeDateForensics(userCommits: RawCommit[]): DateForensicsInfo {
  let minAuthor = Infinity;
  let maxAuthor = -Infinity;
  let minCommitter = Infinity;
  let maxCommitter = -Infinity;
  let mismatchCount = 0;
  const committerTimes: number[] = [];

  for (const c of userCommits) {
    const authorMs = c.authorDate.getTime();
    const committerMs = c.committerDate.getTime();
    if (authorMs < minAuthor) minAuthor = authorMs;
    if (authorMs > maxAuthor) maxAuthor = authorMs;
    if (committerMs < minCommitter) minCommitter = committerMs;
    if (committerMs > maxCommitter) maxCommitter = committerMs;
    if (Math.abs(committerMs - authorMs) > MISMATCH_THRESHOLD_MS) mismatchCount++;
    committerTimes.push(committerMs);
  }

  return {
    author_span_days: Math.floor((maxAuthor - minAuthor) / MS_PER_DAY),
    committer_span_days: Math.floor((maxCommitter - minCommitter) / MS_PER_DAY),
    mismatch_ratio: mismatchCount / userCommits.length,
    committer_burst_ratio: maxCommitsInWindow(committerTimes, BURST_WINDOW_MS) / userCommits.length,
  };
}

/**
 * Largest number of `times` (epoch ms) that fall inside any single window
 * of `windowMs` width — a sorted two-pointer sweep, O(n log n) overall.
 * Used to find the densest 24h cluster of committer dates without holding
 * every pairwise gap in memory.
 */
function maxCommitsInWindow(times: number[], windowMs: number): number {
  const sorted = [...times].sort((a, b) => a - b);
  let left = 0;
  let best = 0;
  for (let right = 0; right < sorted.length; right++) {
    while (sorted[right] - sorted[left] > windowMs) left++;
    const count = right - left + 1;
    if (count > best) best = count;
  }
  return best;
}

function computeChurnBreakdown(userCommits: RawCommit[]): {
  languages: LanguageShare[];
  categories: CategoryShare[];
} {
  const generatedPaths = heuristicallyGeneratedPaths(userCommits);

  const churnByExt = new Map<string, number>();
  const churnByCategory = new Map<CategoryName, number>();
  const commitsByCategory = new Map<CategoryName, Set<string>>();
  let langChurnTotal = 0;
  let categoryChurnTotal = 0;

  for (const c of userCommits) {
    const categoriesTouched = new Set<CategoryName>();
    for (const f of c.churn) {
      const churn = f.added + f.deleted;
      if (churn === 0) continue;
      // Lockfiles, minified bundles, build-output dirs, and single-commit
      // generated dumps are checked-in artifacts, not authored work — see
      // docs/schema.md's "What is excluded from churn".
      if (isExcludedPath(f.path) || generatedPaths.has(f.path)) continue;

      const ext = normalizeExtension(f.path);
      if (ext) {
        langChurnTotal += churn;
        churnByExt.set(ext, (churnByExt.get(ext) ?? 0) + churn);
      }

      categoryChurnTotal += churn;
      const category = categorize(f.path);
      churnByCategory.set(category, (churnByCategory.get(category) ?? 0) + churn);
      categoriesTouched.add(category);
    }
    for (const category of categoriesTouched) {
      if (!commitsByCategory.has(category)) commitsByCategory.set(category, new Set());
      commitsByCategory.get(category)!.add(c.sha);
    }
  }

  const languages: LanguageShare[] =
    langChurnTotal > 0
      ? [...churnByExt.entries()].map(([extension, churn]) => ({
          extension,
          share: churn / langChurnTotal,
        }))
      : [];

  const categories: CategoryShare[] =
    categoryChurnTotal > 0
      ? [...churnByCategory.entries()].map(([name, churn]) => ({
          name,
          commit_count: commitsByCategory.get(name)!.size,
          churn_share: churn / categoryChurnTotal,
        }))
      : [];

  return { languages, categories };
}
