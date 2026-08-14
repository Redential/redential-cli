import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable, Writable } from "node:stream";
import { cleanup, commit, createRepo } from "./support/fixtures.js";
import { buildBundleInteractively } from "../src/build-bundle.js";
import { executeScanCommand } from "../src/scan-command.js";
import { saveCredentials } from "../src/credentials.js";
import { getSiteUrl } from "../src/config.js";
import { __setDefaultStreamsForTest } from "../src/prompt.js";

/**
 * Regression coverage for the real CLI binary (owner follow-up, 2026-08 —
 * bugs found via a real pty, missed by all 875 previously-green tests
 * because every one of them injects fake prompt/stream functions instead
 * of driving the REAL `src/prompt.ts` exports). Two layers:
 *
 * 1. A subprocess smoke test — spawns the actual built CLI (`dist/cli.js`)
 *    with real piped (non-TTY) stdin/stdout/stderr. This is what a real
 *    `redential scan | jq` or CI invocation looks like, and it's the only
 *    layer that exercises `src/cli.ts`/`src/program.ts` (commander wiring,
 *    the `run()` error handler) at all — every other test in this suite
 *    calls `executeScanCommand`/`buildBundleInteractively` directly.
 *    Piped stdin can only ever exercise the NON-interactive path (a real
 *    pty would be needed for the TTY path, and this repo intentionally
 *    adds no new dependency to get one — see `node-pty`'s absence from
 *    package.json) — so this layer proves EOF handling, exit codes, and
 *    stdout/stderr purity (zero ANSI codes on a non-TTY stream) for the
 *    piped path.
 * 2. A "real streams" unit-level layer — drives `buildBundleInteractively`
 *    with `isTTY: true` and the REAL exported prompt functions (never the
 *    injectable `...Fn` options every other test in this suite uses),
 *    via `prompt.ts`'s `__setDefaultStreamsForTest` test-only override, so
 *    fake PassThrough-shaped streams stand in for `process.stdin`/`stdout`
 *    without needing a real terminal at all. This is the layer that would
 *    actually have caught the reported bug (an old, separate identity
 *    question firing before the unified `promptConfirmScan` one) — the
 *    injected-fake tests elsewhere in this suite only ever assert on
 *    RETURN VALUES from `promptUseGitIdentityFn`/`promptAuthorsFn`, never
 *    on how many real questions get asked or what they actually say.
 */

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI_PATH = join(REPO_ROOT, "dist", "cli.js");

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) cleanup(dirs.pop()!);
  __setDefaultStreamsForTest(null);
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

/**
 * Two distinct author emails, with `git config user.email` set to match
 * one of them — the exact shape that reproduced the owner's pty bug: the
 * git-identity fast path (build-bundle.ts's `selectAuthorsTodaysFlow`)
 * offers `you@example.com` as a fast default before the numbered list.
 */
function repoWithTwoAuthorsGitIdentityMatch(): string {
  const dir = createRepo();
  dirs.push(dir);
  commit(dir, { message: "x1", authorName: "You", authorEmail: "you@example.com", files: { "a.ts": "1\n" } });
  commit(dir, { message: "x2", authorName: "You", authorEmail: "you@example.com", files: { "a.ts": "2\n" } });
  commit(dir, { message: "b1", authorName: "Bot", authorEmail: "bot@example.com", files: { "b.ts": "1\n" } });
  execFileSync("git", ["config", "user.email", "you@example.com"], { cwd: dir });
  return dir;
}

describe("cli-smoke — subprocess: the real built CLI, piped (non-TTY) stdin/stdout/stderr", { timeout: 30_000 }, () => {
  beforeAll(() => {
    // `dist/` is git-ignored and NOT guaranteed to exist or be fresh when
    // `npm test` runs — CI's own workflow (.github/workflows/ci.yml) runs
    // `npm test` BEFORE `npm run build`. No `tsx`/`ts-node` is available
    // either (this repo adds zero new dependencies without discussion —
    // CLAUDE.md), so this test builds its own fresh `dist/` up front,
    // exactly what `npm run build` does, self-contained and deterministic
    // regardless of run order.
    // Invoke the TypeScript compiler's JS entrypoint directly via
    // `process.execPath` rather than shelling out to `npx`/`tsc`: on
    // Windows those are `.cmd` shims, and `execFileSync` without `shell:
    // true` can't spawn them (ENOENT). This mirrors how the CLI itself is
    // spawned below (`process.execPath` + a `dist/cli.js` path), so no new
    // dependency and no platform-specific lookup is needed.
    const tscPath = join(REPO_ROOT, "node_modules", "typescript", "lib", "tsc.js");
    execFileSync(process.execPath, [tscPath, "-p", "tsconfig.json"], { cwd: REPO_ROOT, stdio: "pipe" });
  }, 30_000);

  function spawnCli(args: string[], cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [CLI_PATH, ...args], { cwd, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
      // Closed/empty stdin — same shape as `redential scan < /dev/null` or
      // any CI invocation with no attached terminal. Never a TTY.
      child.stdin.end();
    });
  }

  // eslint-disable-next-line no-control-regex
  const ANSI_PATTERN = /\x1b\[[0-9;]*m/;

  it("closed stdin, no --author/--yes: a clean EOF error, exit 1, stderr has zero ANSI codes", async () => {
    const dir = repoWithOneCommit();
    const { code, stdout, stderr } = await spawnCli(["scan", "--repo", dir], dir);

    expect(code).toBe(1);
    // No bundle is ever produced on this path — readline's own prompt text
    // (the single unified question, single-candidate path) legitimately
    // goes to stdout by default (readline's own `output` stream), so stdout
    // isn't necessarily empty here; what matters is no JSON ever printed.
    expect(() => JSON.parse(stdout)).toThrow();
    expect(stderr).toContain("Error:");
    expect(stderr).not.toMatch(ANSI_PATTERN);
    expect(stdout).not.toMatch(ANSI_PATTERN);
  }, 15_000);

  it("closed stdin, --author/--yes (fully non-interactive): stdout is exactly the raw bundle JSON, stderr has zero ANSI codes", async () => {
    const dir = repoWithOneCommit();
    const { code, stdout, stderr } = await spawnCli(
      ["scan", "--repo", dir, "--author", "you@example.com", "--yes"],
      dir
    );

    expect(code).toBe(0);
    expect(() => JSON.parse(stdout)).not.toThrow();
    const bundle = JSON.parse(stdout);
    expect(bundle.commits.user_total).toBe(1);
    expect(stderr).not.toMatch(ANSI_PATTERN);
  }, 15_000);

  it("--json on closed stdin behaves identically to piped stdout (no ANSI, valid JSON)", async () => {
    const dir = repoWithOneCommit();
    const { code, stdout, stderr } = await spawnCli(
      ["scan", "--repo", dir, "--author", "you@example.com", "--yes", "--json"],
      dir
    );

    expect(code).toBe(0);
    expect(() => JSON.parse(stdout)).not.toThrow();
    expect(stderr).not.toMatch(ANSI_PATTERN);
  }, 15_000);
});

function lineInput(line: string): Readable {
  const input = new Readable({ read() {} });
  input.push(`${line}\n`);
  input.push(null);
  return input;
}

// Feeds several lines in sequence (as if the user answered a re-asked
// prompt multiple times) — needed for promptConfirmScan's re-ask loop.
// Delivers each line via `setImmediate` inside `_read()` so each answer is
// consumed (and the next `question()` call issued) before the following
// line arrives — see test/prompt.test.ts's identical helper for the full
// rationale. Never signals EOF; the tests using this always resolve or
// reject before exhausting the given lines.
function multiLineInput(...lines: string[]): Readable {
  let i = 0;
  return new Readable({
    read() {
      if (i >= lines.length) return;
      const line = lines[i];
      i++;
      setImmediate(() => this.push(`${line}\n`));
    },
  });
}

function captureOutput(): { stream: Writable; text: () => string } {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  return { stream, text: () => Buffer.concat(chunks).toString("utf8") };
}

function countQuestions(text: string): number {
  // Matches every question this identity-selection flow can ask — every
  // one of them GRANTS authorization on "yes" (the numbered-list
  // selection itself is separate, never a y/n), so every one of them now
  // shares the CLI's one no-default authorization gate's exact "(y/n)"
  // shape (owner directive, 2026-08: promptUseGitIdentity/
  // promptUseSavedSelection delegate straight to promptConfirmScan).
  return (text.match(/\(y\/n\)/g) ?? []).length;
}

describe("cli-smoke — real streams: exactly ONE question on the TTY identity-selection path", () => {
  it("single candidate: promptConfirmScan is the ONLY question asked, with the unified wording (not the old 'Use this identity?' text)", async () => {
    const dir = repoWithOneCommit();
    const configDir = tempConfigDir();
    const out = captureOutput();
    __setDefaultStreamsForTest({ input: lineInput("y"), output: out.stream });

    const bundle = await buildBundleInteractively({
      repoPath: dir,
      author: [],
      yes: false,
      toolVersion: "0.1.0",
      configDir,
      isTTY: true,
      warn: () => {},
    });

    expect(bundle.commits.user_total).toBe(1);
    const text = out.text();
    expect(countQuestions(text)).toBe(1);
    expect(text).toContain(
      "Scan 1 commit by you@example.com? This confirms you're authorized to analyze this repository. (y/n)"
    );
    expect(text).not.toContain("Use this identity?");
    expect(text).not.toContain("Found 1 commit authored by");
  });

  it("2+ candidates matching git config user.email: the git-identity offer alone is the ONLY question asked when accepted (the exact shape reproduced via pty)", async () => {
    const dir = repoWithTwoAuthorsGitIdentityMatch();
    const configDir = tempConfigDir();
    const out = captureOutput();
    __setDefaultStreamsForTest({ input: lineInput("y"), output: out.stream });

    const bundle = await buildBundleInteractively({
      repoPath: dir,
      author: [],
      yes: false,
      toolVersion: "0.1.0",
      configDir,
      isTTY: true,
      warn: () => {},
    });

    expect(bundle.commits.user_total).toBe(2);
    const text = out.text();
    // Accepting the git-identity fast-path offer already fully answers
    // identity AND authorization in one shot (bug fix, owner follow-up
    // 2026-08) — no separate promptConfirmScan call follows it.
    expect(countQuestions(text)).toBe(1);
    expect(text).toContain(
      "Scan 2 commits by you@example.com? This confirms you're authorized to analyze this repository. (y/n)"
    );
    expect(text).not.toContain("Use this identity?");
    expect(text).not.toContain("Found 2 commits authored by");
  });

  it("declining the git-identity fast path falls through to the full list, and THAT selection still gets exactly one (separate) confirmation", async () => {
    const dir = repoWithTwoAuthorsGitIdentityMatch();
    const configDir = tempConfigDir();
    const out = captureOutput();
    // First answer ("n") declines the git-identity fast-path offer
    // ("(y/n)", no default — consistency fix, owner directive 2026-08:
    // its "yes" grants authorization, same as promptConfirmScan itself, so
    // it shares that exact no-default/re-ask behavior); the flow then
    // falls through to the full numbered list, whose own answer ("1,2")
    // selects both authors; the final promptConfirmScan ("(y/n)", no
    // default) for that pick is then answered "y".
    const answers = ["n", "1,2", "y"];
    let i = 0;
    const input = new Readable({
      read() {
        if (i >= answers.length) return;
        const answer = answers[i++];
        setImmediate(() => this.push(`${answer}\n`));
      },
    });
    __setDefaultStreamsForTest({ input, output: out.stream });

    const bundle = await buildBundleInteractively({
      repoPath: dir,
      author: [],
      yes: false,
      toolVersion: "0.1.0",
      configDir,
      isTTY: true,
      warn: () => {},
    });

    expect(bundle.commits.user_total).toBe(3);
    const text = out.text();
    // Two questions total: the declined fast-path offer, and the ONE
    // confirmation for the eventual full-list pick — never a THIRD,
    // redundant confirmation of the same pick.
    expect(countQuestions(text)).toBe(2);
  });

  // Consistency fix (owner directive, 2026-08): the git-identity fast-path
  // offer's "yes" also grants authorization, so it must re-ask on an empty
  // answer too — driven here through the REAL end-to-end flow (the shape
  // that would have caught the original bug), not just prompt.ts's own
  // unit test for the underlying delegation.
  it("the git-identity fast-path offer also re-asks on an empty answer, end to end — never silently grants authorization on repeat scans", async () => {
    const dir = repoWithTwoAuthorsGitIdentityMatch();
    const configDir = tempConfigDir();
    const out = captureOutput();
    __setDefaultStreamsForTest({ input: multiLineInput("", "", "y"), output: out.stream });

    const bundle = await buildBundleInteractively({
      repoPath: dir,
      author: [],
      yes: false,
      toolVersion: "0.1.0",
      configDir,
      isTTY: true,
      warn: () => {},
    });

    expect(bundle.commits.user_total).toBe(2);
    const askedCount = (
      out.text().match(/Scan 2 commits by you@example\.com\? This confirms you're authorized/g) ?? []
    ).length;
    expect(askedCount).toBe(3);
  });

  // Owner directive (2026-08): ANY question whose "yes" grants
  // authorization uses the no-default re-ask loop — an empty answer (bare
  // Enter) neither proceeds nor cancels, it re-asks until an explicit y or
  // n. `promptConfirmScan` is the CLI's one true authorization gate, but
  // the git-identity/saved-selection fast-path offers share its exact
  // behavior too (see the test just above) since their own "yes" also
  // grants it. Driven here through the REAL flow end to end (real prompt
  // function, real build-bundle.ts control flow), not just prompt.ts's own
  // unit tests — this is exactly the shape that would have caught bug 1 if
  // it had existed for this behavior too.
  describe("the unified authorization prompt re-asks on an empty answer, end to end", () => {
    it("empty answer, then 'y': re-asks once, then proceeds", async () => {
      const dir = repoWithOneCommit();
      const configDir = tempConfigDir();
      const out = captureOutput();
      __setDefaultStreamsForTest({ input: multiLineInput("", "y"), output: out.stream });

      const bundle = await buildBundleInteractively({
        repoPath: dir,
        author: [],
        yes: false,
        toolVersion: "0.1.0",
        configDir,
        isTTY: true,
        warn: () => {},
      });

      expect(bundle.commits.user_total).toBe(1);
      const askedCount = (
        out.text().match(/Scan 1 commit by you@example\.com\? This confirms you're authorized/g) ?? []
      ).length;
      expect(askedCount).toBe(2);
    });

    it("empty answer, then 'n': re-asks once, then declines (a clean ScanError, never a silent proceed)", async () => {
      const dir = repoWithOneCommit();
      const configDir = tempConfigDir();
      const out = captureOutput();
      __setDefaultStreamsForTest({ input: multiLineInput("", "n"), output: out.stream });

      await expect(
        buildBundleInteractively({
          repoPath: dir,
          author: [],
          yes: false,
          toolVersion: "0.1.0",
          configDir,
          isTTY: true,
          warn: () => {},
        })
      ).rejects.toThrow("Authorization not confirmed");

      const askedCount = (
        out.text().match(/Scan 1 commit by you@example\.com\? This confirms you're authorized/g) ?? []
      ).length;
      expect(askedCount).toBe(2);
    });
  });
});

describe("cli-smoke — scan→submit hand-off: the intro banner must not print twice", () => {
  // Owner follow-up (2026-08, real-terminal repro): the hand-off
  // (scan-command.ts's `continueIntoSubmit`) calls `buildBundleInteractively`
  // a SECOND time in the same process — submit needs its own freshly-built
  // bundle (see that function's own comment on why the rebuild itself is
  // intentional, not a bug). Without `suppressIntro`, that second call
  // printed its intro lines (the expectation line, the local-scan line,
  // "Reading git history...") again, right in the middle of the combined
  // output, immediately after the connectable-repo notice. Driven here
  // through the REAL end-to-end flow (executeScanCommand -> real
  // buildBundleInteractively -> real continuation into the REAL
  // executeSubmitCommand, not the mocked one test/scan-command.test.ts
  // uses) — declining the final upload question keeps this test
  // network-free (see test/privacy/zero-network.test.ts's sibling
  // guarantee), so no mock server is needed here either.
  //
  // Feeds answers driven by the OUTPUT actually written so far, not by a
  // fixed line sequence (`multiLineInput` further up in this file) — this
  // hand-off crosses THREE separate `readline.createInterface()` calls
  // across two different modules (the git-identity offer in
  // build-bundle.ts, then the private-label and upload-confirm prompts in
  // submit-command.ts), and Node's `Readable` can eagerly pull several
  // queued lines into its internal buffer before the first `rl.question()`
  // even starts consuming — a plain fixed-sequence feeder measurably
  // dropped the 2nd/3rd answers in exactly this shape (verified while
  // writing this test) since only the FIRST buffered 'line' event reaches
  // whichever `question()` call happens to be pending at that moment; the
  // rest are silently lost when that interface closes. Waiting for the
  // actual prompt text to appear in `output` before pushing the next
  // answer sidesteps that race entirely, since a `rl.question()` call
  // always writes its prompt text before awaiting input.
  function drivenBySequence(sequence: Array<{ waitForText: string; answer: string }>): {
    input: Readable;
    output: Writable;
  } {
    const input = new Readable({ read() {} });
    let buffered = "";
    let next = 0;
    const output = new Writable({
      write(chunk, _encoding, callback) {
        buffered += chunk.toString();
        if (next < sequence.length && buffered.includes(sequence[next].waitForText)) {
          const { answer } = sequence[next];
          next++;
          buffered = "";
          setImmediate(() => input.push(`${answer}\n`));
        }
        callback();
      },
    });
    return { input, output };
  }

  it("the expectation line and the local-scan line each appear exactly ONCE in the combined scan+submit output", async () => {
    const dir = repoWithTwoAuthorsGitIdentityMatch();
    const configDir = tempConfigDir();
    saveCredentials({ access_token: "t", site_url: getSiteUrl(), obtained_at: "now" }, configDir);

    // In order: (1) accepts the git-identity fast-path offer — already
    // fully confirms identity + authorization in one shot, so scan's own
    // buildBundleInteractively call asks nothing else; (2) the private
    // label submit's rebuild prompts for; (3) declines the final upload
    // question (keeps this test at zero network calls).
    const { input, output } = drivenBySequence([
      { waitForText: "Scan 2 commits by you@example.com", answer: "y" },
      { waitForText: "Private label for this repo", answer: "Acme Corp" },
      { waitForText: "Upload this to your Redential profile", answer: "n" },
    ]);
    __setDefaultStreamsForTest({ input, output });

    const warnings: string[] = [];
    try {
      await executeScanCommand({
        repoPath: dir,
        author: [],
        yes: false,
        toolVersion: "0.1.0",
        configDir,
        log: () => {},
        warn: (m) => warnings.push(m),
        isTTY: true,
      });
    } finally {
      __setDefaultStreamsForTest(null);
    }

    const expectationCount = warnings.filter((w) => w.includes("Scanning takes seconds.")).length;
    const localScanCount = warnings.filter((w) => w.includes("Local scan. Nothing leaves your machine.")).length;
    const readingHistoryCount = warnings.filter((w) => w.includes("Reading git history...")).length;

    expect(expectationCount).toBe(1);
    expect(localScanCount).toBe(1);
    // Submit's own rebuild always receives the already-selected, non-empty
    // `author` list (see continueIntoSubmit), so it never re-enters the
    // enumeration branch this line lives in at all — this assertion pins
    // that the fix doesn't accidentally suppress its ONE legitimate
    // appearance either.
    expect(readingHistoryCount).toBe(1);
  });
});
