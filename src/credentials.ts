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
  /** Display identity of the logged-in account (handle or masked email),
   * as returned by the device token endpoint at login time. Optional: a
   * session stored by an older CLI version, or a server that doesn't send
   * it, simply has no such field — `status` falls back to today's output
   * rather than erroring or migrating the file. */
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
