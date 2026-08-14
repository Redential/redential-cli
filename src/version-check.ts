import { readFileSync } from "node:fs";
import { getJson } from "./http-client.js";
import { writeStderrLine } from "./stderr.js";

/**
 * Best-effort, non-blocking "a newer version exists" notice, checked against
 * the public npm registry. ONLY ever wired into `login.ts` and
 * `submit-command.ts` — both already make network calls, so this adds no new
 * network surface to the command. It must NEVER be called from
 * `scan-command.ts`: `scan` makes zero network calls, full stop (CLAUDE.md's
 * inviolable rule, and see docs/login-submit.md's "Version check" section
 * for the boundary this file exists inside). Nothing about the scanned repo
 * is ever sent — the only outbound data is a GET to a fixed, public URL.
 */

const PACKAGE_NAME = "@redential/cli";
const NPM_REGISTRY_URL = `https://registry.npmjs.org/${encodeURIComponent(PACKAGE_NAME)}/latest`;
const DEFAULT_TIMEOUT_MS = 1500;

interface NpmRegistryLatest {
  version?: string;
}

function getInstalledVersion(): string {
  const pkgUrl = new URL("../package.json", import.meta.url);
  const pkg = JSON.parse(readFileSync(pkgUrl, "utf8")) as { version: string };
  return pkg.version;
}

/** Parses a `major.minor.patch`-leading version string; null if it doesn't
 * parse cleanly — a malformed registry response must skip the notice, never
 * crash the command it's attached to. */
function parseVersion(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function isNewer(current: string, latest: string): boolean {
  const c = parseVersion(current);
  const l = parseVersion(latest);
  if (!c || !l) return false;
  for (let i = 0; i < 3; i++) {
    if (l[i] > c[i]) return true;
    if (l[i] < c[i]) return false;
  }
  return false;
}

export interface CheckForUpdateOptions {
  log?: (message: string) => void;
  /** Overrides the version read from this package's own package.json;
   * exists for tests. */
  currentVersion?: string;
  /** Overrides the registry URL; exists so tests can point at a local mock
   * server instead of the real npm registry. */
  registryUrl?: string;
  timeoutMs?: number;
  /** Overrides the GET itself; exists for tests that don't want to exercise
   * a real HTTP round trip at all. Defaults to `getJson` (src/http-client.ts). */
  fetchFn?: (url: string, timeoutMs: number) => Promise<NpmRegistryLatest | null>;
}

export async function checkForUpdate(opts: CheckForUpdateOptions = {}): Promise<void> {
  // Bug fix (owner follow-up, 2026-08): `console.error` auto-colors red on
  // a TTY (Node built-in) — this is a calm "an update exists" notice, not
  // an error; see src/stderr.ts.
  const log = opts.log ?? writeStderrLine;
  const currentVersion = opts.currentVersion ?? getInstalledVersion();
  const registryUrl = opts.registryUrl ?? NPM_REGISTRY_URL;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchFn = opts.fetchFn ?? getJson<NpmRegistryLatest>;

  let latest: NpmRegistryLatest | null;
  try {
    latest = await fetchFn(registryUrl, timeoutMs);
  } catch {
    // fetchFn is injectable (tests, future callers) and isn't guaranteed to
    // share getJson's own never-throws contract — this check must stay
    // best-effort regardless of what's plugged in.
    return;
  }
  if (!latest?.version || !isNewer(currentVersion, latest.version)) return;

  log(
    `A newer version of ${PACKAGE_NAME} is available: ${latest.version} (you have ${currentVersion}). Run \`npm install -g ${PACKAGE_NAME}\` to update.`
  );
}
