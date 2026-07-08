/** Domain error for scan failures (empty repo, unconfirmed authorization, a
 * secret found in the payload, closed input stream, ...). Kept in its own
 * module so leaf modules (secret-scan.ts, prompt.ts) can throw it without
 * creating an import cycle with scan.ts. */
export class ScanError extends Error {}
