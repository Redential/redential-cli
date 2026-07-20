import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fixtureMatches, type Signature } from "../src/skill-detect.js";

describe("Tier 2 comment guard (#28)", () => {
  const supabase = JSON.parse(
    readFileSync(new URL("../signatures/db/supabase.json", import.meta.url), "utf8")
  ) as Signature;
  const whisper = JSON.parse(
    readFileSync(new URL("../signatures/ai/whisper.json", import.meta.url), "utf8")
  ) as Signature;

  it("does not match db/supabase when only a line comment mentions supabase.from()", () => {
    expect(
      fixtureMatches(supabase, {
        path: "src/db/notes.ts",
        diff: '// rejected: supabase.from("legacy_profiles") — we query Postgres directly instead\n',
      })
    ).toBe(false);
  });

  it("does not match ai/whisper when only a line comment mentions whisper-1", () => {
    expect(
      fixtureMatches(whisper, {
        path: "src/lib/transcription.ts",
        diff: '// evaluated model "whisper-1" but shipped with a vendor API instead\n',
      })
    ).toBe(false);
  });
});
