import { ScanError } from "./errors.js";

const RELATIVE_PATTERN = /^(\d+)\s*(day|days|month|months|year|years)$/i;
const MS_PER_DAY = 86_400_000;
const DAYS_PER_MONTH = 30;
const DAYS_PER_YEAR = 365;

/**
 * Parses `--since <spec>` into a concrete `Date`: either a relative window
 * ("2years", "18 months", "30days" — singular/plural, optional space) or an
 * absolute, `Date`-parseable value (ISO "2024-01-01" is the documented
 * form, but anything `Date` itself accepts works). `now` is injected so
 * relative windows stay deterministic in tests.
 */
export function parseSince(spec: string, now: Date): Date {
  const trimmed = spec.trim();

  const relative = RELATIVE_PATTERN.exec(trimmed);
  if (relative) {
    const amount = parseInt(relative[1], 10);
    const unit = relative[2].toLowerCase();
    const days = unit.startsWith("year")
      ? amount * DAYS_PER_YEAR
      : unit.startsWith("month")
        ? amount * DAYS_PER_MONTH
        : amount;
    return new Date(now.getTime() - days * MS_PER_DAY);
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new ScanError(
      `Invalid --since value "${spec}". Use a relative window ("2years", "18months", "30days") or an absolute date ("2024-01-01").`
    );
  }
  return parsed;
}

/**
 * Human label for the summary's "last 2 years" line (scan-command.ts) —
 * purely a rendering of the `--since` spec itself, not
 * a re-derivation from the parsed Date, so it reads back exactly what the
 * user typed for a relative window ("2years" -> "last 2 years").
 */
export function describeSince(spec: string): string {
  const trimmed = spec.trim();
  const relative = RELATIVE_PATTERN.exec(trimmed);
  if (relative) {
    const amount = parseInt(relative[1], 10);
    const unit = relative[2].toLowerCase().replace(/s$/, "");
    return `last ${amount} ${unit}${amount === 1 ? "" : "s"}`;
  }
  return `since ${trimmed}`;
}
