import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanup, commit, createRepo } from "../support/fixtures.js";
import { startMockServer, type MockServer } from "../support/mock-server.js";
import { saveCredentials } from "../../src/credentials.js";
import { executeSubmitCommand } from "../../src/submit-command.js";

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

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

// The server's identity-emails response can legitimately contain OTHER
// verified addresses beyond the one the CLI's own bundle would ever claim
// (e.g. an account's second verified email, unrelated to this repo's
// commits). This pins that such an email — fetched purely to compute a
// match/no-match COUNT — never itself crosses back out of the process in
// any form: not printed, not in the request body sent onward, and never
// written to disk. Only the two integers in the corroboration header (see
// identity-corroboration.ts) are allowed to leave this function's scope.
describe("identity-corroboration never leaks fetched verified emails", () => {
  it("emails fetched from /api/cli/identity/emails never appear in logs, the bundle request body, or on disk", async () => {
    const SECRET_EMAIL = "secret-mailbox-EXAMPLE@corp-example.com";
    const server = await startMockServer((req) => {
      if (req.url === "/api/cli/identity/emails") {
        return { status: 200, body: { emails: [SECRET_EMAIL, "you@example.com"] } };
      }
      if (req.url === "/api/cli/bundles") return { status: 200, body: { id: "bundle-privacy" } };
      return { status: 404, body: {} };
    });
    servers.push(server);
    process.env.REDENTIAL_SITE_URL = server.url;

    const dir = createRepo();
    dirs.push(dir);
    commit(dir, {
      message: "x",
      authorName: "You",
      authorEmail: "you@example.com",
      files: { "a.ts": "1\n" },
    });
    const configDir = tempConfigDir();
    saveCredentials({ access_token: "t", site_url: server.url, obtained_at: "now" }, configDir);

    const logs: string[] = [];
    const warnings: string[] = [];
    await executeSubmitCommand({
      repoPath: dir,
      author: ["you@example.com"],
      yes: true,
      confirmUpload: true,
      toolVersion: "0.1.0",
      configDir,
      log: (m) => logs.push(m),
      warn: (m) => warnings.push(m),
      checkForUpdateFn: async () => {},
    });

    // (1) Never printed.
    for (const line of [...logs, ...warnings]) {
      expect(line).not.toContain(SECRET_EMAIL);
    }

    // (2) Never in the outgoing bundle request body.
    const bundleRequest = server.requests.find((r) => r.url === "/api/cli/bundles");
    expect(bundleRequest).toBeDefined();
    expect(bundleRequest!.body).not.toContain(SECRET_EMAIL);

    // (3) The corroboration header carries only two integers — never an
    // email, never a hash.
    const header = bundleRequest!.headers["x-redential-identity-corroboration"];
    expect(header).toBeDefined();
    expect(header as string).toMatch(/^\{"corroborated_count":\d+,"total_claimed":\d+\}$/);

    // (4) Never written to disk anywhere under the config dir (salt file,
    // credentials, or any future file this command might add there).
    for (const file of walk(configDir)) {
      const contents = readFileSync(file, "utf8");
      expect(contents, `${file} should not contain the fetched verified email`).not.toContain(SECRET_EMAIL);
    }
  });
});
