import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// node:http/https export non-configurable properties in this runtime, so
// vi.spyOn on the real module throws ("Cannot redefine property"). vi.mock
// replaces the module in the resolution graph instead of mutating it —
// vi.hoisted keeps the mock fns reachable both from the (hoisted) factory
// and from the test body below.
const mocks = vi.hoisted(() => ({
  httpRequest: vi.fn(),
  httpGet: vi.fn(),
  httpsRequest: vi.fn(),
  httpsGet: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("node:http", async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, request: mocks.httpRequest, get: mocks.httpGet };
});
vi.mock("node:https", async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, request: mocks.httpsRequest, get: mocks.httpsGet };
});
// global fetch isn't a module import, so it can't be vi.mock'd — stub it
// directly on globalThis for the duration of this suite instead.
const realFetch = globalThis.fetch;
globalThis.fetch = mocks.fetch as unknown as typeof fetch;

import { cleanup, commit, createRepo, setRemote } from "../support/fixtures.js";
import { runScan, listAuthors } from "../../src/scan.js";
import { isKnownPublicHost } from "../../src/public-remote.js";
import { getRemoteUrl } from "../../src/git.js";
import { executeExplainCommand } from "../../src/explain-command.js";
import { executeScanCommand } from "../../src/scan-command.js";
import { saveCredentials } from "../../src/credentials.js";
import { getSiteUrl } from "../../src/config.js";
import { readFileSync, readdirSync, statSync } from "node:fs";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) cleanup(dirs.pop()!);
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

function tempConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "redential-config-"));
  dirs.push(dir);
  return dir;
}

describe("zero network calls during scan", () => {
  it("never touches http/https across listAuthors, the guardrail check, and runScan", async () => {
    const dir = createRepo();
    dirs.push(dir);
    setRemote(dir, "https://github.com/acme/example.git");
    commit(dir, {
      message: "x",
      authorName: "You",
      authorEmail: "you@example.com",
      files: { "a.ts": "1\n" },
    });
    const configDir = tempConfigDir();

    isKnownPublicHost(getRemoteUrl(dir));
    await listAuthors(dir);
    await runScan({
      repoPath: dir,
      authors: ["you@example.com"],
      confirmed: true,
      toolVersion: "0.1.0",
      configDir,
    });

    expect(mocks.httpRequest).not.toHaveBeenCalled();
    expect(mocks.httpGet).not.toHaveBeenCalled();
    expect(mocks.httpsRequest).not.toHaveBeenCalled();
    expect(mocks.httpsGet).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  // H4 of the proof-graph spike (docs/proof-graph-spike.md): `explain` is
  // local-only, same posture as `scan` above — same technique (drive the
  // real command, assert none of the mocked network entry points fired),
  // alongside the scan test rather than folded into it. This fixture has no
  // structural pattern at all, so explain is expected to reject with its
  // "not detected" ScanError (test/explain-command.test.ts already covers
  // that message's content) — the point here is only that the whole
  // pipeline leading up to that rejection never touches the network.
  it("never touches http/https during `redential explain`, even on a repo with a public-looking remote", async () => {
    const dir = createRepo();
    dirs.push(dir);
    setRemote(dir, "https://github.com/acme/example.git");
    commit(dir, {
      message: "x",
      authorName: "You",
      authorEmail: "you@example.com",
      files: { "a.ts": "1\n" },
    });

    await executeExplainCommand({
      repoPath: dir,
      skill: "payments/payment-webhook-flow",
      author: ["you@example.com"],
      log: () => {},
    }).catch(() => {}); // expected ScanError ("not detected") — irrelevant to this test

    expect(mocks.httpRequest).not.toHaveBeenCalled();
    expect(mocks.httpGet).not.toHaveBeenCalled();
    expect(mocks.httpsRequest).not.toHaveBeenCalled();
    expect(mocks.httpsGet).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  // Reviewer follow-up (2026-08): `scan`'s post-scan "Add this to your
  // Redential profile?" hand-off (scan-command.ts's `maybeAddToProfile`)
  // dynamically imports submit-command.ts, a genuinely network-capable
  // module — the ONE deliberate exception to "scan never touches the
  // network" (see docs/scan.md's "Post-scan hand-off to submit" and
  // CLAUDE.md's zero-network INVIOLABLE bullet). These two paths are the
  // ones that must stay network-free even with that exception wired in:
  // declining the hand-off, and never being offered it at all (no stored
  // session). The "accept" path is deliberately NOT covered here — it's
  // supposed to reach the network via `submit`'s own already-tested flow
  // (test/submit.test.ts), so asserting zero network calls on that path
  // would be asserting the wrong thing.
  it("never touches http/https when the post-scan hand-off is declined (a stored session exists)", async () => {
    const dir = createRepo();
    dirs.push(dir);
    commit(dir, {
      message: "x",
      authorName: "You",
      authorEmail: "you@example.com",
      files: { "a.ts": "1\n" },
    });
    const configDir = tempConfigDir();
    saveCredentials({ access_token: "t", site_url: getSiteUrl(), obtained_at: "now" }, configDir);

    let promptCalled = false;
    await executeScanCommand({
      repoPath: dir,
      author: ["you@example.com"],
      yes: true,
      toolVersion: "0.1.0",
      configDir,
      log: () => {},
      warn: () => {},
      isTTY: true,
      promptAddToProfileFn: async () => {
        promptCalled = true;
        return false; // decline — the hand-off must never fire
      },
    });

    expect(promptCalled).toBe(true);
    expect(mocks.httpRequest).not.toHaveBeenCalled();
    expect(mocks.httpGet).not.toHaveBeenCalled();
    expect(mocks.httpsRequest).not.toHaveBeenCalled();
    expect(mocks.httpsGet).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("never touches http/https, and never offers the hand-off at all, when there's no stored session", async () => {
    const dir = createRepo();
    dirs.push(dir);
    commit(dir, {
      message: "x",
      authorName: "You",
      authorEmail: "you@example.com",
      files: { "a.ts": "1\n" },
    });
    const configDir = tempConfigDir(); // no saveCredentials — no session

    let promptCalled = false;
    await executeScanCommand({
      repoPath: dir,
      author: ["you@example.com"],
      yes: true,
      toolVersion: "0.1.0",
      configDir,
      log: () => {},
      warn: () => {},
      isTTY: true,
      promptAddToProfileFn: async () => {
        promptCalled = true;
        return true;
      },
    });

    // No session -> the plain reminder fires instead, never the live
    // prompt (see scan-command.ts) — asserted here as the reason the
    // network stays untouched, not just an incidental side effect.
    expect(promptCalled).toBe(false);
    expect(mocks.httpRequest).not.toHaveBeenCalled();
    expect(mocks.httpGet).not.toHaveBeenCalled();
    expect(mocks.httpsRequest).not.toHaveBeenCalled();
    expect(mocks.httpsGet).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  // Only login.ts and submit.ts are allowed to reach the network (principle
  // 1: "the only network calls are login (device flow) and submit"), and
  // only through http-client.ts's fetch wrapper. Every other file in src/ —
  // including scan's whole dependency graph — must stay clean, and stays an
  // allowlist (not an enumeration of scan's files) so a new file added to
  // src/ is network-free by default unless explicitly opted in here.
  const NETWORK_ALLOWED_FILES = new Set(["http-client.ts", "login.ts", "submit.ts"]);

  /**
   * Recursively lists every `.ts` file under `dir` (relative to `srcUrl`,
   * forward-slash-joined so subdirectory entries compare the same way flat
   * top-level entries always have). Recursive rather than the flat
   * `readdirSync` this test used before H5 of the proof-graph spike (see
   * docs/proof-graph-spike.md) so a subdirectory like `src/proof-graph/`
   * can't silently escape this static network-API check the way it did
   * previously — the dynamic zero-network tests above already exercise the
   * proof-graph pipeline end to end, but the static source-scan is supposed
   * to be the mechanical, can't-forget-to-run backstop, and a non-recursive
   * `readdirSync` wasn't actually backstopping subdirectories at all.
   */
  function listSrcTsFiles(srcUrl: URL, sub = ""): string[] {
    const abs = sub ? new URL(sub, srcUrl) : srcUrl;
    const out: string[] = [];
    for (const entry of readdirSync(abs)) {
      const rel = sub ? `${sub}${entry}` : entry;
      if (statSync(new URL(rel, srcUrl)).isDirectory()) {
        out.push(...listSrcTsFiles(srcUrl, `${rel}/`));
      } else if (entry.endsWith(".ts")) {
        out.push(rel);
      }
    }
    return out;
  }

  it("has no reference to fetch/http/https network APIs outside the allowlisted files", () => {
    const srcUrl = new URL("../../src/", import.meta.url);
    const files = listSrcTsFiles(srcUrl).filter((f) => !NETWORK_ALLOWED_FILES.has(f));
    const networkPattern = /\bfetch\(|node:https?['"]|require\(['"]https?['"]\)/;
    for (const file of files) {
      const contents = readFileSync(new URL(file, srcUrl), "utf8");
      expect(contents, `${file} should not reference a network API`).not.toMatch(networkPattern);
    }
  });

  // version-check.ts's checkForUpdate (the post-success "a newer version
  // exists" notice — see docs/login-submit.md's "Version check" section)
  // deliberately never references fetch/http/https directly: it goes
  // through http-client.ts's getJson, so the static check immediately
  // above this one — matching only direct network-API references — can't
  // catch it being wired into scan's call graph. This test encodes the
  // actual rule directly: version-check.ts may only ever be imported by
  // login.ts/submit-command.ts, the two commands that already touch the
  // network. If it's ever imported from scan.ts, scan-command.ts,
  // build-bundle.ts, or anywhere else in scan's dependency graph, this
  // fails — regardless of whether that import happens to reference fetch
  // literally.
  const VERSION_CHECK_ALLOWED_FILES = new Set(["login.ts", "submit-command.ts"]);

  it("version-check.ts (the post-success update notice) is only ever imported by login.ts/submit-command.ts — never scan's call graph", () => {
    const srcUrl = new URL("../../src/", import.meta.url);
    const files = readdirSync(srcUrl).filter(
      (f) => f.endsWith(".ts") && f !== "version-check.ts" && !VERSION_CHECK_ALLOWED_FILES.has(f)
    );
    const importPattern = /version-check(\.js)?['"]/;
    for (const file of files) {
      const contents = readFileSync(new URL(file, srcUrl), "utf8");
      expect(contents, `${file} should not import version-check.ts`).not.toMatch(importPattern);
    }
  });

  // Reviewer follow-up (2026-08): the two static checks above only catch a
  // network-API literal or a `version-check` import string — neither would
  // catch a future STATIC value-import of submit.ts/submit-command.ts/
  // http-client.ts into scan's own dependency graph (e.g. scan-command.ts
  // starting to `import { postBundle } from "./submit.js"` at the top of
  // the file). That would pass every check above (no `fetch(`/`http`
  // literal of its own, no `version-check` string) while still smuggling
  // network-capable code into a module `scan`'s always-run path pulls in
  // unconditionally. This test closes that gap directly, matching the
  // recursive-scan style of "has no reference to fetch/http/https..."
  // above rather than the flat `readdirSync` the version-check test still
  // uses (that one predates the H5 proof-graph-spike recursion fix and is
  // deliberately left alone here — not in scope for this change).
  //
  // `import type { ... } from "..."` is explicitly allowed (erased at
  // compile time, never reaches the runtime module graph — scan-command.ts
  // itself does exactly this for `SubmitCommandOptions`, to type the
  // dynamic hand-off below without pulling in a real value import). So is
  // the dynamic `await import("./submit-command.js")` form
  // (scan-command.ts's `maybeAddToProfile`) — a dynamic import is a
  // deliberately DIFFERENT construct from a static one: it only ever
  // executes at runtime, behind that function's own explicit-consent gate,
  // never merely by virtue of the importing module being loaded. Neither
  // form has a `from` clause the regex below looks for, so both are
  // structurally unmatchable by construction, not by a special-cased
  // exclusion that could bit-rot.
  const SCAN_TO_SUBMIT_TARGETS = ["submit-command", "submit", "http-client"];
  // Files allowed to statically value-import one of the targets above —
  // the network-capable modules themselves (chaining into each other:
  // submit-command.ts -> submit.ts -> http-client.ts), the two commands
  // that already touch the network directly (login.ts, submit-command.ts
  // via program.ts's wiring), and version-check.ts (covered by its own
  // dedicated test above; also needs to import http-client.ts for real).
  const SCAN_TO_SUBMIT_ALLOWED_IMPORTERS = new Set([
    "program.ts",
    "login.ts",
    "submit.ts",
    "submit-command.ts",
    "version-check.ts",
  ]);

  /**
   * True if `contents` contains a STATIC, value-producing `import ... from`
   * statement naming one of `targets` as its module specifier (a relative
   * `./<target>` or `./<target>.js` path) — never a pure `import type`
   * statement (matched and deliberately excluded) and never a dynamic
   * `import(...)` call.
   *
   * Two-step, not one regex: first split the file into individual `import
   * ...;` statements (`import\s[\s\S]*?;`, non-greedy so each match stops
   * at ITS OWN terminating semicolon rather than spanning past it into a
   * later, unrelated import — the bug in an earlier version of this helper,
   * which let a single `[\s\S]*?` between `import` and `from` backtrack
   * across several intervening statements to find a match, misattributing a
   * later legitimate `from "./submit-command.js"` to an earlier, unrelated
   * `import` keyword). Then, only within each already-bounded statement,
   * check for the target module and the `type ` prefix.
   *
   * `import\s` (a literal space required right after the keyword) is also
   * what excludes a dynamic call: `await import("./submit-command.js")` has
   * no space between `import` and `(`, so it never starts a match here at
   * all — structurally unmatchable, not a special-cased exclusion.
   */
  function hasStaticValueImportOf(contents: string, targets: string[]): boolean {
    const specifierGroup = targets.join("|");
    const targetPattern = new RegExp(`from\\s+["']\\./(?:${specifierGroup})(?:\\.js)?["']`);
    for (const stmt of contents.matchAll(/import\s[\s\S]*?;/g)) {
      const statement = stmt[0];
      if (!targetPattern.test(statement)) continue;
      const clause = statement.replace(/^import\s+/, "").trim();
      if (!clause.startsWith("type ")) return true; // a real value import
    }
    return false;
  }

  it("no file outside the network allowlist statically value-imports submit-command.ts, submit.ts, or http-client.ts", () => {
    const srcUrl = new URL("../../src/", import.meta.url);
    const files = listSrcTsFiles(srcUrl).filter((f) => !SCAN_TO_SUBMIT_ALLOWED_IMPORTERS.has(f));
    for (const file of files) {
      const contents = readFileSync(new URL(file, srcUrl), "utf8");
      expect(
        hasStaticValueImportOf(contents, SCAN_TO_SUBMIT_TARGETS),
        `${file} should not statically value-import submit-command.ts/submit.ts/http-client.ts ` +
          `(a \`import type\` or a dynamic \`await import(...)\` is fine)`
      ).toBe(false);
    }
  });

  it("sanity check: scan-command.ts's own type-only import and dynamic import are correctly recognized as allowed by the helper above", () => {
    const srcUrl = new URL("../../src/", import.meta.url);
    const contents = readFileSync(new URL("scan-command.ts", srcUrl), "utf8");
    // Both forms are present in the real file (not hypothetical) — this
    // pins the helper's behavior against the actual source, not a
    // synthetic fixture that could drift from it.
    expect(contents).toContain('import type { SubmitCommandOptions } from "./submit-command.js"');
    expect(contents).toContain('await import("./submit-command.js")');
    expect(hasStaticValueImportOf(contents, SCAN_TO_SUBMIT_TARGETS)).toBe(false);
  });
});
