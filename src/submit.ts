import { NetworkError } from "./errors.js";
import { isKnownPublicHost, publicHostWarning } from "./public-remote.js";
import { getJson, headRequest, postJsonStatusOnly, postRawJson } from "./http-client.js";
import { IDENTITY_CORROBORATION_HEADER, type IdentityCorroboration } from "./identity-corroboration.js";

const HEAD_TIMEOUT_MS = 5000;
const EMAILS_TIMEOUT_MS = 5000;

/**
 * Transport for submit's npm release-date check. The caller constructs the
 * fixed registry URL; this wrapper adds only npm's documented JSON accept
 * header and delegates timeout cancellation to getJson.
 */
export async function fetchNpmPackument(url: string, timeoutMs: number): Promise<unknown | null> {
  return getJson<unknown>(url, timeoutMs, { accept: "application/json" });
}

/**
 * Converts a git remote URL (https, scp-like `git@host:org/repo.git`, or
 * `ssh://`) into an https URL worth HEAD-requesting. Only ever called after
 * isKnownPublicHost has already confirmed the URL carries no embedded
 * credentials or token, so nothing sensitive can end up in the probe.
 */
function toProbeUrl(remoteUrl: string): string | null {
  const scpMatch = !remoteUrl.includes("://") && remoteUrl.match(/^(?:[^@\s]+@)?([^:/\s]+):(.+)$/);
  if (scpMatch) {
    const [, host, path] = scpMatch;
    return `https://${host}/${path.replace(/\.git$/, "")}`;
  }
  try {
    const u = new URL(remoteUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:" && u.protocol !== "ssh:") return null;
    return `https://${u.host}${u.pathname.replace(/\.git$/, "")}`;
  } catch {
    return null;
  }
}

export interface VisibilityCheck {
  /** true = submit must refuse; a confirmed-public remote or an
   * inconclusive one are both `false` (fail-open — see docs/login-submit.md). */
  blocked: boolean;
  message: string | null;
}

/**
 * Only probes known-public-host remotes (github.com/gitlab.com/bitbucket.org
 * shaped, per public-remote.ts) — never an arbitrary self-hosted URL. A
 * confirmed 2xx/3xx blocks submit; anything else (private, unreachable,
 * unparseable) proceeds, matching scan's "known host != publicly
 * accessible" stance and the advisor-required fail-open behavior for
 * network blips.
 */
export async function checkVisibilityGate(
  remoteUrl: string | null,
  probeFn: (url: string, timeoutMs: number) => Promise<{ status: number } | null> = headRequest
): Promise<VisibilityCheck> {
  if (!isKnownPublicHost(remoteUrl)) return { blocked: false, message: null };

  const probeUrl = toProbeUrl(remoteUrl!);
  if (!probeUrl) return { blocked: false, message: publicHostWarning(remoteUrl) };

  const result = await probeFn(probeUrl, HEAD_TIMEOUT_MS);
  if (result === null) {
    // Inconclusive (network error, timeout, host down) — never louder than
    // scan's own warning, never treated as a confirmed answer either way.
    return { blocked: false, message: publicHostWarning(remoteUrl) };
  }
  if (result.status >= 200 && result.status < 400) {
    return {
      blocked: true,
      message:
        "Refusing to submit: this repository's remote answered as publicly reachable " +
        `(HTTP ${result.status}). Connect the GitHub App instead — it reads the real code ` +
        "and grants a stronger tier than a local metadata scan. If this repo is actually " +
        "private, this check was wrong; please report it.",
    };
  }
  return { blocked: false, message: null };
}

interface SubmitResponse {
  id: string;
}

interface VerifiedEmailsResponse {
  emails: string[];
}

/**
 * Best-effort lookup of the signed-in account's verified emails, used to
 * compute the identity-corroboration header below. Fail-open per the server
 * contract (docs: `GET /api/cli/identity/emails`) — a down/slow/malformed
 * endpoint must never block a submit, so this returns null (not a throw) on
 * anything but a clean `{ emails: string[] }` 200. The returned emails are
 * memory-only: callers must never log or persist them (they never appear in
 * the bundle, the printed output, or on disk — only their salted hashes,
 * compared in identity-corroboration.ts, ever leave this function's caller).
 */
export async function fetchVerifiedEmails(siteUrl: string, accessToken: string): Promise<string[] | null> {
  const result = await getJson<VerifiedEmailsResponse>(`${siteUrl}/api/cli/identity/emails`, EMAILS_TIMEOUT_MS, {
    authorization: `Bearer ${accessToken}`,
  });
  if (!result || !Array.isArray(result.emails) || !result.emails.every((e) => typeof e === "string")) {
    return null;
  }
  return result.emails;
}

/**
 * `bundleJson` must be the exact string already shown to the user (see
 * submit-command.ts) — sent verbatim via postRawJson, never re-derived from
 * the parsed object, so what was reviewed is byte-for-byte what is sent.
 * `corroboration`, when present, is sent as a compact-JSON header — never
 * folded into `bundleJson` itself, since it isn't part of the bundle schema
 * or the server's dedup hash (see identity-corroboration.ts).
 */
export async function postBundle(
  siteUrl: string,
  accessToken: string,
  bundleJson: string,
  corroboration?: IdentityCorroboration | null
): Promise<SubmitResponse> {
  const headers: Record<string, string> = { authorization: `Bearer ${accessToken}` };
  if (corroboration) {
    headers[IDENTITY_CORROBORATION_HEADER] = JSON.stringify(corroboration);
  }
  const response = await postRawJson<SubmitResponse>(`${siteUrl}/api/cli/bundles`, bundleJson, headers);
  if (typeof response.id !== "string") {
    throw new NetworkError("Unexpected response from the submit server.");
  }
  return response;
}

export interface PrivateLabelResult {
  ok: boolean;
  /** Present only when `ok` is false — a clear, per-status human message,
   * never the raw HTTP status alone (see the per-status branches below). */
  message?: string;
}

/**
 * `POST {SITE_URL}/api/cli/private-label` — the SECOND request of a
 * `submit`, made only after the bundle POST above has already succeeded
 * (see submit-command.ts and docs/private-label.md). Deliberately never
 * throws: this function always resolves to a result object, because a
 * failure here must NEVER be treated as a submit failure, must never be
 * retried, and must never trigger a second bundle upload — the bundle is
 * already safely uploaded by the time this runs. The bundle itself carries
 * none of this: `privateLabel` travels only in this request's body,
 * alongside the bundle id, never inside the bundle JSON.
 */
export async function postPrivateLabel(
  siteUrl: string,
  accessToken: string,
  bundleId: string,
  privateLabel: string
): Promise<PrivateLabelResult> {
  let status: number;
  try {
    status = await postJsonStatusOnly(
      `${siteUrl}/api/cli/private-label`,
      { bundle_id: bundleId, private_label: privateLabel },
      { authorization: `Bearer ${accessToken}` }
    );
  } catch {
    return { ok: false, message: "could not reach the server." };
  }
  if (status === 204) return { ok: true };
  if (status === 401) return { ok: false, message: "your session is no longer valid." };
  if (status === 404) return { ok: false, message: "the uploaded bundle could not be found." };
  if (status === 422) return { ok: false, message: "the server rejected the label as invalid." };
  return { ok: false, message: `unexpected response (HTTP ${status}).` };
}
