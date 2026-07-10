import { saltedHash } from "./hash.js";

/**
 * Pure module — zero network references, checked statically by
 * test/privacy/zero-network.test.ts's allowlist regex. Computes and phrases
 * the identity-corroboration counts submit.ts sends as an optional header on
 * `POST /api/cli/bundles`; the actual fetch of verified emails lives in
 * submit.ts (one of the three files allowed to touch the network).
 */

export interface IdentityCorroboration {
  corroborated_count: number;
  total_claimed: number;
}

export const IDENTITY_CORROBORATION_HEADER = "X-Redential-Identity-Corroboration";

/**
 * `authorIdentityHashes` are the bundle's already-salted `identity.
 * author_identity_hashes` (verbatim as they appear in git history: not
 * trimmed/lowercased). `verifiedEmails` are the account's verified emails as
 * returned by `GET /api/cli/identity/emails` — already trim+lowercased and
 * deduped server-side. Because the bundle hashes author emails verbatim
 * while the server normalizes its list, an author email differing only in
 * case (or surrounding whitespace) simply won't corroborate — that's fine:
 * absence of corroboration is neutral by design (see the server contract),
 * never treated as a negative signal.
 */
export function computeCorroboration(
  authorIdentityHashes: string[],
  verifiedEmails: string[],
  salt: string
): IdentityCorroboration | null {
  const total_claimed = authorIdentityHashes.length;
  // Server-side bound (X-Redential-Identity-Corroboration's total_claimed
  // must be <= 1000): omitting the header entirely beats sending one the
  // server would reject with a 400.
  if (total_claimed > 1000) return null;

  const verifiedHashes = new Set(verifiedEmails.map((email) => saltedHash(salt, email)));
  const corroborated_count = authorIdentityHashes.filter((hash) => verifiedHashes.has(hash)).length;

  return { corroborated_count, total_claimed };
}

/**
 * Calm, informational, never accusatory — printed BEFORE the upload
 * confirmation prompt (principle 4: this header is data leaving the machine
 * that isn't in the printed bundle, so the dev must see it before
 * consenting). Deliberately says "your account's verified emails" (the
 * account email + the verified GitHub primary), not "all your verified
 * GitHub emails" — the server-side list is intentionally short, and its own
 * docs forbid overclaiming what it represents.
 */
export function corroborationNotice(c: IdentityCorroboration): string {
  if (c.corroborated_count === c.total_claimed) {
    return `${c.corroborated_count} of ${c.total_claimed} claimed identities match your account's verified emails.`;
  }
  return (
    `${c.corroborated_count} of ${c.total_claimed} claimed identities match your account's verified emails — ` +
    "unmatched ones simply won't earn the corroborated marker."
  );
}
