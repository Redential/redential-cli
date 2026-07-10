import { describe, expect, it } from "vitest";
import { ScanError } from "../src/errors.js";
import { describeSince, parseSince } from "../src/since.js";

const NOW = new Date("2026-06-15T12:00:00Z");

describe("parseSince", () => {
  it("parses a relative window in years (365-day years)", () => {
    const result = parseSince("2years", NOW);
    expect(result.toISOString()).toBe(new Date(NOW.getTime() - 2 * 365 * 86_400_000).toISOString());
  });

  it("parses a relative window in months", () => {
    const result = parseSince("18months", NOW);
    expect(result.toISOString()).toBe(new Date(NOW.getTime() - 18 * 30 * 86_400_000).toISOString());
  });

  it("parses a relative window in days, singular and plural, with or without a space", () => {
    expect(parseSince("30days", NOW).toISOString()).toBe(new Date(NOW.getTime() - 30 * 86_400_000).toISOString());
    expect(parseSince("1 day", NOW).toISOString()).toBe(new Date(NOW.getTime() - 86_400_000).toISOString());
  });

  it("is case-insensitive on the unit", () => {
    expect(parseSince("2Years", NOW).toISOString()).toBe(parseSince("2years", NOW).toISOString());
  });

  it("parses an absolute ISO date", () => {
    expect(parseSince("2024-01-01", NOW).toISOString()).toBe(new Date("2024-01-01").toISOString());
  });

  it("throws ScanError on garbage input", () => {
    expect(() => parseSince("not-a-date-or-window", NOW)).toThrow(ScanError);
  });

  it("throws ScanError on an empty string", () => {
    expect(() => parseSince("", NOW)).toThrow(ScanError);
  });
});

describe("describeSince", () => {
  it("labels a relative window as 'last N unit(s)'", () => {
    expect(describeSince("2years")).toBe("last 2 years");
    expect(describeSince("1 year")).toBe("last 1 year");
    expect(describeSince("18months")).toBe("last 18 months");
  });

  it("labels an absolute date as 'since <date>'", () => {
    expect(describeSince("2024-01-01")).toBe("since 2024-01-01");
  });
});
