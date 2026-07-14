import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanup, commit, createRepo, setRemote } from "./support/fixtures.js";
import { startMockServer, type MockServer, type RecordedRequest } from "./support/mock-server.js";
import { saveCredentials } from "../src/credentials.js";
import { executeSubmitCommand, formatShortUploadSummary } from "../src/submit-command.js";
import { AuthError, SubmitError } from "../src/errors.js";
import { bundleContentHash, readLastSubmission } from "../src/submission-record.js";
import type { Bundle } from "../src/types.js";

// Minimal, hand-built Bundle for formatShortUploadSummary's own unit
// coverage — same pattern as summary.test.ts's baseBundle helper. Only the
// fields formatShortUploadSummary actually reads are meaningfully set.
function baseBundle(overrides: Partial<Bundle> = {}): Bundle {
  return {
    schema_version: "1.2.0",
    runner: "local",
    tool_version: "0.1.0",
    created_at: "2026-07-09T00:00:00.000Z",
    repo: { host_type: "github", age_days: 900, repo_fingerprint: "deadbeef" },
    identity: { author_identity_hashes: ["abc123"], other_contributors_count: 0 },
    commits: {
      user_total: 1378,
      first_at: "2024-01-01T00:00:00.000Z",
      last_at: "2026-07-01T00:00:00.000Z",
      span_days: 912,
      hour_histogram: new Array(24).fill(0),
      weekday_histogram: new Array(7).fill(0),
    },
    signed: { count: 0, ratio: 0 },
    languages: [],
    categories: [],
    detected_skills: [],
    ownership: { user_commit_ratio: 1 },
    integrity: {
      merkle_root: "0".repeat(64),
      algorithm: "sha256",
      date_forensics: { author_span_days: 900, committer_span_days: 895, mismatch_ratio: 0, committer_burst_ratio: 0 },
    },
    attestation: { authorized_confirmation: true, confirmed_at: "2026-07-09T00:00:00.000Z" },
    ...overrides,
  };
}

describe("formatShortUploadSummary", () => {
  it("shows span, thousands-formatted commit count, and detected-skill count, with no structural suffix when none are structural", () => {
    const bundle = baseBundle({
      detected_skills: [
        { slug: "ai/anthropic-api", commit_count: 14, first_seen: "2024-02-01", last_seen: "2026-06-01" },
      ],
    });
    const text = formatShortUploadSummary(bundle, false);
    expect(text).toContain("2 years of private work");
    expect(text).toContain("1,378 commits");
    expect(text).toContain("1 capabilities detected");
    expect(text).not.toContain("structural");
  });

  it("appends the structural count when at least one detected skill has evidence: \"structural\"", () => {
    const bundle = baseBundle({
      detected_skills: [
        { slug: "ai/anthropic-api", commit_count: 14, first_seen: "2024-02-01", last_seen: "2026-06-01" },
        {
          slug: "payments/stripe-webhook-flow",
          commit_count: 3,
          first_seen: "2024-02-01",
          last_seen: "2026-06-01",
          evidence: "structural",
          confidence: "direct",
        },
      ],
    });
    const text = formatShortUploadSummary(bundle, false);
    expect(text).toContain("2 capabilities detected (1 structural)");
  });

  it("uses an ASCII fallback separator in plain mode", () => {
    const bundle = baseBundle();
    const text = formatShortUploadSummary(bundle, true);
    // eslint-disable-next-line no-control-regex
    expect(text).toMatch(/^[\x20-\x7e\n]*$/);
    expect(text).not.toContain("·");
  });
});

/**
 * The identity-corroboration lookup (GET /api/cli/identity/emails) now
 * fires before the upload confirmation prompt on every submit attempt, so
 * `server.requests` alone is no longer "just the bundle upload" — tests
 * that care specifically about the bundle POST filter down to it.
 */
function bundleRequests(server: MockServer): RecordedRequest[] {
  return server.requests.filter((r) => r.url === "/api/cli/bundles");
}

const dirs: string[] = [];
const servers: MockServer[] = [];
const originalSiteUrl = process.env.REDENTIAL_SITE_URL;

afterEach(async () => {
  while (dirs.length > 0) cleanup(dirs.pop()!);
  while (servers.length > 0) await servers.pop()!.close();
  process.env.REDENTIAL_SITE_URL = originalSiteUrl;
});

function tempConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "redential-config-"));
  dirs.push(dir);
  return dir;
}

// Injected into every test that reaches a successful upload — without it,
// the default checkForUpdate would make a real request to the npm
// registry on every test run. version-check.test.ts covers checkForUpdate
// itself.
const noCheckForUpdate = async () => {};

function repoWithOneCommit(remote?: string): string {
  const dir = createRepo();
  dirs.push(dir);
  if (remote) setRemote(dir, remote);
  commit(dir, {
    message: "x",
    authorName: "You",
    authorEmail: "you@example.com",
    files: { "a.ts": "1\n" },
  });
  return dir;
}

describe("executeSubmitCommand", () => {
  it("refuses when there is no stored session, with a friendly message pointing at `redential login` — not a raw/dry error", async () => {
    const dir = repoWithOneCommit();
    const configDir = tempConfigDir();
    await expect(
      executeSubmitCommand({
        repoPath: dir,
        author: ["you@example.com"],
        yes: true,
        confirmUpload: true,
        toolVersion: "0.1.0",
        configDir,
        log: () => {},
        warn: () => {},
      })
    ).rejects.toThrow(new AuthError("Not logged in. Run `redential login` first."));
  });

  it("refuses when the stored session belongs to a different site", async () => {
    const dir = repoWithOneCommit();
    const configDir = tempConfigDir();
    saveCredentials({ access_token: "t", site_url: "https://old.example", obtained_at: "now" }, configDir);
    process.env.REDENTIAL_SITE_URL = "https://new.example";

    await expect(
      executeSubmitCommand({
        repoPath: dir,
        author: ["you@example.com"],
        yes: true,
        confirmUpload: true,
        toolVersion: "0.1.0",
        configDir,
        log: () => {},
        warn: () => {},
      })
    ).rejects.toBeInstanceOf(AuthError);
  });

  it("prints the bundle, uploads on confirmation, and sends it with a bearer token", async () => {
    const server = await startMockServer((req) => {
      if (req.url === "/api/cli/bundles") return { status: 200, body: { id: "bundle-123" } };
      return { status: 404, body: {} };
    });
    servers.push(server);
    process.env.REDENTIAL_SITE_URL = server.url;

    const dir = repoWithOneCommit();
    const configDir = tempConfigDir();
    saveCredentials({ access_token: "secret-tok", site_url: server.url, obtained_at: "now" }, configDir);

    const logs: string[] = [];
    await executeSubmitCommand({
      repoPath: dir,
      author: ["you@example.com"],
      yes: true,
      confirmUpload: true,
      toolVersion: "0.1.0",
      configDir,
      log: (m) => logs.push(m),
      warn: () => {},
      checkForUpdateFn: noCheckForUpdate,
    });

    const requests = bundleRequests(server);
    expect(requests).toHaveLength(1);
    const req = requests[0];
    expect(req.headers.authorization).toBe("Bearer secret-tok");

    const printedBundleLine = logs.find((l) => l.trim().startsWith("{"));
    expect(printedBundleLine).toBeDefined();
    expect(req.body).toBe(printedBundleLine);

    expect(logs.some((l) => l.includes("bundle-123"))).toBe(true);
  });

  it("records the uploaded bundle locally on success, so a later scan can tell it's already submitted", async () => {
    const server = await startMockServer((req) => {
      if (req.url === "/api/cli/bundles") return { status: 200, body: { id: "bundle-123" } };
      return { status: 404, body: {} };
    });
    servers.push(server);
    process.env.REDENTIAL_SITE_URL = server.url;

    const dir = repoWithOneCommit();
    const configDir = tempConfigDir();
    saveCredentials({ access_token: "secret-tok", site_url: server.url, obtained_at: "now" }, configDir);

    const logs: string[] = [];
    await executeSubmitCommand({
      repoPath: dir,
      author: ["you@example.com"],
      yes: true,
      confirmUpload: true,
      toolVersion: "0.1.0",
      configDir,
      log: (m) => logs.push(m),
      warn: () => {},
      checkForUpdateFn: noCheckForUpdate,
    });

    const printedBundleLine = logs.find((l) => l.trim().startsWith("{"))!;
    const record = readLastSubmission(configDir);
    expect(record).not.toBeNull();
    expect(record!.site_url).toBe(server.url);
    expect(record!.bundle_hash).toBe(bundleContentHash(JSON.parse(printedBundleLine)));
  });

  it("does NOT record a submission when the user declines the upload prompt", async () => {
    const server = await startMockServer(() => ({ status: 200, body: { id: "should-not-be-called" } }));
    servers.push(server);
    process.env.REDENTIAL_SITE_URL = server.url;

    const dir = repoWithOneCommit();
    const configDir = tempConfigDir();
    saveCredentials({ access_token: "secret-tok", site_url: server.url, obtained_at: "now" }, configDir);

    await executeSubmitCommand({
      repoPath: dir,
      author: ["you@example.com"],
      yes: true,
      confirmUpload: false,
      promptConfirmUploadFn: async () => false,
      toolVersion: "0.1.0",
      configDir,
      log: () => {},
      warn: () => {},
      checkForUpdateFn: noCheckForUpdate,
    });

    expect(readLastSubmission(configDir)).toBeNull();
  });

  it("aborts without uploading when the user declines the upload prompt", async () => {
    const server = await startMockServer(() => ({ status: 200, body: { id: "should-not-be-called" } }));
    servers.push(server);
    process.env.REDENTIAL_SITE_URL = server.url;

    const dir = repoWithOneCommit();
    const configDir = tempConfigDir();
    saveCredentials({ access_token: "t", site_url: server.url, obtained_at: "now" }, configDir);

    const logs: string[] = [];
    await executeSubmitCommand({
      repoPath: dir,
      author: ["you@example.com"],
      yes: true,
      confirmUpload: false,
      toolVersion: "0.1.0",
      configDir,
      log: (m) => logs.push(m),
      warn: () => {},
      promptConfirmUploadFn: async () => false,
    });

    // The identity-corroboration GET fires before the confirmation prompt
    // by design (see submit-command.ts) — only the bundle upload itself
    // must be absent here.
    expect(bundleRequests(server)).toHaveLength(0);
    expect(logs.some((l) => l.includes("Aborted"))).toBe(true);
  });

  it("refuses and never uploads when the visibility gate confirms a public remote", async () => {
    const server = await startMockServer(() => ({ status: 200, body: { id: "should-not-be-called" } }));
    servers.push(server);
    process.env.REDENTIAL_SITE_URL = server.url;

    const dir = repoWithOneCommit("https://github.com/acme/example.git");
    const configDir = tempConfigDir();
    saveCredentials({ access_token: "t", site_url: server.url, obtained_at: "now" }, configDir);

    const warnings: string[] = [];
    await expect(
      executeSubmitCommand({
        repoPath: dir,
        author: ["you@example.com"],
        yes: true,
        confirmUpload: true,
        toolVersion: "0.1.0",
        configDir,
        log: () => {},
        warn: (m) => warnings.push(m),
        probeFn: async () => ({ status: 200 }),
      })
    ).rejects.toBeInstanceOf(SubmitError);

    expect(bundleRequests(server)).toHaveLength(0);
    expect(warnings.some((w) => w.includes("GitHub App"))).toBe(true);
  });

  it("proceeds when the visibility gate finds the remote is not publicly reachable", async () => {
    const server = await startMockServer((req) => {
      if (req.url === "/api/cli/bundles") return { status: 200, body: { id: "ok" } };
      return { status: 404, body: {} };
    });
    servers.push(server);
    process.env.REDENTIAL_SITE_URL = server.url;

    const dir = repoWithOneCommit("https://github.com/acme/example.git");
    const configDir = tempConfigDir();
    saveCredentials({ access_token: "t", site_url: server.url, obtained_at: "now" }, configDir);

    await executeSubmitCommand({
      repoPath: dir,
      author: ["you@example.com"],
      yes: true,
      confirmUpload: true,
      toolVersion: "0.1.0",
      configDir,
      log: () => {},
      warn: () => {},
      probeFn: async () => ({ status: 404 }),
      checkForUpdateFn: noCheckForUpdate,
    });

    expect(bundleRequests(server)).toHaveLength(1);
  });

  it("calls checkForUpdateFn only after a successful upload, not on abort or refusal", async () => {
    const server = await startMockServer((req) => {
      if (req.url === "/api/cli/bundles") return { status: 200, body: { id: "bundle-456" } };
      return { status: 404, body: {} };
    });
    servers.push(server);
    process.env.REDENTIAL_SITE_URL = server.url;

    const dir = repoWithOneCommit();
    const configDir = tempConfigDir();
    saveCredentials({ access_token: "t", site_url: server.url, obtained_at: "now" }, configDir);

    let called = false;
    await executeSubmitCommand({
      repoPath: dir,
      author: ["you@example.com"],
      yes: true,
      confirmUpload: true,
      toolVersion: "0.1.0",
      configDir,
      log: () => {},
      warn: () => {},
      checkForUpdateFn: async () => {
        called = true;
      },
    });

    expect(called).toBe(true);
  });

  it("does not call checkForUpdateFn when the user declines the upload prompt", async () => {
    const server = await startMockServer(() => ({ status: 200, body: { id: "should-not-be-called" } }));
    servers.push(server);
    process.env.REDENTIAL_SITE_URL = server.url;

    const dir = repoWithOneCommit();
    const configDir = tempConfigDir();
    saveCredentials({ access_token: "t", site_url: server.url, obtained_at: "now" }, configDir);

    let called = false;
    await executeSubmitCommand({
      repoPath: dir,
      author: ["you@example.com"],
      yes: true,
      confirmUpload: false,
      toolVersion: "0.1.0",
      configDir,
      log: () => {},
      warn: () => {},
      promptConfirmUploadFn: async () => false,
      checkForUpdateFn: async () => {
        called = true;
      },
    });

    expect(called).toBe(false);
  });
});

describe("executeSubmitCommand — consent summary", () => {
  // Console-UX milestone (2026-07): TTY order is now short summary line,
  // identity-corroboration line (absent here — no verified-emails endpoint
  // configured on this mock server, so fetchVerifiedEmails fails open and
  // prints nothing), consent box, payload header, then the JSON — and the
  // upload prompt right after. See submit-command.ts's "Output order"
  // comment. The inviolable guarantee (JSON always printed before the
  // upload prompt, byte-for-byte what gets sent) still holds — only its
  // position within the TTY sequence moved from first to last.
  it("with isTTY: true, logs contain the short summary, then the consent block, then the payload header, then the bundle JSON last — and the uploaded body still matches the JSON log entry byte-for-byte", async () => {
    const server = await startMockServer((req) => {
      if (req.url === "/api/cli/bundles") return { status: 200, body: { id: "bundle-tty" } };
      return { status: 404, body: {} };
    });
    servers.push(server);
    process.env.REDENTIAL_SITE_URL = server.url;

    const dir = repoWithOneCommit();
    const configDir = tempConfigDir();
    saveCredentials({ access_token: "secret-tok", site_url: server.url, obtained_at: "now" }, configDir);

    const logs: string[] = [];
    await executeSubmitCommand({
      repoPath: dir,
      author: ["you@example.com"],
      yes: true,
      confirmUpload: true,
      toolVersion: "0.1.0",
      configDir,
      log: (m) => logs.push(m),
      warn: () => {},
      checkForUpdateFn: noCheckForUpdate,
      isTTY: true,
    });

    // 5 lines: short summary, consent box, payload header, JSON, then the
    // post-upload "Uploaded. Bundle id: ..." confirmation (unrelated to
    // this milestone's ordering — logged only after a successful upload).
    expect(logs).toHaveLength(5);
    expect(logs[0]).toContain("of private work");
    expect(logs[0]).toContain("1 commits");
    expect(logs[0]).toContain("0 capabilities detected");
    expect(logs[1]).toContain("WHAT GETS UPLOADED");
    expect(logs[2]).toBe("Exact payload (byte-for-byte what gets sent):");
    expect(() => JSON.parse(logs[3])).not.toThrow();
    // The JSON is the last thing logged BEFORE the upload prompt — the
    // inviolable "printed before upload" guarantee, now positioned last
    // among the pre-prompt output (logs[4] is the post-upload result line).
    const bundleLine = logs[3];

    const requests = bundleRequests(server);
    expect(requests).toHaveLength(1);
    expect(requests[0].body).toBe(bundleLine);
  });

  it("end to end: the short summary line omits the structural suffix for a plain fixture with no structural-evidence skills", async () => {
    // The presence case ("(N structural)" appearing) is covered directly
    // above by formatShortUploadSummary's own unit tests, which construct a
    // hand-built Bundle with a structural-evidence skill — real end-to-end
    // structural detection needs a proof-graph fixture repo (see
    // test/proof-graph/detection.test.ts), out of scope to duplicate here.
    // This test instead proves the real executeSubmitCommand path wires
    // formatShortUploadSummary correctly for the (much more common) case
    // where no detected skill carries `evidence: "structural"`.
    const server = await startMockServer((req) => {
      if (req.url === "/api/cli/bundles") return { status: 200, body: { id: "bundle-structural" } };
      return { status: 404, body: {} };
    });
    servers.push(server);
    process.env.REDENTIAL_SITE_URL = server.url;

    const dir = repoWithOneCommit();
    const configDir = tempConfigDir();
    saveCredentials({ access_token: "secret-tok", site_url: server.url, obtained_at: "now" }, configDir);

    const logs: string[] = [];
    await executeSubmitCommand({
      repoPath: dir,
      author: ["you@example.com"],
      yes: true,
      confirmUpload: true,
      toolVersion: "0.1.0",
      configDir,
      log: (m) => logs.push(m),
      warn: () => {},
      checkForUpdateFn: noCheckForUpdate,
      isTTY: true,
    });

    // No structural-evidence skills in this plain one-commit fixture — the
    // "(N structural)" suffix must be entirely absent, not "(0 structural)".
    expect(logs[0]).not.toContain("structural");
  });

  it("without isTTY, logs are unchanged from before this feature (no consent block, no payload header)", async () => {
    const server = await startMockServer((req) => {
      if (req.url === "/api/cli/bundles") return { status: 200, body: { id: "bundle-no-tty" } };
      return { status: 404, body: {} };
    });
    servers.push(server);
    process.env.REDENTIAL_SITE_URL = server.url;

    const dir = repoWithOneCommit();
    const configDir = tempConfigDir();
    saveCredentials({ access_token: "secret-tok", site_url: server.url, obtained_at: "now" }, configDir);

    const logs: string[] = [];
    await executeSubmitCommand({
      repoPath: dir,
      author: ["you@example.com"],
      yes: true,
      confirmUpload: true,
      toolVersion: "0.1.0",
      configDir,
      log: (m) => logs.push(m),
      warn: () => {},
      checkForUpdateFn: noCheckForUpdate,
    });

    expect(logs.some((l) => l.includes("WHAT GETS UPLOADED"))).toBe(false);
    expect(logs.some((l) => l.includes("Exact payload"))).toBe(false);
    // First log entry is still the raw bundle JSON, as before this feature.
    expect(() => JSON.parse(logs[0])).not.toThrow();
  });
});

describe("identity corroboration", () => {
  it("full match: header carries {corroborated_count, total_claimed} equal, and the notice is printed", async () => {
    const server = await startMockServer((req) => {
      if (req.url === "/api/cli/identity/emails") return { status: 200, body: { emails: ["you@example.com"] } };
      if (req.url === "/api/cli/bundles") return { status: 200, body: { id: "bundle-full" } };
      return { status: 404, body: {} };
    });
    servers.push(server);
    process.env.REDENTIAL_SITE_URL = server.url;

    const dir = repoWithOneCommit();
    const configDir = tempConfigDir();
    saveCredentials({ access_token: "t", site_url: server.url, obtained_at: "now" }, configDir);

    const logs: string[] = [];
    await executeSubmitCommand({
      repoPath: dir,
      author: ["you@example.com"],
      yes: true,
      confirmUpload: true,
      toolVersion: "0.1.0",
      configDir,
      log: (m) => logs.push(m),
      warn: () => {},
      checkForUpdateFn: noCheckForUpdate,
    });

    const requests = bundleRequests(server);
    expect(requests).toHaveLength(1);
    const header = requests[0].headers["x-redential-identity-corroboration"];
    expect(header).toBeDefined();
    expect(JSON.parse(header as string)).toEqual({ corroborated_count: 1, total_claimed: 1 });

    expect(logs.some((l) => l.includes("1 of 1 claimed identities match"))).toBe(true);

    // Corroboration must never alter what was already printed/uploaded as
    // the bundle itself — the body stays byte-identical to the printed line.
    const printedBundleLine = logs.find((l) => l.trim().startsWith("{"));
    expect(printedBundleLine).toBeDefined();
    expect(requests[0].body).toBe(printedBundleLine);
  });

  it("partial match: two claimed authors, only one corroborates", async () => {
    const server = await startMockServer((req) => {
      if (req.url === "/api/cli/identity/emails") return { status: 200, body: { emails: ["you@example.com"] } };
      if (req.url === "/api/cli/bundles") return { status: 200, body: { id: "bundle-partial" } };
      return { status: 404, body: {} };
    });
    servers.push(server);
    process.env.REDENTIAL_SITE_URL = server.url;

    const dir = createRepo();
    dirs.push(dir);
    commit(dir, {
      message: "a",
      authorName: "You",
      authorEmail: "you@example.com",
      files: { "a.ts": "1\n" },
    });
    commit(dir, {
      message: "b",
      authorName: "Them",
      authorEmail: "them@example.com",
      files: { "b.ts": "2\n" },
    });
    const configDir = tempConfigDir();
    saveCredentials({ access_token: "t", site_url: server.url, obtained_at: "now" }, configDir);

    const logs: string[] = [];
    await executeSubmitCommand({
      repoPath: dir,
      author: ["you@example.com", "them@example.com"],
      yes: true,
      confirmUpload: true,
      toolVersion: "0.1.0",
      configDir,
      log: (m) => logs.push(m),
      warn: () => {},
      checkForUpdateFn: noCheckForUpdate,
    });

    const requests = bundleRequests(server);
    expect(requests).toHaveLength(1);
    const header = requests[0].headers["x-redential-identity-corroboration"];
    expect(JSON.parse(header as string)).toEqual({ corroborated_count: 1, total_claimed: 2 });

    expect(logs.some((l) => l.includes("1 of 2") && l.includes("unmatched ones simply won't earn"))).toBe(true);
  });

  it("zero match: header carries {0, total_claimed}, notice is calm, and upload still succeeds", async () => {
    const server = await startMockServer((req) => {
      if (req.url === "/api/cli/identity/emails") return { status: 200, body: { emails: ["other@example.com"] } };
      if (req.url === "/api/cli/bundles") return { status: 200, body: { id: "bundle-zero" } };
      return { status: 404, body: {} };
    });
    servers.push(server);
    process.env.REDENTIAL_SITE_URL = server.url;

    const dir = repoWithOneCommit();
    const configDir = tempConfigDir();
    saveCredentials({ access_token: "t", site_url: server.url, obtained_at: "now" }, configDir);

    const logs: string[] = [];
    await executeSubmitCommand({
      repoPath: dir,
      author: ["you@example.com"],
      yes: true,
      confirmUpload: true,
      toolVersion: "0.1.0",
      configDir,
      log: (m) => logs.push(m),
      warn: () => {},
      checkForUpdateFn: noCheckForUpdate,
    });

    const requests = bundleRequests(server);
    expect(requests).toHaveLength(1);
    const header = requests[0].headers["x-redential-identity-corroboration"];
    expect(JSON.parse(header as string)).toEqual({ corroborated_count: 0, total_claimed: 1 });

    expect(logs.some((l) => l.includes("0 of 1 claimed identities match"))).toBe(true);
    expect(logs.some((l) => l.includes("bundle-zero"))).toBe(true);
  });

  it("endpoint down: no corroboration header is sent, submit still succeeds, and no notice is printed", async () => {
    const server = await startMockServer((req) => {
      if (req.url === "/api/cli/identity/emails") return { status: 503, body: { error: "unavailable" } };
      if (req.url === "/api/cli/bundles") return { status: 200, body: { id: "bundle-down" } };
      return { status: 404, body: {} };
    });
    servers.push(server);
    process.env.REDENTIAL_SITE_URL = server.url;

    const dir = repoWithOneCommit();
    const configDir = tempConfigDir();
    saveCredentials({ access_token: "t", site_url: server.url, obtained_at: "now" }, configDir);

    const logs: string[] = [];
    await executeSubmitCommand({
      repoPath: dir,
      author: ["you@example.com"],
      yes: true,
      confirmUpload: true,
      toolVersion: "0.1.0",
      configDir,
      log: (m) => logs.push(m),
      warn: () => {},
      checkForUpdateFn: noCheckForUpdate,
    });

    const requests = bundleRequests(server);
    expect(requests).toHaveLength(1);
    expect(requests[0].headers["x-redential-identity-corroboration"]).toBeUndefined();
    expect(logs.some((l) => l.includes("claimed identities"))).toBe(false);
  });

  it("prints the corroboration notice before the upload confirmation prompt is invoked", async () => {
    const server = await startMockServer((req) => {
      if (req.url === "/api/cli/identity/emails") return { status: 200, body: { emails: ["you@example.com"] } };
      if (req.url === "/api/cli/bundles") return { status: 200, body: { id: "bundle-order" } };
      return { status: 404, body: {} };
    });
    servers.push(server);
    process.env.REDENTIAL_SITE_URL = server.url;

    const dir = repoWithOneCommit();
    const configDir = tempConfigDir();
    saveCredentials({ access_token: "t", site_url: server.url, obtained_at: "now" }, configDir);

    const logs: string[] = [];
    let logsAtPromptTime: string[] = [];
    await executeSubmitCommand({
      repoPath: dir,
      author: ["you@example.com"],
      yes: true,
      confirmUpload: false,
      toolVersion: "0.1.0",
      configDir,
      log: (m) => logs.push(m),
      warn: () => {},
      checkForUpdateFn: noCheckForUpdate,
      promptConfirmUploadFn: async () => {
        // Snapshot at the moment the prompt is invoked — the corroboration
        // notice must already be among the logs by then (principle 4: the
        // dev must see it before consenting), regardless of what the user
        // ends up answering.
        logsAtPromptTime = [...logs];
        return true;
      },
    });

    expect(logsAtPromptTime.some((l) => l.includes("1 of 1 claimed identities match"))).toBe(true);
  });
});
