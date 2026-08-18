import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ScanError } from "./errors.js";
import type { Bundle } from "./types.js";

export const NPM_REGISTRY_BASE_URL = "https://registry.npmjs.org";
export const NPM_REQUEST_TIMEOUT_MS = 1_500;
export const NPM_CHECK_DEADLINE_MS = 3_000;
export const NPM_CHECK_MAX_CONCURRENCY = 4;

export const NPM_RELEASE_CHECK_DISCLOSURE =
  "After confirmation, Redential will query the npm registry for selected public package names associated with the detected skills. " +
  "npm receives those package names and standard connection data (such as your IP address), but never your source, repository URL, bundle, or Redential token.";

const DEFAULT_PACKAGE_MAP_PATH = fileURLToPath(new URL("../signatures/package-map.json", import.meta.url));
const CANONICAL_UTC_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/;

interface PackageMapFile {
  map?: Record<string, string>;
  npmReleaseCheckPackages?: unknown;
}

export interface NpmReleaseCheckMetadata {
  packageToSlug: Map<string, string>;
  packagesBySlug: Map<string, string[]>;
}

export interface NpmAnachronism {
  slug: string;
  firstSeen: string;
  earliestMappedNpmRelease: string;
}

export type NpmPackumentTransport = (url: string, timeoutMs: number) => Promise<unknown | null>;

export interface NpmAnachronismOptions {
  packageMapPath?: string;
  now?: () => number;
  registryBaseUrl?: string;
}

function metadataError(path: string): ScanError {
  return new ScanError(`Invalid npm release-check metadata in package map file: ${path}`);
}

export function loadNpmReleaseCheckMetadata(
  path: string = DEFAULT_PACKAGE_MAP_PATH
): NpmReleaseCheckMetadata {
  let parsed: PackageMapFile;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as PackageMapFile;
  } catch {
    throw metadataError(path);
  }

  if (!parsed.map || typeof parsed.map !== "object" || !Array.isArray(parsed.npmReleaseCheckPackages)) {
    throw metadataError(path);
  }

  const packageToSlug = new Map(Object.entries(parsed.map));
  const eligiblePackages = parsed.npmReleaseCheckPackages;
  if (
    !eligiblePackages.every((packageName): packageName is string =>
      typeof packageName === "string" && packageName.length > 0 && packageToSlug.has(packageName)
    ) ||
    new Set(eligiblePackages).size !== eligiblePackages.length
  ) {
    throw metadataError(path);
  }

  const packagesBySlug = new Map<string, string[]>();
  for (const packageName of eligiblePackages) {
    const slug = packageToSlug.get(packageName)!;
    const packages = packagesBySlug.get(slug) ?? [];
    packages.push(packageName);
    packagesBySlug.set(slug, packages);
  }
  for (const packages of packagesBySlug.values()) packages.sort();

  return { packageToSlug, packagesBySlug };
}

export function npmReleaseCheckCandidates(
  bundle: Bundle,
  packageMapPath?: string
): Map<string, string[]> {
  const { packagesBySlug } = loadNpmReleaseCheckMetadata(packageMapPath);
  const detectedSlugs = new Set(bundle.detected_skills.map((skill) => skill.slug));
  return new Map(
    [...packagesBySlug]
      .filter(([slug]) => detectedSlugs.has(slug))
      .sort(([a], [b]) => a.localeCompare(b))
  );
}

export function hasNpmReleaseCheckCandidates(bundle: Bundle, packageMapPath?: string): boolean {
  try {
    return npmReleaseCheckCandidates(bundle, packageMapPath).size > 0;
  } catch {
    return false;
  }
}

/** Parses only npm/CLI canonical UTC timestamps, with explicit calendar validation. */
export function parseCanonicalUtcTimestamp(value: string): number | null {
  const match = CANONICAL_UTC_TIMESTAMP.exec(value);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, millisText = "000"] = match;
  const parts = [yearText, monthText, dayText, hourText, minuteText, secondText, millisText].map(Number);
  const [year, month, day, hour, minute, second, millis] = parts;
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return null;

  const timestamp = Date.UTC(year, month - 1, day, hour, minute, second, millis);
  const date = new Date(timestamp);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second ||
    date.getUTCMilliseconds() !== millis
  ) {
    return null;
  }
  return timestamp;
}

function createdTimestamp(packument: unknown): { value: string; timestamp: number } | null {
  if (!packument || typeof packument !== "object") return null;
  const time = (packument as { time?: unknown }).time;
  if (!time || typeof time !== "object") return null;
  const created = (time as { created?: unknown }).created;
  if (typeof created !== "string") return null;
  const timestamp = parseCanonicalUtcTimestamp(created);
  return timestamp === null ? null : { value: created, timestamp };
}

/**
 * Checks the conservative package subset selected by package-map metadata.
 * Every started request is awaited; the transport owns timeout cancellation.
 */
export async function checkNpmAnachronisms(
  bundle: Bundle,
  transport: NpmPackumentTransport,
  options: NpmAnachronismOptions = {}
): Promise<NpmAnachronism[]> {
  const candidates = npmReleaseCheckCandidates(bundle, options.packageMapPath);
  if (candidates.size === 0) return [];

  const now = options.now ?? Date.now;
  const deadline = now() + NPM_CHECK_DEADLINE_MS;
  const registryBaseUrl = options.registryBaseUrl ?? NPM_REGISTRY_BASE_URL;
  const packageNames = [...new Set([...candidates.values()].flat())].sort();
  const results = new Map<string, unknown | null>();
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < packageNames.length) {
      const remainingMs = Math.floor(deadline - now());
      if (remainingMs < 1) return;
      const packageName = packageNames[nextIndex++];
      const timeoutMs = Math.min(NPM_REQUEST_TIMEOUT_MS, remainingMs);
      const url = `${registryBaseUrl}/${encodeURIComponent(packageName)}`;
      try {
        results.set(packageName, await transport(url, timeoutMs));
      } catch {
        results.set(packageName, null);
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(NPM_CHECK_MAX_CONCURRENCY, packageNames.length) },
    () => worker()
  );
  await Promise.all(workers);

  const skillsBySlug = new Map(bundle.detected_skills.map((skill) => [skill.slug, skill]));
  const findings: NpmAnachronism[] = [];
  for (const [slug, packages] of candidates) {
    const firstSeen = skillsBySlug.get(slug)?.first_seen;
    if (!firstSeen) continue;
    const firstSeenTimestamp = parseCanonicalUtcTimestamp(firstSeen);
    if (firstSeenTimestamp === null) continue;

    const releases = packages.map((packageName) => createdTimestamp(results.get(packageName)));
    if (releases.some((release) => release === null)) continue;
    const earliest = (releases as { value: string; timestamp: number }[]).reduce((a, b) =>
      a.timestamp <= b.timestamp ? a : b
    );
    if (firstSeenTimestamp < earliest.timestamp) {
      findings.push({
        slug,
        firstSeen,
        earliestMappedNpmRelease: earliest.value,
      });
    }
  }
  return findings;
}

export function formatNpmAnachronismWarning(findings: NpmAnachronism[]): string | null {
  if (findings.length === 0) return null;
  const lines = [
    "Warning: release-date checks found possible timeline conflicts; upload will continue.",
    ...[...findings]
      .sort((a, b) => a.slug.localeCompare(b.slug))
      .map(
        (finding) =>
          `- \`${finding.slug}\` was first seen on ${finding.firstSeen.slice(0, 10)}, before the earliest mapped npm release reference audited for this skill (${finding.earliestMappedNpmRelease.slice(0, 10)}).`
      ),
    "Vendored or private forked copies can legitimately predate a public npm release; independent verification may still flag these dates.",
  ];
  return lines.join("\n");
}
