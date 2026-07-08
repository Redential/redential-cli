import { ScanError } from "./errors.js";

interface SecretPattern {
  name: string;
  pattern: RegExp;
}

/**
 * Deliberately narrow, low-noise patterns — this scans the FINAL serialized
 * bundle (see docs/principles.md, "Bounded output"), not raw diff content.
 * Every current bundle field is an enum, a hash, or a number, so none of
 * these should ever fire on correctly-built output; this exists as a
 * regression guard against a future bug or a careless new field, not as a
 * general-purpose secret detector.
 */
const SECRET_PATTERNS: SecretPattern[] = [
  { name: "AWS access key ID", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  {
    name: "PEM private key",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/,
  },
  {
    name: "API key/secret/token/password assignment",
    pattern: /\b(?:api[_-]?key|secret|token|password)\b\s*[:=]\s*["']?[A-Za-z0-9_\-]{16,}/i,
  },
  { name: ".env-style KEY=VALUE assignment", pattern: /^[A-Z][A-Z0-9_]{2,}=\S+/m },
];

/** Names of the patterns that matched `payload` — never the matched text itself. */
export function findSecretPatterns(payload: string): string[] {
  return SECRET_PATTERNS.filter(({ pattern }) => pattern.test(payload)).map(({ name }) => name);
}

/**
 * Throws rather than returning a boolean so callers can't accidentally
 * ignore the result. Never includes the matched substring in the error —
 * only the pattern name — so the error itself can't leak the secret.
 */
export function assertNoSecrets(payload: string): void {
  const matches = findSecretPatterns(payload);
  if (matches.length > 0) {
    throw new ScanError(
      `Refusing to output: the bundle appears to contain a secret (${matches.join(", ")}). ` +
        "This should never happen with normal usage — please report it."
    );
  }
}
