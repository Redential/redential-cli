import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkNpmAnachronisms,
  formatNpmAnachronismWarning,
  loadNpmReleaseCheckMetadata,
  NPM_RELEASE_CHECK_DISCLOSURE,
  npmReleaseCheckCandidates,
  parseCanonicalUtcTimestamp,
  type NpmPackumentTransport,
} from "../src/npm-anachronism.js";
import { loadPackageMap, loadSignatures } from "../src/skill-detect.js";
import { fetchNpmPackument } from "../src/submit.js";
import type { Bundle, DetectedSkill } from "../src/types.js";

const PACKAGE_MAP_PATH = fileURLToPath(new URL("../signatures/package-map.json", import.meta.url));
const SIGNATURES_DIR = fileURLToPath(new URL("../signatures", import.meta.url));
const dirs: string[] = [];

function bundleWithSkills(...detectedSkills: DetectedSkill[]): Bundle {
  return {
    schema_version: "1.4.0",
    runner: "local",
    tool_version: "0.13.0",
    created_at: "2026-08-14T00:00:00.000Z",
    repo: { host_type: "none", age_days: 1, repo_fingerprint: "abc" },
    identity: { author_identity_hashes: ["hash"], other_contributors_count: 0 },
    commits: {
      user_total: 1,
      first_at: "2022-01-01T00:00:00.000Z",
      last_at: "2022-01-01T00:00:00.000Z",
      span_days: 0,
      hour_histogram: new Array(24).fill(0),
      weekday_histogram: new Array(7).fill(0),
    },
    signed: { count: 0, ratio: 0 },
    languages: [],
    categories: [],
    detected_skills: detectedSkills,
    ownership: { user_commit_ratio: 1 },
    integrity: {
      merkle_root: "0".repeat(64),
      algorithm: "rfc6962-sha256",
      date_forensics: {
        author_span_days: 0,
        committer_span_days: 0,
        mismatch_ratio: 0,
        committer_burst_ratio: 0,
      },
    },
    attestation: { authorized_confirmation: true, confirmed_at: "2026-08-14T00:00:00.000Z" },
  };
}

function skill(slug: string, firstSeen = "2022-06-01T00:00:00.000Z"): DetectedSkill {
  return { slug, commit_count: 1, first_seen: firstSeen, last_seen: firstSeen };
}

function packument(created: string): unknown {
  return { time: { created } };
}

function customMap(packages: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "redential-npm-map-"));
  dirs.push(dir);
  const path = join(dir, "package-map.json");
  writeFileSync(
    path,
    JSON.stringify({ map: Object.fromEntries(packages.map((name) => [name, "auth/better-auth"])), npmReleaseCheckPackages: packages })
  );
  return path;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("npm release-check metadata", () => {
  it("contains exactly the four audited package keys and preserves loadPackageMap behavior", () => {
    const raw = JSON.parse(readFileSync(PACKAGE_MAP_PATH, "utf8")) as {
      map: Record<string, string>;
      npmReleaseCheckPackages: string[];
    };
    expect(raw.npmReleaseCheckPackages).toEqual([
      "better-auth",
      "@lemonsqueezy/lemonsqueezy.js",
      "@paddle/paddle-js",
      "@paddle/paddle-node-sdk",
    ]);

    const loaded = loadNpmReleaseCheckMetadata(PACKAGE_MAP_PATH);
    expect(loadPackageMap(PACKAGE_MAP_PATH)).toEqual(new Map(Object.entries(raw.map)));
    expect(loaded.packageToSlug).toEqual(loadPackageMap(PACKAGE_MAP_PATH));
  });

  it("includes every package-map key for each eligible slug and excludes Tier 2 slugs", () => {
    const { packageToSlug, packagesBySlug } = loadNpmReleaseCheckMetadata(PACKAGE_MAP_PATH);
    for (const [slug, eligiblePackages] of packagesBySlug) {
      const allMappedPackages = [...packageToSlug]
        .filter(([, mappedSlug]) => mappedSlug === slug)
        .map(([packageName]) => packageName)
        .sort();
      expect(eligiblePackages).toEqual(allMappedPackages);
    }

    const tier2Slugs = new Set(loadSignatures(SIGNATURES_DIR).map((signature) => signature.slug));
    for (const slug of packagesBySlug.keys()) expect(tier2Slugs.has(slug)).toBe(false);
  });
});

describe("checkNpmAnachronisms", () => {
  it("works only for detected eligible slugs; ambiguous ecosystem slugs schedule no request", async () => {
    const urls: string[] = [];
    const transport: NpmPackumentTransport = async (url) => {
      urls.push(url);
      return packument("2023-09-18T12:00:00.000Z");
    };
    const findings = await checkNpmAnachronisms(
      bundleWithSkills(skill("ai/openai-api"), skill("auth/firebase-auth"), skill("auth/better-auth")),
      transport
    );

    expect(urls).toEqual(["https://registry.npmjs.org/better-auth"]);
    expect(findings.map((finding) => finding.slug)).toEqual(["auth/better-auth"]);
  });

  it("encodes scoped package names as one path segment and schedules deduplicated packages deterministically", async () => {
    const urls: string[] = [];
    await checkNpmAnachronisms(
      bundleWithSkills(skill("payments/paddle"), skill("payments/lemonsqueezy")),
      async (url) => {
        urls.push(url);
        return packument("2021-01-01T00:00:00Z");
      }
    );
    expect(urls).toEqual([
      "https://registry.npmjs.org/%40lemonsqueezy%2Flemonsqueezy.js",
      "https://registry.npmjs.org/%40paddle%2Fpaddle-js",
      "https://registry.npmjs.org/%40paddle%2Fpaddle-node-sdk",
    ]);
  });

  it("warns only when first_seen is strictly earlier and uses the earliest complete multi-package release", async () => {
    const dates = new Map([
      ["%40paddle%2Fpaddle-js", "2022-04-01T00:00:00.000Z"],
      ["%40paddle%2Fpaddle-node-sdk", "2023-04-01T00:00:00Z"],
    ]);
    const run = (firstSeen: string) =>
      checkNpmAnachronisms(bundleWithSkills(skill("payments/paddle", firstSeen)), async (url) => {
        const key = url.slice(url.lastIndexOf("/") + 1);
        return packument(dates.get(key)!);
      });

    expect(await run("2022-03-31T23:59:59.000Z")).toEqual([
      {
        slug: "payments/paddle",
        firstSeen: "2022-03-31T23:59:59.000Z",
        earliestMappedNpmRelease: "2022-04-01T00:00:00.000Z",
      },
    ]);
    expect(await run("2022-04-01T00:00:00.000Z")).toEqual([]);
    expect(await run("2024-01-01T00:00:00.000Z")).toEqual([]);
  });

  it("omits a multi-package slug when any response is missing, malformed, invalid, null, or throws", async () => {
    const invalidResults: Array<unknown | Error> = [
      null,
      {},
      { time: {} },
      packument("not-a-date"),
      packument("2023-02-29T00:00:00Z"),
      new Error("network failure"),
    ];
    for (const invalid of invalidResults) {
      const findings = await checkNpmAnachronisms(bundleWithSkills(skill("payments/paddle")), async (url) => {
        if (url.includes("node-sdk")) {
          if (invalid instanceof Error) throw invalid;
          return invalid;
        }
        return packument("2023-01-01T00:00:00Z");
      });
      expect(findings).toEqual([]);
    }
  });

  it("limits concurrency to four without sleeps", async () => {
    const path = customMap(["p6", "p2", "p4", "p1", "p5", "p3"]);
    let active = 0;
    let maxActive = 0;
    const resolvers: Array<() => void> = [];
    const transport: NpmPackumentTransport = () => {
      active++;
      maxActive = Math.max(maxActive, active);
      return new Promise((resolve) => {
        resolvers.push(() => {
          active--;
          resolve(packument("2023-01-01T00:00:00Z"));
        });
      });
    };

    const checking = checkNpmAnachronisms(bundleWithSkills(skill("auth/better-auth")), transport, {
      packageMapPath: path,
    });
    await Promise.resolve();
    expect(maxActive).toBe(4);
    while (resolvers.length > 0) {
      resolvers.shift()!();
      await Promise.resolve();
    }
    await checking;
    expect(maxActive).toBe(4);
    expect(active).toBe(0);
  });

  it("uses the global remaining deadline for queued work and resolves only after every started request settles", async () => {
    const path = customMap(["p1", "p2", "p3", "p4", "p5"]);
    let now = 10_000;
    let active = 0;
    const calls: Array<{ timeoutMs: number; resolve: () => void }> = [];
    const checking = checkNpmAnachronisms(
      bundleWithSkills(skill("auth/better-auth")),
      (_url, timeoutMs) => {
        active++;
        return new Promise((resolve) => {
          calls.push({
            timeoutMs,
            resolve: () => {
              active--;
              resolve(packument("2023-01-01T00:00:00Z"));
            },
          });
        });
      },
      { packageMapPath: path, now: () => now }
    );
    await Promise.resolve();
    expect(calls).toHaveLength(4);
    expect(calls.map((call) => call.timeoutMs)).toEqual([1500, 1500, 1500, 1500]);

    now = 12_999;
    calls.slice(0, 4).forEach((call) => call.resolve());
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toHaveLength(5);
    expect(calls[4].timeoutMs).toBe(1);
    expect(active).toBe(1);
    calls[4].resolve();
    await checking;
    expect(active).toBe(0);
  });

  it("does not start queued work once the global deadline is exhausted", async () => {
    const path = customMap(["p1", "p2", "p3", "p4", "p5"]);
    let now = 0;
    const resolvers: Array<() => void> = [];
    const checking = checkNpmAnachronisms(
      bundleWithSkills(skill("auth/better-auth")),
      () => new Promise((resolve) => resolvers.push(() => resolve(null))),
      { packageMapPath: path, now: () => now }
    );
    await Promise.resolve();
    expect(resolvers).toHaveLength(4);
    now = 3_000;
    resolvers.forEach((resolve) => resolve());
    await checking;
    expect(resolvers).toHaveLength(4);
  });
});

describe("production npm transport fail-open behavior", () => {
  it.each([404, 429, 500])("returns null for HTTP %s", async (status) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ time: { created: "2023-01-01T00:00:00Z" } }), {
        status,
        headers: { "content-type": "application/json" },
      })
    );

    await expect(fetchNpmPackument("https://registry.npmjs.org/better-auth", 1500)).resolves.toBeNull();
  });

  it("returns null for malformed JSON", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{not-json", { status: 200, headers: { "content-type": "application/json" } })
    );
    await expect(fetchNpmPackument("https://registry.npmjs.org/better-auth", 1500)).resolves.toBeNull();
  });

  it("aborts an in-flight production request at its timeout and resolves fail-open", async () => {
    let receivedSignal: AbortSignal | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
      receivedSignal = init?.signal ?? undefined;
      return new Promise((_resolve, reject) => {
        receivedSignal?.addEventListener("abort", () => reject(new Error("aborted by test signal")), { once: true });
      });
    });

    await expect(fetchNpmPackument("https://registry.npmjs.org/better-auth", 5)).resolves.toBeNull();
    expect(receivedSignal).toBeDefined();
    expect(receivedSignal!.aborted).toBe(true);
  });
});

describe("date and message formatting", () => {
  it("accepts only canonical UTC timestamps with real calendar components", () => {
    expect(parseCanonicalUtcTimestamp("2024-02-29T23:59:59Z")).not.toBeNull();
    expect(parseCanonicalUtcTimestamp("2024-02-29T23:59:59.123Z")).not.toBeNull();
    for (const invalid of [
      "2023-02-29T00:00:00Z",
      "2024-13-01T00:00:00Z",
      "2024-01-01T24:00:00Z",
      "2024-01-01",
      "2024-01-01T00:00:00+00:00",
      "2024-01-01T00:00:00.12Z",
    ]) {
      expect(parseCanonicalUtcTimestamp(invalid), invalid).toBeNull();
    }
  });

  it("formats deterministic, non-accusatory disclosure and warning copy", () => {
    expect(NPM_RELEASE_CHECK_DISCLOSURE).toContain("package names");
    expect(NPM_RELEASE_CHECK_DISCLOSURE).toContain("IP address");
    expect(NPM_RELEASE_CHECK_DISCLOSURE).not.toContain("anonymous");

    const warning = formatNpmAnachronismWarning([
      {
        slug: "payments/paddle",
        firstSeen: "2021-01-01T00:00:00.000Z",
        earliestMappedNpmRelease: "2022-01-01T00:00:00Z",
      },
      {
        slug: "auth/better-auth",
        firstSeen: "2022-06-01T00:00:00.000Z",
        earliestMappedNpmRelease: "2023-09-18T00:00:00Z",
      },
    ]);
    expect(warning).toBe(
      "Warning: release-date checks found possible timeline conflicts; upload will continue.\n" +
        "- `auth/better-auth` was first seen on 2022-06-01, before the earliest mapped npm release reference audited for this skill (2023-09-18).\n" +
        "- `payments/paddle` was first seen on 2021-01-01, before the earliest mapped npm release reference audited for this skill (2022-01-01).\n" +
        "Vendored or private forked copies can legitimately predate a public npm release; independent verification may still flag these dates."
    );
    expect(warning).not.toMatch(/fraud|fake/i);
    expect(formatNpmAnachronismWarning([])).toBeNull();
  });

  it("returns candidates sorted by slug", () => {
    expect([...npmReleaseCheckCandidates(bundleWithSkills(skill("payments/paddle"), skill("auth/better-auth"))).keys()]).toEqual([
      "auth/better-auth",
      "payments/paddle",
    ]);
  });
});
