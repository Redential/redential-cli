import { ScanError } from "./errors.js";
import { assertNoSecrets } from "./secret-scan.js";

/** See docs/private-label.md — chosen to be generous enough for a short
 * human nickname ("Acme Corp — backend", "employer #3") while staying well
 * short of anything that could plausibly encode more than a label. */
export const PRIVATE_LABEL_MAX_LENGTH = 64;

// eslint-disable-next-line no-control-regex
export const CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f]/;

/**
 * Shared validation for the private label — used identically whether it
 * arrives via `--label` or the interactive prompt (see prompt.ts's
 * `promptPrivateLabel` and submit-command.ts), so the two entry points can
 * never diverge on what counts as a valid label. Trims first, so an
 * all-whitespace answer counts as empty. Throws `ScanError` (never returns
 * a boolean) so a caller can't accidentally treat an invalid label as
 * valid — same discipline as `assertNoSecrets` below, which this function
 * also runs: a secret typed into the label blocks the WHOLE submit, not
 * just the label field, exactly like a secret found in the bundle payload.
 */
export function validatePrivateLabel(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new ScanError("Private label cannot be empty.");
  }
  if (trimmed.length > PRIVATE_LABEL_MAX_LENGTH) {
    throw new ScanError(`Private label must be ${PRIVATE_LABEL_MAX_LENGTH} characters or fewer.`);
  }
  if (CONTROL_CHAR_PATTERN.test(trimmed)) {
    throw new ScanError("Private label must not contain control characters.");
  }
  // Reuses the exact same patterns the final bundle is scanned against —
  // this is deliberately the same bar, not a lighter one, since the label
  // travels to the same server the bundle does (see docs/private-label.md).
  assertNoSecrets(trimmed);
  return trimmed;
}
