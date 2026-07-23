import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "backdated-segment");

function loadJson<T>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8")) as T;
}

/**
 * Locks the negative fixture contract for RFC #13 vault backdating.
 * Does NOT implement chain_verify — only documents expected rejection
 * before vault code ships (same discipline as signature negative fixtures).
 */
describe("fixture:backdated-segment (vault negative)", () => {
  const honest = loadJson<{
    anchors: Array<{ received_at_server: string; max_finished_at_claimed: string }>;
    epsilon_days: number;
  }>("honest-server-anchors.json");

  const forged = loadJson<{
    submit: { max_finished_at_claimed: string; received_at_server: string; receipt_count_since_prev: number };
  }>("forged-submit-segment.json");

  const expectations = loadJson<{
    verdict: string;
    primary_reason: string;
    checks: Array<{ id: string; passes: boolean }>;
    must_not_expose_to_hiring_ui: string[];
  }>("expectations.json");

  it("declares reject verdict with segment_backdate_suspect", () => {
    expect(expectations.verdict).toBe("reject");
    expect(expectations.primary_reason).toBe("segment_backdate_suspect");
  });

  it("forged max_finished_at predates prior honest anchor received_at_server", () => {
    const prior = honest.anchors.at(-1)!;
    const forgedMax = new Date(forged.submit.max_finished_at_claimed);
    const priorReceived = new Date(prior.received_at_server);
    expect(forgedMax.getTime()).toBeLessThan(priorReceived.getTime());
  });

  it("epsilon_window check is expected to fail", () => {
    const check = expectations.checks.find((c) => c.id === "epsilon_window");
    expect(check?.passes).toBe(false);
  });

  it("gap_non_exposure check passes — rejection without gap surveillance", () => {
    const check = expectations.checks.find((c) => c.id === "gap_non_exposure");
    expect(check?.passes).toBe(true);
  });

  it("hiring UI must not receive gap-derived fields", () => {
    expect(expectations.must_not_expose_to_hiring_ui).toContain("days_between_anchors");
    expect(expectations.must_not_expose_to_hiring_ui).toContain("session_spacing_histogram");
  });

  it("forged segment is non-trivial (resume-padding scale)", () => {
    expect(forged.submit.receipt_count_since_prev).toBeGreaterThanOrEqual(10);
  });
});
