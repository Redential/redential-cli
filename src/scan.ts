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
import type { Bundle, CategoryName, LanguageShare, CategoryShare } from "./types.js";

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
  const allCommits = await getAllCommits(opts.repoPath, {
    since: sinceDate,
    onProgress: opts.onProgress ? (scanned) => opts.onProgress!(scanned, total) : undefined,
  });
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
  const detectedSkills = await detectSkills(userCommits, opts.repoPath, opts.skillDetectOptions);

  const bundle: Bundle = {
    schema_version: "1.0.0",
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
    integrity: { merkle_root: merkleRoot(userCommits.map((c) => c.sha)), algorithm: "sha256" },
    attestation: { authorized_confirmation: true, confirmed_at: now.toISOString() },
  };

  // Final gate before the bundle reaches any caller (scan's stdout, a
  // future submit): the bundle's fields are all structurally bounded today
  // and can't carry a secret, but this is the regression guard for the
  // day a bug or a new field lets one through.
  assertNoSecrets(JSON.stringify(bundle));

  return bundle;
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
