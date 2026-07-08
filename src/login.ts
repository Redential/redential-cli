import { spawn } from "node:child_process";
import { AuthError } from "./errors.js";
import { getSiteUrl } from "./config.js";
import { saveCredentials } from "./credentials.js";
import { postJson, pollJson } from "./http-client.js";

interface DeviceAuthorization {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

interface DeviceTokenResponse {
  access_token?: string;
  error?: "authorization_pending" | "slow_down" | "expired_token" | "access_denied";
}

function requestDeviceAuthorization(siteUrl: string): Promise<DeviceAuthorization> {
  return postJson<DeviceAuthorization>(`${siteUrl}/api/cli/device/authorize`, {});
}

function pollDeviceToken(siteUrl: string, deviceCode: string): Promise<DeviceTokenResponse> {
  // Not postJson: this endpoint returns HTTP 400 for authorization_pending/
  // slow_down too (RFC 8628 shape), which postJson would treat as a fatal
  // NetworkError before ever reading the body.
  return pollJson<DeviceTokenResponse>(`${siteUrl}/api/cli/device/token`, { device_code: deviceCode });
}

export interface LoginOptions {
  configDir?: string;
  log?: (message: string) => void;
  // Injectable so tests don't have to wait out real polling intervals.
  sleepFn?: (ms: number) => Promise<void>;
  // Injectable so tests don't spawn a real browser process.
  openFn?: (url: string) => void;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Best-effort auto-open of verification_uri in the default browser — never
 * fatal, never blocks login: the printed URL/code are the fallback for any
 * failure here (headless box, SSH session, unknown platform, no browser).
 * `verification_uri` comes from the server's JSON response, so it's treated
 * as untrusted input: only http/https is ever handed to a native opener
 * (never file://, an app-custom scheme, etc.), and the re-serialized
 * `URL#href` is passed — never the raw string — so it can't carry stray
 * whitespace/quotes into the child process's argv.
 *
 * Uses `spawn`, never `exec`/a shell string: the URL is always its own argv
 * element, so a URL crafted with shell metacharacters can't inject a second
 * command. Windows is the one platform where even that isn't enough — `cmd
 * /c start` re-parses the command line, and a legal URL character like `&`
 * would split it into a second command — so win32 shells out to
 * `rundll32 url.dll,FileProtocolHandler` instead, which never touches a
 * shell at all. `detached` + `unref` + `stdio: "ignore"` keep the opener
 * from holding the CLI's event loop open or inheriting its file
 * descriptors; the `error` listener is required because `spawn` emits
 * `error` asynchronously on ENOENT (missing `open`/`xdg-open`/`rundll32`) —
 * without a listener that's an unhandled `error` event that crashes the
 * whole process.
 */
function openBrowser(url: string): void {
  let target: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return;
    target = parsed.href;
  } catch {
    return;
  }

  let command: string;
  let args: string[];
  if (process.platform === "darwin") {
    command = "open";
    args = [target];
  } else if (process.platform === "win32") {
    command = "rundll32";
    args = ["url.dll,FileProtocolHandler", target];
  } else {
    command = "xdg-open";
    args = [target];
  }

  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    // Synchronous spawn failures (e.g. EACCES) are equally non-fatal.
  }
}

/**
 * RFC 8628-shaped device authorization grant. Nothing on the server side of
 * this exists yet (redence has no /api/cli/* routes at the time of writing —
 * this repo defines the contract; redence implements to match, see
 * docs/login-submit.md). Never sends anything except the device code itself.
 */
export async function runLogin(opts: LoginOptions = {}): Promise<void> {
  const log = opts.log ?? console.log;
  const sleep = opts.sleepFn ?? defaultSleep;
  const open = opts.openFn ?? openBrowser;
  const siteUrl = getSiteUrl();

  const auth = await requestDeviceAuthorization(siteUrl);
  log(`First, go to: ${auth.verification_uri}`);
  log(`Then enter this code: ${auth.user_code}`);
  // Printed above first, so the URL/code are on screen even if the browser
  // steals focus or auto-open silently does nothing. Guarded here too, not
  // just inside the default openBrowser: an injected openFn (test or
  // future caller) must never be able to fail login either — including one
  // that returns a rejecting promise, which a synchronous try/catch alone
  // wouldn't catch (openFn's type is synchronous, but nothing stops a
  // caller from assigning an async function to it).
  try {
    void Promise.resolve(open(auth.verification_uri)).catch(() => {});
  } catch {
    // Auto-open is a convenience, never load-bearing.
  }
  log("Waiting for confirmation...");

  let intervalMs = Math.max(auth.interval, 1) * 1000;
  const deadline = Date.now() + auth.expires_in * 1000;

  for (;;) {
    if (Date.now() > deadline) {
      throw new AuthError("Login timed out before the code was confirmed. Run `redential login` again.");
    }
    await sleep(intervalMs);

    const result = await pollDeviceToken(siteUrl, auth.device_code);
    if (result.access_token) {
      saveCredentials(
        { access_token: result.access_token, site_url: siteUrl, obtained_at: new Date().toISOString() },
        opts.configDir
      );
      log("Logged in.");
      return;
    }
    switch (result.error) {
      case "authorization_pending":
        continue;
      case "slow_down":
        intervalMs += 5000;
        continue;
      case "access_denied":
        throw new AuthError("Login was denied.");
      case "expired_token":
        throw new AuthError("The login code expired before it was confirmed. Run `redential login` again.");
      default:
        throw new AuthError("Unexpected response from the login server.");
    }
  }
}
