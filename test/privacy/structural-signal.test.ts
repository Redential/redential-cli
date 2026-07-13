// H7 of the proof-graph spike (see docs/schema-change-h7.md — the contract
// this whole file checks against): the structural tier's contribution to
// `detected_skills[]` — `evidence`/`confidence` — is a deliberate, small,
// closed-vocabulary widening of what leaves the machine. This file is the
// milestone's central deliverable: it proves the NEW boundary holds exactly
// as narrowly as the contract states, both by running the real scan pipeline
// against real fixtures (test/privacy/proof-graph-boundaries.test.ts's
// style) and by reading schema/bundle.v1.json directly (no external JSON
// Schema validator dependency exists in this repo, and none is added here —
// see docs/schema-change-h7.md's "Backward compatibility" section for the
// exact claims being checked).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanup, commit, createRepo } from "../support/fixtures.js";
import { fixtureDirectPattern, fixtureOtherAuthor, fixtureStripeUnused, USER } from "../proof-graph/fixtures.js";
import { runScan } from "../../src/scan.js";
import type { Bundle } from "../../src/types.js";

const dirs: string[] = [];

function tempConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "redential-config-"));
  dirs.push(dir);
  return dir;
}

// One scan per fixture, reused across every assertion below — same
// beforeAll pattern test/privacy/proof-graph-boundaries.test.ts already uses,
// to keep this file's runtime modest.
let directBundle: Bundle;
let directBundleJson: string;
let ambiguousBundle: Bundle;
let ambiguousBundleJson: string;
let unattributedBundle: Bundle;
let unattributedBundleJson: string;
let noStructuralBundle: Bundle;

beforeAll(async () => {
  const directDir = fixtureDirectPattern();
  dirs.push(directDir);
  directBundle = await runScan({
    repoPath: directDir,
    authors: [USER.email],
    confirmed: true,
    toolVersion: "0.1.0",
    configDir: tempConfigDir(),
  });
  directBundleJson = JSON.stringify(directBundle);

  const ambiguousDir = fixtureStripeUnused();
  dirs.push(ambiguousDir);
  ambiguousBundle = await runScan({
    repoPath: ambiguousDir,
    authors: [USER.email],
    confirmed: true,
    toolVersion: "0.1.0",
    configDir: tempConfigDir(),
  });
  ambiguousBundleJson = JSON.stringify(ambiguousBundle);

  const unattributedDir = fixtureOtherAuthor();
  dirs.push(unattributedDir);
  unattributedBundle = await runScan({
    repoPath: unattributedDir,
    authors: [USER.email],
    confirmed: true,
    toolVersion: "0.1.0",
    configDir: tempConfigDir(),
  });
  unattributedBundleJson = JSON.stringify(unattributedBundle);

  // A repo with NO structural pattern at all (no payment provider touched,
  // no anchors anywhere) — the additive-compat case: schema 1.2.0, but every
  // entry (there are none here, since nothing matches any tier) still shaped
  // like a pre-H7 (1.1.0) bundle would have been.
  const plainDir = createRepo();
  dirs.push(plainDir);
  commit(plainDir, {
    message: "add a plain util file",
    authorName: USER.name,
    authorEmail: USER.email,
    files: { "src/util.ts": ["export function noop() {", "  return null;", "}", ""].join("\n") },
  });
  noStructuralBundle = await runScan({
    repoPath: plainDir,
    authors: [USER.email],
    confirmed: true,
    toolVersion: "0.1.0",
    configDir: tempConfigDir(),
  });
});

// Cleanup runs once, after all describe blocks below have used the shared
// fixtures — mirrors the afterAll pattern in proof-graph-boundaries.test.ts.
afterAll(() => {
  while (dirs.length > 0) cleanup(dirs.pop()!);
});

describe("structural signal (H7, docs/schema-change-h7.md)", () => {
  // (a) Exact-shape whitelist.
  it("a claimed structural entry has EXACTLY {slug, commit_count, first_seen, last_seen, evidence, confidence} — no more, no less", () => {
    const structuralEntry = directBundle.detected_skills.find((s) => s.slug === "payments/payment-webhook-flow");
    expect(structuralEntry, "fixtureDirectPattern must produce a claimed structural entry").toBeDefined();

    const keys = Object.keys(structuralEntry!).sort();
    expect(keys).toEqual(["commit_count", "confidence", "evidence", "first_seen", "last_seen", "slug"].sort());

    expect(structuralEntry!.evidence).toBe("structural");
    expect(["direct", "inferred"]).toContain(structuralEntry!.confidence);

    // Import-tier entries in the SAME bundle carry neither field — absence
    // is what "import tier" means under this contract (implementation
    // decision (a) in docs/schema-change-h7.md: the "import" enum value is
    // reserved for a future explicit-tagging change and is never emitted by
    // this version's detection path).
    const importEntry = directBundle.detected_skills.find((s) => s.slug === "payments/stripe");
    expect(importEntry, "Tier 1 import-tier positive control").toBeDefined();
    expect(Object.keys(importEntry!).sort()).toEqual(["commit_count", "first_seen", "last_seen", "slug"].sort());
    expect("evidence" in importEntry!).toBe(false);
    expect("confidence" in importEntry!).toBe(false);
  });

  // (b) Ambiguous never travels.
  it("an AMBIGUOUS structural finding never enters the bundle, even though its Tier 1 import positive control does", () => {
    expect(ambiguousBundle.detected_skills.map((s) => s.slug)).toContain("payments/stripe");
    expect(ambiguousBundleJson).not.toContain("payments/payment-webhook-flow");
  });

  // (c) Unattributed never travels.
  it("an UNATTRIBUTED structural finding never enters the bundle — no structural entry, and ideally no payment-webhook-flow slug at all", () => {
    for (const entry of unattributedBundle.detected_skills) {
      expect("evidence" in entry).toBe(false);
      expect("confidence" in entry).toBe(false);
    }
    expect(unattributedBundle.detected_skills.map((s) => s.slug)).not.toContain("payments/payment-webhook-flow");
    expect(unattributedBundleJson).not.toContain("payments/payment-webhook-flow");
  });

  // (d) Backward-compat mechanics — schema-level, read directly off
  // schema/bundle.v1.json (no validator dependency; the repo has none and
  // this adds none — CLAUDE.md's "ZERO new dependencies without written
  // justification").
  describe("schema/bundle.v1.json mechanics (docs/schema-change-h7.md's 'Backward compatibility')", () => {
    const schemaUrl = new URL("../../schema/bundle.v1.json", import.meta.url);
    const schema = JSON.parse(readFileSync(schemaUrl, "utf8"));
    const item = schema.properties.detected_skills.items;

    it("schema_version is the const 1.2.0", () => {
      expect(schema.properties.schema_version.const).toBe("1.2.0");
    });

    it("evidence/confidence are NOT in detected_skills[] items' required[] (additive, optional)", () => {
      expect(item.required).toEqual(["slug", "commit_count", "first_seen", "last_seen"]);
      expect(item.required).not.toContain("evidence");
      expect(item.required).not.toContain("confidence");
    });

    it("detected_skills[] items still have additionalProperties: false", () => {
      expect(item.additionalProperties).toBe(false);
    });

    it("evidence/confidence are closed enums with exactly the contract's values", () => {
      expect(item.properties.evidence.enum).toEqual(["import", "structural"]);
      expect(item.properties.confidence.enum).toEqual(["direct", "inferred"]);
    });

    // The additive-compat property in practice: a 1.2.0 bundle with no
    // structural findings emits entries shaped exactly like a 1.1.0 bundle's
    // entries would have been (no evidence/confidence keys anywhere), while
    // still declaring schema_version 1.2.0.
    it("a scan of a repo with no structural pattern emits entries with no new fields, under schema_version 1.2.0", () => {
      expect(noStructuralBundle.schema_version).toBe("1.2.0");
      for (const entry of noStructuralBundle.detected_skills) {
        expect("evidence" in entry).toBe(false);
        expect("confidence" in entry).toBe(false);
      }
    });
  });

  // (e) Exact-JSON parity (principle 4: scan's printed JSON equals the
  // submitted payload byte-for-byte). Already covered generically — not
  // fixture-specific — by test/scan-command.test.ts ("consent summary block"
  // TTY tests asserting `logs[1]`/`logs[2]` parse as the exact bundle JSON)
  // and test/submit.test.ts ("executeSubmitCommand — consent summary": the
  // uploaded request body equals the logged JSON byte-for-byte). Those
  // assertions operate on whatever bundle runScan produces, so they already
  // cover a structural entry's evidence/confidence fields the moment one is
  // present in the bundle being printed/submitted — no fixture-specific
  // duplicate added here.
});
