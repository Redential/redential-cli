import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadPackageMap, loadTaxonomySlugs } from "../src/skill-detect.js";

const PACKAGE_MAP_PATH = fileURLToPath(new URL("../signatures/package-map.json", import.meta.url));
const TAXONOMY_PATH = fileURLToPath(new URL("../taxonomy.json", import.meta.url));

const SLUG_SHAPE = /^[a-z0-9]+(-[a-z0-9]+)*\/[a-z0-9]+(-[a-z0-9]+)*$/;

describe("signatures/package-map.json", () => {
  it("has at least 400 entries", () => {
    const map = loadPackageMap(PACKAGE_MAP_PATH);
    expect(map.size).toBeGreaterThanOrEqual(400);
  });

  it("has at least 585 entries (400 baseline + 120 from the Rust/Java/Kotlin/C#/Swift milestone)", () => {
    const map = loadPackageMap(PACKAGE_MAP_PATH);
    expect(map.size).toBeGreaterThanOrEqual(585);
  });

  it("no dotted key is a strict prefix of another dotted key", () => {
    // Java/Kotlin/C# imports emit candidate prefixes at every depth (1-3)
    // and let map membership decide which one is real (import-detect.ts's
    // dottedPathPrefixes) — if the map ever contained both a key and one
    // of its own strict dot-prefixes (e.g. "org.apache" AND
    // "org.apache.kafka"), a single import could credit two DIFFERENT
    // slugs at once. This is the data-side half of that guarantee; the
    // extractor's multi-depth emission is the other half.
    const map = loadPackageMap(PACKAGE_MAP_PATH);
    const dottedKeys = [...map.keys()].filter((k) => k.includes("."));
    const violations: string[] = [];
    for (const key of dottedKeys) {
      const parts = key.split(".");
      for (let depth = 1; depth < parts.length; depth++) {
        const prefix = parts.slice(0, depth).join(".");
        if (prefix !== key && map.has(prefix)) {
          violations.push(`"${prefix}" is a strict prefix of "${key}"`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("every value is a member of taxonomy.json (closed vocabulary)", () => {
    const map = loadPackageMap(PACKAGE_MAP_PATH);
    const taxonomySlugs = loadTaxonomySlugs(TAXONOMY_PATH);
    for (const [pkg, slug] of map) {
      expect(taxonomySlugs.has(slug), `package "${pkg}" maps to slug "${slug}", not in taxonomy.json`).toBe(true);
    }
  });

  it("every value matches the bundle schema's slug shape", () => {
    const map = loadPackageMap(PACKAGE_MAP_PATH);
    for (const [pkg, slug] of map) {
      expect(SLUG_SHAPE.test(slug), `package "${pkg}" maps to malformed slug "${slug}"`).toBe(true);
    }
  });

  it("has no duplicate package keys in the raw file (JSON.parse would silently keep only the last one)", () => {
    // JSON.parse never surfaces a duplicate top-level key — the second
    // occurrence silently wins, so a real duplicate-key bug would be
    // invisible to every check above. This scans the RAW file text instead,
    // matching the same `"key":` shape import-detect's own normalized
    // package names can take.
    const raw = readFileSync(PACKAGE_MAP_PATH, "utf8");
    const mapBodyStart = raw.indexOf('"map"');
    const body = raw.slice(mapBodyStart);
    const keyRe = /"((?:[^"\\]|\\.)*)"\s*:/g;
    const keys: string[] = [];
    for (const m of body.matchAll(keyRe)) {
      if (m[1] !== "map") keys.push(m[1]);
    }
    const seen = new Set<string>();
    const dupes = new Set<string>();
    for (const k of keys) {
      if (seen.has(k)) dupes.add(k);
      seen.add(k);
    }
    expect([...dupes]).toEqual([]);
  });
});
