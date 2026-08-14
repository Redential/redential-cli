import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG_DIR } from "./config.js";

export interface Credentials {
  access_token: string;
  /** The SITE_URL the token was issued by — lets submit refuse a stale
   * token if REDENTIAL_SITE_URL later points somewhere else, instead of
   * silently sending a bearer token to a different host. */
  site_url: string;
  obtained_at: string;
  /** Optional display identity (handle or masked email) the server
   * returned at login time — lets `status` show whom the stored session
   * belongs to (issue #63). Absent for sessions stored by older CLI
   * versions or when the server doesn't send one; already validated
   * (trimmed, non-empty, <= 64 chars, no control characters) by
   * `login.ts`'s `sanitizeAccountLabel` before it ever reaches this file —
   * never re-validated here, since this module only persists/reads what
   * was already checked at the point it entered the process. */
  account_label?: string;
}

function credentialsPath(configDir: string = DEFAULT_CONFIG_DIR): string {
  return join(configDir, "credentials.json");
}

/** Never in the scanned repo's cwd — always the device-local config dir. */
export function readCredentials(configDir: string = DEFAULT_CONFIG_DIR): Credentials | null {
  const path = credentialsPath(configDir);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as Credentials;
}

/**
 * 0600 — same permission pattern as salt.ts's device salt. `mode` is a
 * no-op on Windows: NTFS has no POSIX permission bits, so this restricts
 * nothing there. What actually protects the token on Windows is NTFS ACL
 * inheritance — a file created under the user's own profile directory
 * (`%USERPROFILE%\AppData\Roaming\redential`, see config.ts) inherits that
 * directory's ACL, which by default grants access only to the owning
 * account plus Administrators/SYSTEM, not to other local users. See
 * docs/login-submit.md for the full per-platform explanation.
 */
export function saveCredentials(credentials: Credentials, configDir: string = DEFAULT_CONFIG_DIR): void {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(credentialsPath(configDir), JSON.stringify(credentials), { mode: 0o600 });
}

/** True if a credentials file existed and was removed; false if there was nothing to do. */
export function deleteCredentials(configDir: string = DEFAULT_CONFIG_DIR): boolean {
  const path = credentialsPath(configDir);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}
