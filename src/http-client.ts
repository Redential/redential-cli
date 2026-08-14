import { EnvHttpProxyAgent } from "undici";
import { NetworkError } from "./errors.js";

/**
 * Node's built-in fetch ignores HTTP_PROXY/HTTPS_PROXY (issue #83). Attach
 * a single module-level EnvHttpProxyAgent only when a proxy env var is set,
 * so an unset environment stays byte-identical to today's dispatcher-less
 * fetch. NO_PROXY/no_proxy are honored by the agent itself.
 */
function proxyEnvSet(): boolean {
  return Boolean(
    process.env.HTTP_PROXY ||
      process.env.HTTPS_PROXY ||
      process.env.http_proxy ||
      process.env.https_proxy
  );
}

let proxyAgent: InstanceType<typeof EnvHttpProxyAgent> | undefined;

function proxyDispatcher(): InstanceType<typeof EnvHttpProxyAgent> {
  return (proxyAgent ??= new EnvHttpProxyAgent());
}

function cliFetch(url: string, init: RequestInit): Promise<Response> {
  if (!proxyEnvSet()) {
    return fetch(url, init);
  }
  return fetch(url, { ...init, dispatcher: proxyDispatcher() } as RequestInit);
}

const TLS_CODES = new Set([
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_UNTRUSTED",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_REVOKED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_SSL_WRONG_VERSION_NUMBER",
]);

/** Walk `code` / `cause` / AggregateError `errors` only — never `message`. */
function collectCodes(err: unknown, seen: Set<object> = new Set()): string[] {
  if (!err || typeof err !== "object" || seen.has(err)) return [];
  seen.add(err);
  const rec = err as { code?: unknown; cause?: unknown; errors?: unknown };
  const codes: string[] = [];
  if (typeof rec.code === "string") codes.push(rec.code);
  if (rec.cause) codes.push(...collectCodes(rec.cause, seen));
  if (Array.isArray(rec.errors)) {
    for (const inner of rec.errors) codes.push(...collectCodes(inner, seen));
  }
  return codes;
}

/**
 * Closed failure-class phrases from `error.code` (and 407). Host is the
 * only interpolated value — never `error.message`, headers, or body.
 */
function reachErrorMessage(host: string, err: unknown): string {
  const codes = collectCodes(err);
  if (codes.some((c) => TLS_CODES.has(c))) {
    return `Could not reach ${host}: could not verify TLS certificate (corporate proxy? see docs/corporate-networks.md).`;
  }
  if (codes.some((c) => c === "UND_ERR_PROXY")) {
    return `Could not reach ${host}: proxy required.`;
  }
  if (codes.some((c) => c === "ECONNREFUSED")) {
    return `Could not reach ${host}: connection refused.`;
  }
  return `Could not reach ${host}.`;
}

function statusErrorMessage(host: string, status: number): string {
  if (status === 407) {
    return `Could not reach ${host}: proxy required.`;
  }
  return `Request to ${host} failed with status ${status}.`;
}

/**
 * The only module allowed to call `fetch` for JSON requests (login.ts and
 * submit.ts are the other two — see test/privacy/zero-network.test.ts's
 * allowlist). Error messages are built from the URL's host, HTTP status,
 * and a closed failure-class phrase from `error.code` — never from
 * response headers, body, or `error.message`, so a failure can never
 * echo a bearer token or bundle content back into a printed error.
 */
export async function postJson<T>(
  url: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<T> {
  const host = new URL(url).host;
  let res: Response;
  try {
    res = await cliFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new NetworkError(reachErrorMessage(host, err));
  }
  if (!res.ok) {
    throw new NetworkError(statusErrorMessage(host, res.status));
  }
  try {
    return (await res.json()) as T;
  } catch {
    throw new NetworkError(`Response from ${host} was not valid JSON.`);
  }
}

/**
 * Same as postJson, but sends `rawBody` verbatim instead of re-serializing
 * an object — used by submit so the bytes on the wire are byte-identical to
 * the bytes printed for user review (principle 4, "User-reviewed").
 */
export async function postRawJson<T>(
  url: string,
  rawBody: string,
  headers: Record<string, string> = {}
): Promise<T> {
  const host = new URL(url).host;
  let res: Response;
  try {
    res = await cliFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: rawBody,
    });
  } catch (err) {
    throw new NetworkError(reachErrorMessage(host, err));
  }
  if (!res.ok) {
    throw new NetworkError(statusErrorMessage(host, res.status));
  }
  try {
    return (await res.json()) as T;
  } catch {
    throw new NetworkError(`Response from ${host} was not valid JSON.`);
  }
}

/**
 * Like postJson, but for the device-token poll endpoint only: RFC 8628
 * device flow returns EVERY `{error: "..."}` state — including the
 * non-terminal authorization_pending/slow_down the CLI is expected to keep
 * polling through — as HTTP 400, reserving 200 for `{access_token}` success
 * (see docs/login-submit.md). Treats 200 and 400 alike as "parse the body";
 * any other status is still a real failure. Same error-message discipline
 * as postJson: host, status, and a closed failure-class phrase — never
 * response headers, body, or `error.message`.
 */
export async function pollJson<T>(url: string, body: unknown): Promise<T> {
  const host = new URL(url).host;
  let res: Response;
  try {
    res = await cliFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new NetworkError(reachErrorMessage(host, err));
  }
  if (!res.ok && res.status !== 400) {
    throw new NetworkError(statusErrorMessage(host, res.status));
  }
  try {
    return (await res.json()) as T;
  } catch {
    throw new NetworkError(`Response from ${host} was not valid JSON.`);
  }
}

/**
 * POST with a JSON body, returning only the HTTP status — never throws on a
 * non-2xx response (unlike postJson/postRawJson above), and never attempts
 * to parse a response body. Built specifically for submit.ts's
 * `postPrivateLabel`: that endpoint's contract (docs/private-label.md) is a
 * bare 204 on success and a bare 401/404/422 on the documented failure
 * modes, with no JSON body in any case — `postJson`'s `res.json()` call on
 * a genuinely empty 204 body would throw, and its single generic
 * "failed with status N" error can't tell 401 apart from 422 for the
 * caller to print a specific message. Still throws NetworkError (host +
 * "could not reach", no status) on a real network failure — same as every
 * other function here.
 */
export async function postJsonStatusOnly(
  url: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<number> {
  const host = new URL(url).host;
  try {
    const res = await cliFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    return res.status;
  } catch (err) {
    throw new NetworkError(reachErrorMessage(host, err));
  }
}

/**
 * Anonymous HEAD request used only by submit's remote-visibility gate — the
 * request target is the repo's own remote host, never SITE_URL. Returns
 * null (not a thrown error) on any network failure/timeout: an inconclusive
 * check must never be treated as a confirmed answer either way.
 */
export async function headRequest(url: string, timeoutMs: number): Promise<{ status: number } | null> {
  try {
    const res = await cliFetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: res.status };
  } catch {
    return null;
  }
}

/**
 * Anonymous-or-authenticated GET with a timeout. Returns null (never
 * throws) on any failure — network error, timeout, non-2xx status, or a
 * body that isn't valid JSON — so a broken or offline endpoint can never
 * delay or fail the command it's attached to. Two best-effort callers:
 * version-check.ts's npm-registry freshness check (no headers), and
 * submit.ts's fetchVerifiedEmails (a bearer `Authorization` header, for
 * the identity-corroboration lookup) — both share this fail-open contract.
 */
export async function getJson<T>(
  url: string,
  timeoutMs: number,
  headers: Record<string, string> = {}
): Promise<T | null> {
  try {
    const res = await cliFetch(url, { method: "GET", headers, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}
