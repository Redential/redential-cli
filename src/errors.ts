/** Domain error for scan failures (empty repo, unconfirmed authorization, a
 * secret found in the payload, closed input stream, ...). Kept in its own
 * module so leaf modules (secret-scan.ts, prompt.ts) can throw it without
 * creating an import cycle with scan.ts. */
export class ScanError extends Error {}

/** Session/authentication failures: device flow denied/expired, no stored
 * credentials, or a stored token that belongs to a different SITE_URL. */
export class AuthError extends Error {}

/** submit-specific failures that aren't auth or network: refused because
 * the remote looks publicly reachable, malformed server response, etc. */
export class SubmitError extends Error {}

/** A request to SITE_URL (or a remote host, for the visibility check)
 * couldn't complete or came back with a non-2xx status. Message is built
 * from the request's host, HTTP status, and a closed failure-class phrase
 * from `error.code` — never headers, body, or `error.message` — so it
 * can never echo a bearer token or bundle content. */
export class NetworkError extends Error {}
