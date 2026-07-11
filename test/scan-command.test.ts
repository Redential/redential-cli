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

  it("prints the consent block, the payload header, the JSON, then appends the human-readable summary when isTTY is true", async () => {
    const dir = repoWithOneCommit();
    const configDir = tempConfigDir();

    // Session + already-submitted-identical, so the next-step hint (its own
    // dedicated test block below) doesn't participate in this ordering
    // assertion — the verification line is the true last line only in that
    // state; otherwise the CTA follows it.
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
    const siteUrl = getSiteUrl();
    saveCredentials({ access_token: "t", site_url: siteUrl, obtained_at: "now" }, configDir);
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

    // TTY order: consent block, payload header, bundle JSON, wrapped summary.
    expect(logs).toHaveLength(4);
    expect(logs[0]).toContain("WHAT WOULD GET UPLOADED");
    expect(logs[1]).toBe("Exact payload (byte-for-byte what `redential submit` would send):");
    const bundle = JSON.parse(logs[2]);
    expect(validateAgainstSchema(schema, bundle)).toEqual([]);
    expect(logs[3]).toContain("YOUR PRIVATE REPO, WRAPPED");
    expect(logs[3]).toContain("Nothing left your machine. Verify: github.com/Jppblue/redential-cli");
    // The summary is the LAST thing logged — it's what's left on screen
    // once the JSON above it has scrolled up.
    const lastLineOfLastLog = logs[3].split("\n").filter(Boolean).at(-1);
    expect(lastLineOfLastLog).toContain("Nothing left your machine");
  });

  describe("consent summary block", () => {
    it("prints BEFORE the JSON in TTY mode", async () => {
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

      const consentIndex = logs.findIndex((l) => l.includes("WHAT WOULD GET UPLOADED"));
      const jsonIndex = logs.findIndex((l) => l.trim().startsWith("{"));
      expect(consentIndex).toBeGreaterThanOrEqual(0);
      expect(jsonIndex).toBeGreaterThan(consentIndex);
    });

    it("is absent when stdout is not a TTY", async () => {
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

      expect(logs.some((l) => l.includes("WHAT WOULD GET UPLOADED"))).toBe(false);
      expect(logs).toHaveLength(1);
    });

    it("is absent when --json is passed, even with isTTY true", async () => {
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

      expect(logs.some((l) => l.includes("WHAT WOULD GET UPLOADED"))).toBe(false);
      expect(logs).toHaveLength(1);
    });

    it("numbers in the consent block match the parsed bundle JSON printed below it", async () => {
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

      const consentBlock = logs.find((l) => l.includes("WHAT WOULD GET UPLOADED"))!;
      const bundle = JSON.parse(logs.find((l) => l.trim().startsWith("{"))!);
      expect(consentBlock).toContain(`${bundle.commits.user_total.toLocaleString("en-US")} commits`);
      expect(consentBlock).toContain(`${bundle.detected_skills.length} detected skill`);
    });

    it("plain: true renders the consent block ASCII-only", async () => {
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

      const consentBlock = logs.find((l) => l.includes("WHAT WOULD GET UPLOADED"))!;
      // eslint-disable-next-line no-control-regex
      expect(consentBlock).toMatch(/^[\x20-\x7e\n]*$/);
      expect(consentBlock).not.toContain("╔");
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

      expect(logs[3]).toContain("Want this on a public, verifiable profile?");
      expect(logs[3]).toContain("redential login && redential submit");
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

      expect(logs[3]).toContain("Want this on a public, verifiable profile?");
      expect(logs[3]).toContain("redential submit");
      expect(logs[3]).not.toContain("redential login");
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

      expect(logs[3]).toContain("redential submit");
      expect(logs[3]).not.toContain("redential login");
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

      expect(logs[3]).not.toContain("Want this on a public, verifiable profile?");
      expect(logs[3]).not.toContain("redential submit");
      expect(logs[3]).not.toContain("redential login");
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

      expect(logs[3]).toContain("redential submit");
      expect(logs[3]).not.toContain("redential login");
    });
  });

  it("shows the signing tip in the summary footer when signed ratio is 0%", async () => {
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

    expect(logs[3]).toContain(
      "Tip: sign your commits (git config commit.gpgsign true) — signed history is the strongest anchor for your credential."
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

    expect(logs[3]).not.toContain("Tip: sign your commits");
  });

  it("--json forces JSON-only output even when isTTY is true", async () => {
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
    expect(() => JSON.parse(logs[0])).not.toThrow();
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

    expect(logs).toHaveLength(4);
    // eslint-disable-next-line no-control-regex
    expect(logs.join("\n")).toMatch(/^[\x20-\x7e\n]*$/);
    expect(logs.join("\n")).not.toContain("╔");
  });

  it("the JSON printed in TTY mode is byte-identical to what non-TTY mode prints", async () => {
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

    const ttyLogs: string[] = [];
    await executeScanCommand({
      repoPath: dir,
      author: ["you@example.com"],
      yes: true,
      toolVersion: "test",
      configDir,
      log: (m) => ttyLogs.push(m),
      isTTY: true,
    });

    // Both scans read the same fixture repo/config dir; only `created_at`/
    // `attestation.confirmed_at` (wall-clock `now`) can legitimately differ
    // between the two calls, so compare with those stripped. Non-TTY output
    // is JSON-only (logs[0]); TTY output has the consent block/header ahead
    // of the JSON, so locate it explicitly rather than assuming an index.
    const stripVolatile = (raw: string) => {
      const b = JSON.parse(raw);
      delete b.created_at;
      delete b.attestation.confirmed_at;
      return b;
    };
    const ttyJson = ttyLogs.find((l) => l.trim().startsWith("{"))!;
    expect(stripVolatile(ttyJson)).toEqual(stripVolatile(nonTtyLogs[0]));
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
      // Never leaked into stdout: consent block, payload header, JSON, then
      // the wrapped summary — nothing else, and none contain the progress
      // line's text.
      expect(logs).toHaveLength(4);
      for (const line of logs) expect(line).not.toContain("scanning commits");
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
    it("shows the window label in the wrapped summary when isTTY is true", async () => {
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

      expect(logs[3]).toContain("last 2 years");
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

      expect(logs[3]).not.toContain("last ");
    });
  });
});
