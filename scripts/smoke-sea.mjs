#!/usr/bin/env node
// Portable smoke test for a built SEA binary — shared between a local run
// (after `npm run build:sea`) and CI's `binary-smoke` job (.github/workflows/ci.yml),
// so both exercise the exact same checks. Spawns the binary directly (never
// through a shell/`.cmd` wrapper — the Windows npx lesson: `npx` shims on
// Windows are `.cmd` batch files, and spawning those without `shell: true`
// silently fails or behaves differently than spawning a real executable).
//
// Usage: node scripts/smoke-sea.mjs <path-to-binary>

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const binPath = process.argv[2];
if (!binPath) {
  process.stderr.write("Usage: node scripts/smoke-sea.mjs <path-to-binary>\n");
  process.exit(1);
}

function log(message) {
  process.stdout.write(`[smoke-sea] ${message}\n`);
}

function run(args, options = {}) {
  return execFileSync(binPath, args, { encoding: "utf8", ...options });
}

function fail(message) {
  process.stderr.write(`[smoke-sea] FAILED: ${message}\n`);
  process.exit(1);
}

// 1. --version prints the package version, nothing else, exit 0.
log("Checking --version...");
const versionOut = run(["--version"]).trim();
if (!/^\d+\.\d+\.\d+/.test(versionOut)) {
  fail(`--version did not print a semver string, got: ${JSON.stringify(versionOut)}`);
}
log(`--version -> ${versionOut}`);

// 2. Build a throwaway git fixture with a real dependency in the package
// map, so a successful `detected_skills` entry proves both taxonomy.json
// AND signatures/package-map.json made it into the binary correctly (not
// just that the binary runs at all).
const fixtureDir = mkdtempSync(join(tmpdir(), "redential-sea-smoke-"));
function git(args) {
  execFileSync("git", args, { cwd: fixtureDir, stdio: "ignore" });
}
git(["init", "-q"]);
git(["config", "user.email", "dev@example.com"]);
git(["config", "user.name", "Dev"]);
writeFileSync(join(fixtureDir, "package.json"), JSON.stringify({ name: "fixture" }));
git(["add", "package.json"]);
git(["commit", "-q", "-m", "init"]);
writeFileSync(
  join(fixtureDir, "package.json"),
  JSON.stringify({ name: "fixture", dependencies: { "@supabase/ssr": "^0.5.0" } })
);
git(["add", "package.json"]);
git(["commit", "-q", "-m", "add supabase ssr dep"]);

// 3. `scan --json` with stdin closed (`input: ""` — same effect as </dev/null,
// portably) must print a schema-valid bundle on stdout with detected_skills
// populated, and make zero network calls (nothing here provides a mock
// server or DNS at all, so any attempted network call would hang past a
// short-lived process or throw — the process running to completion at all
// is part of the zero-network evidence).
log("Running scan --json (stdin closed)...");
const scanOut = run(["scan", "--repo", fixtureDir, "--author", "dev@example.com", "--yes", "--json"], {
  input: "",
});
let bundle;
try {
  bundle = JSON.parse(scanOut);
} catch (err) {
  fail(`scan --json did not print valid JSON: ${err.message}\n${scanOut.slice(0, 500)}`);
}
if (typeof bundle.schema_version !== "string") {
  fail(`bundle missing schema_version: ${JSON.stringify(bundle).slice(0, 300)}`);
}
log(`scan --json -> schema_version ${bundle.schema_version}`);

const skills = bundle.detected_skills ?? [];
if (!skills.some((s) => s.slug === "auth/supabase-auth")) {
  fail(
    `expected detected_skills to include "auth/supabase-auth" (proves embedded taxonomy.json + ` +
      `signatures/package-map.json) — got: ${JSON.stringify(skills)}`
  );
}
log(`detected_skills includes auth/supabase-auth — embedded signatures/taxonomy confirmed.`);

// 4. EOF error path: scan without --author/--yes, stdin closed, must fail
// cleanly (exit 1, no raw stack trace) instead of hanging or crashing.
log("Checking the EOF error path (no --author/--yes, stdin closed)...");
let eofFailedAsExpected = false;
try {
  run(["scan", "--repo", fixtureDir, "--json"], { input: "" });
} catch (err) {
  const stderrText = String(err.stderr ?? "");
  if (err.status === 1 && /Input closed before authorization was confirmed/.test(stderrText)) {
    eofFailedAsExpected = true;
  } else {
    fail(`unexpected EOF-path failure shape: status=${err.status} stderr=${stderrText.slice(0, 300)}`);
  }
}
if (!eofFailedAsExpected) {
  fail("expected scan without --author/--yes and closed stdin to exit 1 with the EOF authorization error.");
}
log("EOF error path OK.");

log("All checks passed.");
