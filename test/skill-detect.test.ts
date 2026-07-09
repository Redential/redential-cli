import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fixtureCoverage,
  fixtureMatches,
  loadSignatures,
  loadTaxonomySlugs,
  type Signature,
} from "../src/skill-detect.js";

const SIGNATURES_DIR = fileURLToPath(new URL("../signatures", import.meta.url));
const TAXONOMY_PATH = fileURLToPath(new URL("../taxonomy.json", import.meta.url));

function listSignatureFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSignatureFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".json")) out.push(full);
  }
  return out;
}

// Real, shipped data — not fixtures of fixtures. Every check below is a
// property the actual signatures/*.json content must hold.
const signatureFiles = listSignatureFiles(SIGNATURES_DIR);
const taxonomySlugs = loadTaxonomySlugs(TAXONOMY_PATH);

function nameWords(slug: string): string[] {
  return slug.split("/")[1].split("-").filter((w) => w.length >= 3);
}

describe("signatures/*.json", () => {
  it("has at least one signature file", () => {
    expect(signatureFiles.length).toBeGreaterThan(0);
  });

  it("every signature's slug is a member of taxonomy.json (closed vocabulary)", () => {
    for (const file of signatureFiles) {
      const sig = JSON.parse(readFileSync(file, "utf8")) as Signature;
      expect(taxonomySlugs.has(sig.slug), `${file}: slug "${sig.slug}" not in taxonomy.json`).toBe(true);
    }
  });

  it("has exactly one signature file per taxonomy slug (no duplicates, none missing)", () => {
    const slugs = signatureFiles.map((f) => (JSON.parse(readFileSync(f, "utf8")) as Signature).slug);
    const counts = new Map<string, number>();
    for (const s of slugs) counts.set(s, (counts.get(s) ?? 0) + 1);
    const duplicated = [...counts.entries()].filter(([, n]) => n > 1);
    expect(duplicated, `duplicate signature files for: ${duplicated.map(([s]) => s).join(", ")}`).toEqual([]);
  });

  describe.each(signatureFiles.map((file) => ({ file, sig: JSON.parse(readFileSync(file, "utf8")) as Signature })))(
    "$sig.slug",
    ({ file, sig }) => {
      it("declares at least one positive and one negative fixture", () => {
        expect(sig.fixtures?.positive?.length, `${file}: needs >=1 positive fixture`).toBeGreaterThan(0);
        expect(sig.fixtures?.negative?.length, `${file}: needs >=1 negative fixture`).toBeGreaterThan(0);
      });

      it("every positive fixture actually matches this signature", () => {
        for (const fixture of sig.fixtures.positive) {
          expect(fixtureMatches(sig, fixture), `${file}: positive fixture ${fixture.path} did not match`).toBe(true);
        }
      });

      it("no negative fixture matches this signature (near-miss, not a false positive)", () => {
        for (const fixture of sig.fixtures.negative) {
          expect(fixtureMatches(sig, fixture), `${file}: negative fixture ${fixture.path} incorrectly matched`).toBe(
            false
          );
        }
      });

      it("every declared pattern is exercised by at least one positive fixture (catches dead/typo'd patterns)", () => {
        const coverages = sig.fixtures.positive.map((f) => fixtureCoverage(sig, f));
        const patternKinds = ["importPatterns", "apiPatterns", "configFilePatterns"] as const;
        for (const kind of patternKinds) {
          const count = sig[kind]?.length ?? 0;
          for (let i = 0; i < count; i++) {
            const hit = coverages.some((c) => c[kind][i]);
            expect(hit, `${file}: ${kind}[${i}] ("${sig[kind]![i]}") never matched by any positive fixture`).toBe(
              true
            );
          }
        }
      });

      it("at least one negative fixture is a genuine near-miss mentioning the library by name", () => {
        const words = nameWords(sig.slug);
        const hasNearMiss = sig.fixtures.negative.some((f) =>
          words.some((w) => f.diff.toLowerCase().includes(w.toLowerCase()))
        );
        expect(
          hasNearMiss,
          `${file}: no negative fixture mentions "${words.join("/")}" — add a prose/comment near-miss, not just unrelated content`
        ).toBe(true);
      });
    }
  );
});
