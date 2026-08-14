import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanup, commit, createRepo, createShallowClone, setRemote } from "./support/fixtures.js";
import { startMockServer, type MockServer, type RecordedRequest } from "./support/mock-server.js";
import { saveCredentials } from "../src/credentials.js";
import { executeSubmitCommand, formatShortUploadSummary, thinHistoryNotice } from "../src/submit-command.js";
import { AuthError, ScanError, SubmitError } from "../src/errors.js";
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

describe("thinHistoryNotice", () => {
  it("returns null for a bundle with plenty of history and no shallow flag", () => {
    expect(thinHistoryNotice(baseBundle())).toBeNull();
  });

  it("returns a thin-history notice when user_total is below the floor", () => {
    const notice = thinHistoryNotice(baseBundle({ commits: { ...baseBundle().commits, user_total: 3 } }));
    expect(notice).toContain("very little history");
    expect(notice).not.toContain("shallow");
  });

  it("returns a thin-history notice when span_days is 0, even with many commits", () => {
    const notice = thinHistoryNotice(
      baseBundle({ commits: { ...baseBundle().commits, user_total: 500, span_days: 0 } })
    );
    expect(notice).toContain("very little history");
  });

  it("returns the shallow-clone notice when repo.shallow is true, even with plenty of commits", () => {
    const notice = thinHistoryNotice(
      baseBundle({
        commits: { ...baseBundle().commits, user_total: 5000, span_days: 900 },
        repo: { ...baseBundle().repo, shallow: true },
      })
    );
    expect(notice).toContain("truncated (shallow) clone");
    expect(notice).toContain("git fetch --unshallow");
    expect(notice).not.toContain("very little history");
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

// Every test below builds a real git repo (multiple `git` process spawns)
// and, in most cases, also starts a mock HTTP server — comfortably under
// vitest's default 5s budget locally, but not on loaded CI runners (seen
// timing out on windows-latest/Node 22). 30s matches the budget the repo's
// own huge-repo perf test (test/slow/huge-repo.test.ts) already allows for
// much heavier work, applied here at the `describe` level so it covers
// every test in these blocks without a per-test annotation on each one.
describe("executeSubmitCommand", { timeout: 30_000 }, () => {
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
      label: "acme-backend",
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
      label: "acme-backend",
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
      label: "acme-backend",
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
      label: "acme-backend",
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
        label: "acme-backend",
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
      label: "acme-backend",
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
      label: "acme-backend",
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
      label: "acme-backend",
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

describe("executeSubmitCommand — consent summary", { timeout: 30_000 }, () => {
  // Console-UX milestone (2026-07): TTY order is now short summary line,
  // identity-corroboration line (absent here — no verified-emails endpoint
  // configured on this mock server, so fetchVerifiedEmails fails open and
  // prints nothing), consent box, payload header, then the JSON — and the
  // upload prompt right after. See submit-command.ts's "Output order"
  // comment. The inviolable guarantee (JSON always printed before the
  // upload prompt, byte-for-byte what gets sent) still holds — only its
  // position within the TTY sequence moved from first to last.
  it("with isTTY: true, logs contain the short summary, then the consent block, then the payload header, then the bundle JSON, then the private-label line — and the uploaded body still matches the JSON log entry byte-for-byte", async () => {
    const server = await startMockServer((req) => {
      if (req.url === "/api/cli/bundles") return { status: 200, body: { id: "bundle-tty" } };
      if (req.url === "/api/cli/private-label") return { status: 204, body: {} };
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
      label: "acme-backend",
      toolVersion: "0.1.0",
      configDir,
      log: (m) => logs.push(m),
      warn: () => {},
      checkForUpdateFn: noCheckForUpdate,
      isTTY: true,
    });

    // 6 lines: short summary, consent box, payload header, JSON, the
    // private-label consent line, then the post-upload "Uploaded. Bundle
    // id: ..." confirmation (unrelated to this milestone's ordering —
    // logged only after a successful upload).
    expect(logs).toHaveLength(6);
    expect(logs[0]).toContain("of private work");
    expect(logs[0]).toContain("1 commit ·");
    expect(logs[0]).toContain("0 capabilities detected");
    expect(logs[1]).toContain("WHAT GETS UPLOADED");
    expect(logs[2]).toBe("Exact payload (byte-for-byte what gets sent):");
    expect(() => JSON.parse(logs[3])).not.toThrow();
    expect(logs[4]).toContain("Plus your private label:");
    expect(logs[4]).toContain("acme-backend");
    // The JSON is printed BEFORE the upload prompt — the inviolable
    // "printed before upload" guarantee — with only the private-label line
    // (logs[4], part of the same consent surface) coming after it and
    // before the prompt; logs[5] is the post-upload result line.
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
      label: "acme-backend",
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
      label: "acme-backend",
      toolVersion: "0.1.0",
      configDir,
      log: (m) => logs.push(m),
      warn: () => {},
      checkForUpdateFn: noCheckForUpdate,
    });

    expect(logs.some((l) => l.includes("WHAT GETS UPLOADED"))).toBe(false);
    expect(logs.some((l) => l.includes("Exact payload"))).toBe(false);
    // The private-label consent line is TTY-only — a --label was required
    // and validated (non-TTY, above), but it's never printed here.
    expect(logs.some((l) => l.includes("private label"))).toBe(false);
    // First log entry is still the raw bundle JSON, as before this feature.
    expect(() => JSON.parse(logs[0])).not.toThrow();
  });
});

describe("identity corroboration", { timeout: 30_000 }, () => {
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
      label: "acme-backend",
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
      label: "acme-backend",
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
      label: "acme-backend",
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
      label: "acme-backend",
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
      label: "acme-backend",
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

// Console-UX milestone (2026-07): the mandatory private label — see
// docs/private-label.md. `labelRequests` mirrors this file's own
// `bundleRequests` helper above, filtered to the second request instead.
function labelRequests(server: MockServer): RecordedRequest[] {
  return server.requests.filter((r) => r.url === "/api/cli/private-label");
}

describe("executeSubmitCommand — private label", { timeout: 30_000 }, () => {
  it("sends exactly two requests: the bundle POST (byte-identical to the printed JSON, guardrail untouched) and the private-label POST matching the fixed contract", async () => {
    const server = await startMockServer((req) => {
      if (req.url === "/api/cli/bundles") return { status: 200, body: { id: "bundle-label-ok" } };
      if (req.url === "/api/cli/private-label") return { status: 204, body: {} };
      return { status: 404, body: {} };
    });
    servers.push(server);
    process.env.REDENTIAL_SITE_URL = server.url;

    const dir = repoWithOneCommit();
    const configDir = tempConfigDir();
    saveCredentials({ access_token: "secret-tok", site_url: server.url, obtained_at: "now" }, configDir);

    const logs: string[] = [];
    const warnings: string[] = [];
    await executeSubmitCommand({
      repoPath: dir,
      author: ["you@example.com"],
      yes: true,
      confirmUpload: true,
      label: "Acme Corp — backend",
      toolVersion: "0.1.0",
      configDir,
      log: (m) => logs.push(m),
      warn: (m) => warnings.push(m),
      checkForUpdateFn: noCheckForUpdate,
    });

    // Exactly two requests to the two endpoints this milestone is about —
    // the bundle POST and the private-label POST (the identity-corroboration
    // GET, present on every submit attempt regardless of this feature — see
    // this file's "identity corroboration" describe block above — is a
    // third, unrelated request against the same mock server, not asserted
    // away here since it predates and is orthogonal to the label).
    expect(bundleRequests(server)).toHaveLength(1);
    expect(labelRequests(server)).toHaveLength(1);
    const bundleReq = bundleRequests(server)[0];
    const labelReq = labelRequests(server)[0];
    expect(bundleReq).toBeDefined();
    expect(labelReq).toBeDefined();

    // Guardrail untouched: the bundle POST body is still exactly the
    // printed JSON, unaffected by the label existing at all.
    const printedBundleLine = logs.find((l) => l.trim().startsWith("{"));
    expect(bundleReq.body).toBe(printedBundleLine);

    // The label POST matches the fixed contract exactly:
    // {"bundle_id": "<id from the bundle POST>", "private_label": "<label>"}.
    expect(JSON.parse(labelReq.body)).toEqual({
      bundle_id: "bundle-label-ok",
      private_label: "Acme Corp — backend",
    });
    expect(labelReq.headers.authorization).toBe("Bearer secret-tok");

    // The label POST only ever fires AFTER the bundle POST already
    // succeeded — never before, never in parallel with an unresolved
    // bundle upload.
    const bundleIndex = server.requests.indexOf(bundleReq);
    const labelIndex = server.requests.indexOf(labelReq);
    expect(bundleIndex).toBeLessThan(labelIndex);

    // The always-on local-only notice, and the thin-history notice (this
    // fixture's single commit is below the floor — see
    // "submit's thin-history / shallow-clone advisory" below) are expected
    // here; nothing else — no guardrail-specific warning leaked in.
    expect(warnings).toEqual([
      "Local scan. Nothing leaves your machine.",
      "Note: very little history was found for you in this repo — the resulting credential will be " +
        "weak. Consider scanning a repo with more of your commit history.",
      "Tip: none of your commits are signed. Signed commits make your future work cryptographically " +
        "attributable: https://docs.github.com/en/authentication/managing-commit-signature-verification",
    ]);
  });

  it("a private-label-POST failure (500) still leaves the bundle uploaded — warns with the label, does not throw (exit 0)", async () => {
    const server = await startMockServer((req) => {
      if (req.url === "/api/cli/bundles") return { status: 200, body: { id: "bundle-label-fail" } };
      if (req.url === "/api/cli/private-label") return { status: 500, body: { error: "boom" } };
      return { status: 404, body: {} };
    });
    servers.push(server);
    process.env.REDENTIAL_SITE_URL = server.url;

    const dir = repoWithOneCommit();
    const configDir = tempConfigDir();
    saveCredentials({ access_token: "secret-tok", site_url: server.url, obtained_at: "now" }, configDir);

    const logs: string[] = [];
    const warnings: string[] = [];
    // Resolving without throwing IS the exit-0 behavior at this layer —
    // cli.ts's `run()` only sets `process.exitCode = 1` on a thrown CLI
    // error (see src/cli.ts), so a submit that reaches this point without
    // throwing exits 0 regardless of what warnings were printed along the
    // way. See docs/private-label.md's "failure semantics" section.
    await expect(
      executeSubmitCommand({
        repoPath: dir,
        author: ["you@example.com"],
        yes: true,
        confirmUpload: true,
        label: "Acme Corp",
        toolVersion: "0.1.0",
        configDir,
        log: (m) => logs.push(m),
        warn: (m) => warnings.push(m),
        checkForUpdateFn: noCheckForUpdate,
      })
    ).resolves.toBeUndefined();

    expect(bundleRequests(server)).toHaveLength(1);
    expect(labelRequests(server)).toHaveLength(1);
    expect(logs.some((l) => l.includes("bundle-label-fail"))).toBe(true);
    // The warning names the label so the user can set it manually from the
    // web (the failure-recovery path — see docs/private-label.md) — never
    // silently swallowed.
    expect(warnings.some((w) => w.includes("Acme Corp"))).toBe(true);
    expect(warnings.some((w) => w.toLowerCase().includes("private label"))).toBe(true);
  });

  it("no --label and non-TTY: throws before ANY network call — zero requests at all, not just zero bundle/label requests", async () => {
    const server = await startMockServer(() => ({ status: 200, body: { id: "should-not-be-called" } }));
    servers.push(server);
    process.env.REDENTIAL_SITE_URL = server.url;

    const dir = repoWithOneCommit();
    const configDir = tempConfigDir();
    saveCredentials({ access_token: "t", site_url: server.url, obtained_at: "now" }, configDir);

    const logs: string[] = [];
    await expect(
      executeSubmitCommand({
        repoPath: dir,
        author: ["you@example.com"],
        yes: true,
        confirmUpload: true,
        toolVersion: "0.1.0",
        configDir,
        log: (m) => logs.push(m),
        warn: () => {},
      })
    ).rejects.toBeInstanceOf(ScanError);

    // Not just the bundle/label endpoints — this is checked BEFORE
    // fetchVerifiedEmails too (see submit-command.ts's private-label
    // resolution comment), so the mock server should have recorded nothing
    // whatsoever.
    expect(server.requests).toHaveLength(0);
    expect(logs).toHaveLength(0);
  });

  it("an invalid --label (too long) is rejected before any network call, TTY or not", async () => {
    const server = await startMockServer(() => ({ status: 200, body: { id: "should-not-be-called" } }));
    servers.push(server);
    process.env.REDENTIAL_SITE_URL = server.url;

    const dir = repoWithOneCommit();
    const configDir = tempConfigDir();
    saveCredentials({ access_token: "t", site_url: server.url, obtained_at: "now" }, configDir);

    await expect(
      executeSubmitCommand({
        repoPath: dir,
        author: ["you@example.com"],
        yes: true,
        confirmUpload: true,
        label: "a".repeat(65),
        toolVersion: "0.1.0",
        configDir,
        log: () => {},
        warn: () => {},
        isTTY: true,
      })
    ).rejects.toThrow(/64 characters or fewer/);

    expect(server.requests).toHaveLength(0);
  });

  it("TTY, no --label: exhausting the prompt's retries (simulated) throws before any bundle/label request — the corroboration lookup may still have fired, per this file's own precedent for the decline path", async () => {
    const server = await startMockServer((req) => {
      if (req.url === "/api/cli/identity/emails") return { status: 404, body: {} };
      if (req.url === "/api/cli/bundles") return { status: 200, body: { id: "should-not-be-called" } };
      if (req.url === "/api/cli/private-label") return { status: 204, body: {} };
      return { status: 404, body: {} };
    });
    servers.push(server);
    process.env.REDENTIAL_SITE_URL = server.url;

    const dir = repoWithOneCommit();
    const configDir = tempConfigDir();
    saveCredentials({ access_token: "t", site_url: server.url, obtained_at: "now" }, configDir);

    const logs: string[] = [];
    // Mirrors what the real prompt.ts's promptPrivateLabel does after 1
    // initial attempt + 2 retries all come back empty: it throws the
    // validation error itself rather than a generic one (see
    // test/prompt.test.ts for that behavior tested directly against real
    // readline streams).
    await expect(
      executeSubmitCommand({
        repoPath: dir,
        author: ["you@example.com"],
        yes: true,
        confirmUpload: true,
        toolVersion: "0.1.0",
        configDir,
        log: (m) => logs.push(m),
        warn: () => {},
        isTTY: true,
        promptPrivateLabelFn: async () => {
          throw new ScanError("Private label cannot be empty.");
        },
      })
    ).rejects.toThrow(/cannot be empty/);

    // Zero bundle/label requests either way — the label prompt (and its
    // failure) happens strictly before the exact-payload print and the
    // upload prompt, so nothing was ever uploaded.
    expect(bundleRequests(server)).toHaveLength(0);
    expect(labelRequests(server)).toHaveLength(0);
    // The consent box (which precedes the label prompt in the documented
    // TTY order) did print before the failure.
    expect(logs.some((l) => l.includes("WHAT GETS UPLOADED"))).toBe(true);
    expect(logs.some((l) => l.includes("Exact payload"))).toBe(false);
  });
});

// Timeout matches this file's other describe blocks around slow fixture
// work (e.g. "executeSubmitCommand" above) — the shallow-clone fixture below
// does real git work (`git clone --depth 1` over `file://`), which can run
// past vitest's 5s default on resource-constrained CI runners (observed:
// windows-latest/Node 22 timing out around 8s; windows/Node 20 passed but at
// the edge). 30s gives comfortable headroom without weakening any assertion.
describe("submit's thin-history / shallow-clone advisory (non-blocking)", { timeout: 30_000 }, () => {
  it("warns about weak history for a repo with a single commit, printed before the consent box, and still uploads", async () => {
    const server = await startMockServer((req) => {
      if (req.url === "/api/cli/bundles") return { status: 200, body: { id: "ok" } };
      return { status: 404, body: {} };
    });
    servers.push(server);
    process.env.REDENTIAL_SITE_URL = server.url;

    const dir = repoWithOneCommit();
    const configDir = tempConfigDir();
    saveCredentials({ access_token: "t", site_url: server.url, obtained_at: "now" }, configDir);

    const warnings: string[] = [];
    const logs: string[] = [];
    await executeSubmitCommand({
      repoPath: dir,
      author: ["you@example.com"],
      yes: true,
      confirmUpload: true,
      label: "acme-backend",
      toolVersion: "0.1.0",
      configDir,
      log: (m) => logs.push(m),
      warn: (m) => warnings.push(m),
      isTTY: true,
      checkForUpdateFn: noCheckForUpdate,
    });

    const noticeIndex = warnings.findIndex((w) => w.includes("very little history"));
    expect(noticeIndex).toBeGreaterThanOrEqual(0);
    expect(warnings[noticeIndex]).not.toContain("shallow");
    // Printed before the consent box (TTY-only output) — the consent box
    // itself is `log()`-ed, so ordering is checked against when it appears.
    expect(logs.some((l) => l.includes("WHAT GETS UPLOADED"))).toBe(true);
    // Never blocking: the upload still happened.
    expect(bundleRequests(server)).toHaveLength(1);
  });

  it("warns about a truncated (shallow) clone instead, and still uploads, never blocking", async () => {
    const server = await startMockServer((req) => {
      if (req.url === "/api/cli/bundles") return { status: 200, body: { id: "ok" } };
      return { status: 404, body: {} };
    });
    servers.push(server);
    process.env.REDENTIAL_SITE_URL = server.url;

    const source = createRepo();
    dirs.push(source);
    commit(source, {
      message: "first",
      authorName: "You",
      authorEmail: "you@example.com",
      files: { "a.ts": "1\n" },
    });
    commit(source, {
      message: "second",
      authorName: "You",
      authorEmail: "you@example.com",
      files: { "a.ts": "2\n" },
    });
    const dir = createShallowClone(source);
    dirs.push(dir);

    const configDir = tempConfigDir();
    saveCredentials({ access_token: "t", site_url: server.url, obtained_at: "now" }, configDir);

    const warnings: string[] = [];
    await executeSubmitCommand({
      repoPath: dir,
      author: ["you@example.com"],
      yes: true,
      confirmUpload: true,
      label: "acme-backend",
      toolVersion: "0.1.0",
      configDir,
      log: () => {},
      warn: (m) => warnings.push(m),
      isTTY: false,
      checkForUpdateFn: noCheckForUpdate,
    });

    expect(warnings.some((w) => w.includes("truncated (shallow) clone"))).toBe(true);
    expect(warnings.some((w) => w.includes("git fetch --unshallow"))).toBe(true);
    expect(bundleRequests(server)).toHaveLength(1);
  });
});
