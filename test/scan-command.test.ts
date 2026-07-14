import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanup, commit, createRepo, setupSshSigning } from "./support/fixtures.js";
import { validateAgainstSchema } from "./support/schema-validate.js";
import { executeScanCommand } from "../src/scan-command.js";
import { saveCredentials } from "../src/credentials.js";
import { bundleContentHash, saveLastSubmission } from "../src/submission-record.js";
import { getSiteUrl } from "../src/config.js";

const schema = JSON.parse(
  readFileSync(new URL("../schema/bundle.v1.json", import.meta.url), "utf8")
);

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) cleanup(dirs.pop()!);
});

function tempConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "redential-config-"));
  dirs.push(dir);
  return dir;
}

function repoWithOneCommit(): string {
  const dir = createRepo();
  dirs.push(dir);
  commit(dir, {
    message: "x",
    authorName: "You",
    authorEmail: "you@example.com",
    files: { "a.ts": "console.log(1)\n" },
  });
  return dir;
}

describe("executeScanCommand", () => {
  describe("output mode selection (phase 2: TTY default is summary-only, no JSON dump)", () => {
    it("prints ONLY the raw JSON bundle when stdout is not a TTY (isTTY omitted)", async () => {
      const dir = repoWithOneCommit();
      const logs: string[] = [];
      await executeScanCommand({
        repoPath: dir,
        author: ["you@example.com"],
        yes: true,
        toolVersion: "test",
        configDir: tempConfigDir(),
        log: (m) => logs.push(m),
      });

      expect(logs).toHaveLength(1);
      const bundle = JSON.parse(logs[0]);
      expect(validateAgainstSchema(schema, bundle)).toEqual([]);
    });

    it("prints ONLY the raw JSON bundle when isTTY is explicitly false", async () => {
      const dir = repoWithOneCommit();
      const logs: string[] = [];
      await executeScanCommand({
        repoPath: dir,
        author: ["you@example.com"],
        yes: true,
        toolVersion: "test",
        configDir: tempConfigDir(),
        log: (m) => logs.push(m),
        isTTY: false,
      });

      expect(logs).toHaveLength(1);
      expect(() => JSON.parse(logs[0])).not.toThrow();
    });

    it("prints ONLY the human-readable summary (no JSON dump) when isTTY is true and --json is not passed", async () => {
      const dir = repoWithOneCommit();
      const logs: string[] = [];
      await executeScanCommand({
        repoPath: dir,
        author: ["you@example.com"],
        yes: true,
        toolVersion: "test",
        configDir: tempConfigDir(),
        log: (m) => logs.push(m),
        isTTY: true,
      });

      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain("PRIVATE WORK, LOCALLY DERIVED");
      expect(logs[0]).toContain("CAPABILITIES DETECTED");
      // No raw JSON dump anywhere in TTY default output.
      expect(logs[0].trim().startsWith("{")).toBe(false);
      expect(() => JSON.parse(logs[0])).toThrow();
    });

    it("--json forces JSON-only output even when isTTY is true, with no summary/banners", async () => {
      const dir = repoWithOneCommit();
      const logs: string[] = [];
      await executeScanCommand({
        repoPath: dir,
        author: ["you@example.com"],
        yes: true,
        toolVersion: "test",
        configDir: tempConfigDir(),
        log: (m) => logs.push(m),
        isTTY: true,
        json: true,
      });

      expect(logs).toHaveLength(1);
      expect(logs[0].trim().startsWith("{")).toBe(true);
      const bundle = JSON.parse(logs[0]);
      expect(validateAgainstSchema(schema, bundle)).toEqual([]);
      expect(logs[0]).not.toContain("PRIVATE WORK, LOCALLY DERIVED");
      expect(logs[0]).not.toContain("WHAT WOULD GET UPLOADED");
    });

    it("--json output on a TTY is byte-identical to piped (non-TTY) output", async () => {
      const dir = repoWithOneCommit();
      const configDir = tempConfigDir();

      const nonTtyLogs: string[] = [];
      await executeScanCommand({
        repoPath: dir,
        author: ["you@example.com"],
        yes: true,
        toolVersion: "test",
        configDir,
        log: (m) => nonTtyLogs.push(m),
        isTTY: false,
      });

      const jsonTtyLogs: string[] = [];
      await executeScanCommand({
        repoPath: dir,
        author: ["you@example.com"],
        yes: true,
        toolVersion: "test",
        configDir,
        log: (m) => jsonTtyLogs.push(m),
        isTTY: true,
        json: true,
      });

      // Only created_at/attestation.confirmed_at (wall-clock `now`) can
      // legitimately differ between the two separate scans.
      const stripVolatile = (raw: string) => {
        const b = JSON.parse(raw);
        delete b.created_at;
        delete b.attestation.confirmed_at;
        return b;
      };
      expect(jsonTtyLogs).toHaveLength(1);
      expect(stripVolatile(jsonTtyLogs[0])).toEqual(stripVolatile(nonTtyLogs[0]));
    });

    it("--details adds the histogram sections to the TTY summary; the default (no --details) omits them", async () => {
      const dir = repoWithOneCommit();

      const defaultLogs: string[] = [];
      await executeScanCommand({
        repoPath: dir,
        author: ["you@example.com"],
        yes: true,
        toolVersion: "test",
        configDir: tempConfigDir(),
        log: (m) => defaultLogs.push(m),
        isTTY: true,
      });
      expect(defaultLogs[0]).not.toContain("COMMITS BY HOUR");
      expect(defaultLogs[0]).not.toContain("COMMITS BY WEEKDAY");

      const detailsLogs: string[] = [];
      await executeScanCommand({
        repoPath: dir,
        author: ["you@example.com"],
        yes: true,
        toolVersion: "test",
        configDir: tempConfigDir(),
        log: (m) => detailsLogs.push(m),
        isTTY: true,
        details: true,
      });
      expect(detailsLogs).toHaveLength(1);
      expect(detailsLogs[0]).toContain("COMMITS BY HOUR");
      expect(detailsLogs[0]).toContain("COMMITS BY WEEKDAY");
    });

    it("--details has no effect on piped/non-TTY output — still exactly the raw JSON", async () => {
      const dir = repoWithOneCommit();
      const logs: string[] = [];
      await executeScanCommand({
        repoPath: dir,
        author: ["you@example.com"],
        yes: true,
        toolVersion: "test",
        configDir: tempConfigDir(),
        log: (m) => logs.push(m),
        isTTY: false,
        details: true,
      });

      expect(logs).toHaveLength(1);
      expect(() => JSON.parse(logs[0])).not.toThrow();
    });
  });

  describe("closing next-step hint — three states, end to end", () => {
    it("no stored session: shows the login+submit CTA", async () => {
      const dir = repoWithOneCommit();
      const logs: string[] = [];
      await executeScanCommand({
        repoPath: dir,
        author: ["you@example.com"],
        yes: true,
        toolVersion: "test",
        configDir: tempConfigDir(),
        log: (m) => logs.push(m),
        isTTY: true,
      });

      expect(logs[0]).toContain("Add this private work to your public Redential profile:");
      expect(logs[0]).toContain("redential login && redential submit");
    });

    it("stored session, nothing submitted yet: shows the submit-only CTA", async () => {
      const dir = repoWithOneCommit();
      const configDir = tempConfigDir();
      saveCredentials({ access_token: "t", site_url: getSiteUrl(), obtained_at: "now" }, configDir);

      const logs: string[] = [];
      await executeScanCommand({
        repoPath: dir,
        author: ["you@example.com"],
        yes: true,
        toolVersion: "test",
        configDir,
        log: (m) => logs.push(m),
        isTTY: true,
      });

      expect(logs[0]).toContain("Add this private work to your public Redential profile:");
      expect(logs[0]).toContain("redential submit");
      expect(logs[0]).not.toContain("redential login");
    });

    it("stored session, but the last submission was for a DIFFERENT site: treated as not-yet-submitted (submit-only CTA)", async () => {
      const dir = repoWithOneCommit();
      const configDir = tempConfigDir();
      const siteUrl = getSiteUrl();
      saveCredentials({ access_token: "t", site_url: siteUrl, obtained_at: "now" }, configDir);

      const first: string[] = [];
      await executeScanCommand({
        repoPath: dir,
        author: ["you@example.com"],
        yes: true,
        toolVersion: "test",
        configDir,
        log: (m) => first.push(m),
        isTTY: false,
      });
      saveLastSubmission(
        {
          site_url: "https://a-different-site.example",
          bundle_hash: bundleContentHash(JSON.parse(first[0])),
          submitted_at: "now",
        },
        configDir
      );

      const logs: string[] = [];
      await executeScanCommand({
        repoPath: dir,
        author: ["you@example.com"],
        yes: true,
        toolVersion: "test",
        configDir,
        log: (m) => logs.push(m),
        isTTY: true,
      });

      expect(logs[0]).toContain("redential submit");
      expect(logs[0]).not.toContain("redential login");
    });

    it("stored session, this exact bundle already submitted: shows no next-step hint at all", async () => {
      const dir = repoWithOneCommit();
      const configDir = tempConfigDir();
      const siteUrl = getSiteUrl();
      saveCredentials({ access_token: "t", site_url: siteUrl, obtained_at: "now" }, configDir);

      const first: string[] = [];
      await executeScanCommand({
        repoPath: dir,
        author: ["you@example.com"],
        yes: true,
        toolVersion: "test",
        configDir,
        log: (m) => first.push(m),
        isTTY: false,
      });
      saveLastSubmission(
        { site_url: siteUrl, bundle_hash: bundleContentHash(JSON.parse(first[0])), submitted_at: "now" },
        configDir
      );

      const logs: string[] = [];
      await executeScanCommand({
        repoPath: dir,
        author: ["you@example.com"],
        yes: true,
        toolVersion: "test",
        configDir,
        log: (m) => logs.push(m),
        isTTY: true,
      });

      expect(logs[0]).not.toContain("Add this private work to your public Redential profile:");
      expect(logs[0]).not.toContain("→ redential submit");
      expect(logs[0]).not.toContain("redential login");
    });

    it("a new commit after submitting changes the bundle content: the CTA comes back", async () => {
      const dir = repoWithOneCommit();
      const configDir = tempConfigDir();
      const siteUrl = getSiteUrl();
      saveCredentials({ access_token: "t", site_url: siteUrl, obtained_at: "now" }, configDir);

      const first: string[] = [];
      await executeScanCommand({
        repoPath: dir,
        author: ["you@example.com"],
        yes: true,
        toolVersion: "test",
        configDir,
        log: (m) => first.push(m),
        isTTY: false,
      });
      saveLastSubmission(
        { site_url: siteUrl, bundle_hash: bundleContentHash(JSON.parse(first[0])), submitted_at: "now" },
        configDir
      );

      commit(dir, {
        message: "y",
        authorName: "You",
        authorEmail: "you@example.com",
        files: { "b.ts": "console.log(2)\n" },
      });

      const logs: string[] = [];
      await executeScanCommand({
        repoPath: dir,
        author: ["you@example.com"],
        yes: true,
        toolVersion: "test",
        configDir,
        log: (m) => logs.push(m),
        isTTY: true,
      });

      expect(logs[0]).toContain("redential submit");
      expect(logs[0]).not.toContain("redential login");
    });
  });

  it("shows the signing tip in the summary when signed ratio is 0%", async () => {
    const dir = repoWithOneCommit(); // unsigned commit -> signed.ratio === 0
    const logs: string[] = [];
    await executeScanCommand({
      repoPath: dir,
      author: ["you@example.com"],
      yes: true,
      toolVersion: "test",
      configDir: tempConfigDir(),
      log: (m) => logs.push(m),
      isTTY: true,
    });

    expect(logs[0]).toContain(
      "Tip: signing future commits adds a stronger identity anchor to your attestation."
    );
  });

  it("omits the signing tip when at least one commit is signed", async () => {
    const dir = createRepo();
    dirs.push(dir);
    setupSshSigning(dir, "you@example.com");
    commit(dir, {
      message: "x",
      authorName: "You",
      authorEmail: "you@example.com",
      files: { "a.ts": "console.log(1)\n" },
      sign: true,
    });

    const logs: string[] = [];
    await executeScanCommand({
      repoPath: dir,
      author: ["you@example.com"],
      yes: true,
      toolVersion: "test",
      configDir: tempConfigDir(),
      log: (m) => logs.push(m),
      isTTY: true,
    });

    expect(logs[0]).not.toContain("Tip: signing future commits");
  });

  it("plain: true renders the summary with the ASCII fallback theme (no ANSI, no box-drawing)", async () => {
    const dir = repoWithOneCommit();
    const logs: string[] = [];
    await executeScanCommand({
      repoPath: dir,
      author: ["you@example.com"],
      yes: true,
      toolVersion: "test",
      configDir: tempConfigDir(),
      log: (m) => logs.push(m),
      isTTY: true,
      plain: true,
    });

    expect(logs).toHaveLength(1);
    // eslint-disable-next-line no-control-regex
    expect(logs.join("\n")).toMatch(/^[\x20-\x7e\n]*$/);
    expect(logs.join("\n")).not.toContain("╔");
  });

  describe("huge-repo progress", () => {
    it("writes progress ONLY via progressWrite, never through the stdout `log` callback, when isTTY is true", async () => {
      const dir = repoWithOneCommit();
      const logs: string[] = [];
      const progressWrites: string[] = [];
      await executeScanCommand({
        repoPath: dir,
        author: ["you@example.com"],
        yes: true,
        toolVersion: "test",
        configDir: tempConfigDir(),
        log: (m) => logs.push(m),
        isTTY: true,
        progressWrite: (m) => progressWrites.push(m),
      });

      expect(progressWrites.length).toBeGreaterThan(0);
      expect(progressWrites.join("")).toContain("scanning commits...");
      // The one-commit fixture means scanned === total immediately — the
      // reporter must still reach the final line and terminate it with \n.
      expect(progressWrites.join("")).toContain("scanning commits... 1/1\n");
      // Never leaked into stdout: only the summary is logged.
      expect(logs).toHaveLength(1);
      expect(logs[0]).not.toContain("scanning commits");
    });

    it("never writes progress when stdout is not a TTY — piped JSON output is untouched", async () => {
      const dir = repoWithOneCommit();
      const logs: string[] = [];
      const progressWrites: string[] = [];
      await executeScanCommand({
        repoPath: dir,
        author: ["you@example.com"],
        yes: true,
        toolVersion: "test",
        configDir: tempConfigDir(),
        log: (m) => logs.push(m),
        isTTY: false,
        progressWrite: (m) => progressWrites.push(m),
      });

      expect(progressWrites).toHaveLength(0);
      expect(logs).toHaveLength(1);
      expect(() => JSON.parse(logs[0])).not.toThrow();
    });

    it("never writes progress under --json, even when isTTY is true — --json is treated as non-interactive throughout", async () => {
      const dir = repoWithOneCommit();
      const logs: string[] = [];
      const progressWrites: string[] = [];
      await executeScanCommand({
        repoPath: dir,
        author: ["you@example.com"],
        yes: true,
        toolVersion: "test",
        configDir: tempConfigDir(),
        log: (m) => logs.push(m),
        isTTY: true,
        json: true,
        progressWrite: (m) => progressWrites.push(m),
      });

      expect(progressWrites).toHaveLength(0);
      expect(logs).toHaveLength(1);
      expect(() => JSON.parse(logs[0])).not.toThrow();
    });

    it("piped stdout is byte-identical whether or not a huge-repo progress reporter would have fired", async () => {
      const dir = repoWithOneCommit();
      const configDir = tempConfigDir();

      const withoutProgressWrite: string[] = [];
      await executeScanCommand({
        repoPath: dir,
        author: ["you@example.com"],
        yes: true,
        toolVersion: "test",
        configDir,
        log: (m) => withoutProgressWrite.push(m),
        isTTY: false,
      });

      const withProgressWrite: string[] = [];
      await executeScanCommand({
        repoPath: dir,
        author: ["you@example.com"],
        yes: true,
        toolVersion: "test",
        configDir,
        log: (m) => withProgressWrite.push(m),
        isTTY: false,
        progressWrite: () => {
          throw new Error("progressWrite must never be called when stdout is not a TTY");
        },
      });

      // Only created_at/attestation.confirmed_at (wall-clock `now`) can
      // legitimately differ between the two separate scans — same
      // stripVolatile approach as the byte-identical TTY/non-TTY test above.
      const stripVolatile = (raw: string) => {
        const b = JSON.parse(raw);
        delete b.created_at;
        delete b.attestation.confirmed_at;
        return b;
      };
      expect(withProgressWrite.map(stripVolatile)).toEqual(withoutProgressWrite.map(stripVolatile));
    });
  });

  describe("--since window", () => {
    it("shows the window label in the summary when isTTY is true", async () => {
      const dir = repoWithOneCommit();
      const logs: string[] = [];
      await executeScanCommand({
        repoPath: dir,
        author: ["you@example.com"],
        yes: true,
        toolVersion: "test",
        configDir: tempConfigDir(),
        log: (m) => logs.push(m),
        isTTY: true,
        since: "2years",
      });

      expect(logs[0]).toContain("last 2 years");
    });

    it("omits the window label when --since is not passed", async () => {
      const dir = repoWithOneCommit();
      const logs: string[] = [];
      await executeScanCommand({
        repoPath: dir,
        author: ["you@example.com"],
        yes: true,
        toolVersion: "test",
        configDir: tempConfigDir(),
        log: (m) => logs.push(m),
        isTTY: true,
      });

      expect(logs[0]).not.toContain("last ");
    });
  });
});
