#!/usr/bin/env node
// Builds a standalone, single-file executable for the current platform using
// Node's official Single Executable Applications (SEA) mechanism, per
// https://nodejs.org/api/single-executable-applications.html and issue #87
// (docs/install-binaries.md has the full story for end users).
//
// Two devDependencies power this script, both dev-only (never shipped to
// users, never listed in package.json's "files"):
//   - esbuild: bundles src/cli.ts (plus its whole dependency graph, including
//     the `typescript` runtime dependency the structural detection tier
//     uses as a parser) into one CommonJS file. This is the standard JS
//     bundler, maintained by the esbuild org. HONEST NOTE (not "no install
//     scripts" — that would be false): esbuild DOES ship a postinstall
//     script, its well-known platform-binary selector (it resolves the
//     right `@esbuild/<platform>-<arch>` optionalDependency and copies its
//     binary into place — no network fetch when the platform optionalDependency
//     is present (the lockfile guarantees it), no arbitrary code from outside
//     the esbuild release itself). This is not new exposure this change
//     introduces: `package-lock.json` already carried esbuild@0.21.5 with
//     `hasInstallScript: true` transitively (vitest -> vite -> esbuild)
//     before this change, and that postinstall already ran on every
//     `npm ci` in this repo. CLAUDE.md's "ZERO postinstall scripts" rule is
//     about scripts this repo's OWN `package.json` defines, not about every
//     dev-only transitive dependency's install step — pinning esbuild
//     directly as a devDependency doesn't add a new postinstall that wasn't
//     already running.
//   - postject: the tool Node's own SEA docs point to for injecting the
//     bundled blob into a copy of the `node` binary. Maintained by the
//     Node.js build working group, no install scripts, exact pin. Invoked
//     below via its local `node_modules/postject/dist/cli.js` entry point
//     (never `npx`): `npx` resolves to a `.cmd` shim on Windows that
//     `execFileSync` can't spawn directly (ENOENT — the same lesson CI's
//     binary-smoke job's own comment already documents), and `npx` would
//     also re-resolve the package from the registry at build time instead
//     of using the exact, lockfile-pinned, already-installed copy.
// No runtime dependency changes: the built binary embeds `commander`,
// `typescript` and `undici` (already runtime deps) — nothing new ships to
// users of the npm package, which is unaffected by this script.
//
// Usage: node scripts/build-sea.mjs [--target <platform>-<arch>]
// Output: build/bin/redential-<platform>-<arch>[.exe]
//
// By default this builds for the HOST platform/arch (process.platform /
// process.arch), exactly as before --target existed: the SEA blob is
// injected into a copy of the currently-running `node` binary.
//
// --target lets a foreign platform/arch be requested instead (e.g.
// `--target darwin-x64` from an arm64 host — see docs/releasing.md's note
// on macos-13 runner retirement). This is a CROSS-TARGET build, not cross
// COMPILATION: the SEA blob (bundled JS + embedded assets) is
// platform-independent, so the only platform-specific piece is which
// `node` binary the blob gets injected into. For a foreign target, that
// binary is downloaded from nodejs.org's official dist server, for the
// exact Node version this script is running under (process.version), and
// verified against that same release's official SHASUMS256.txt before
// ANY use — this is a trust product, an unverified binary never touches
// disk as anything other than a `.part` download. The REDENTIAL_SEA_TARGET
// env var is an alternative to --target (CLI flag wins if both are set).
//
// Only darwin-x64 cross-target is implemented/tested today (the concrete
// need: building the Intel mac binary on an Apple Silicon runner). The
// download/verify/extract mechanism itself is written to be general
// (any POSIX target using nodejs.org's .tar.gz layout), but a Windows
// (.zip) foreign target deliberately throws a descriptive not-implemented
// error below rather than pretending to support an untested path.

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  rmSync,
  copyFileSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  chmodSync,
} from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import * as esbuild from "esbuild";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SEA_DIR = join(ROOT, "build", "sea");
const ASSETS_DIR = join(SEA_DIR, "assets");
const BIN_DIR = join(ROOT, "build", "bin");
const CACHE_DIR = join(ROOT, "build", "cache");
const BUNDLE_PATH = join(SEA_DIR, "bundle.cjs");
const BLOB_PATH = join(SEA_DIR, "prep.blob");
const SEA_CONFIG_PATH = join(SEA_DIR, "sea-config.json");

// process.platform/process.arch values (NOT nodejs.org dist naming — that
// translation happens in nodeDistPlatformName below) this script knows how
// to target. Keys mirror platformAssetName's platformMap/archMap.
const KNOWN_PLATFORMS = new Set(["darwin", "linux", "win32"]);
const KNOWN_ARCHES = new Set(["arm64", "x64"]);

// Matches skill-detect.ts's PACKAGE_MAP_FILENAME exclusion exactly: every
// signatures/**/*.json file is a manifest entry EXCEPT any file literally
// named package-map.json (still embedded as its own asset, just not listed
// in the manifest loadSignatures() walks — see src/embedded-assets.ts).
const PACKAGE_MAP_FILENAME = "package-map.json";

function log(message) {
  process.stdout.write(`[build-sea] ${message}\n`);
}

function run(command, args, options = {}) {
  log(`${command} ${args.join(" ")}`);
  return execFileSync(command, args, { stdio: "inherit", cwd: ROOT, ...options });
}

function platformAssetName(target) {
  const platformMap = { darwin: "macos", linux: "linux", win32: "win" };
  const archMap = { arm64: "arm64", x64: "x64" };
  const platform = platformMap[target.platform];
  const arch = archMap[target.arch];
  if (!platform || !arch) {
    throw new Error(`Unsupported target: ${target.platform}/${target.arch}`);
  }
  const ext = target.platform === "win32" ? ".exe" : "";
  return `redential-${platform}-${arch}${ext}`;
}

/**
 * Parses `--target <platform>-<arch>` from argv (CLI flag wins) or the
 * REDENTIAL_SEA_TARGET env var, defaulting to the host. `<platform>` uses
 * process.platform values (darwin/linux/win32), NOT nodejs.org's dist
 * naming — the win32 -> "win" translation for download URLs lives in
 * nodeDistPlatformName, kept separate on purpose so this function's output
 * matches process.platform/process.arch everywhere else in this script.
 */
function resolveTarget(argv) {
  let raw;
  const flagIndex = argv.indexOf("--target");
  if (flagIndex !== -1 && argv[flagIndex + 1]) {
    raw = argv[flagIndex + 1];
  } else {
    const inline = argv.find((a) => a.startsWith("--target="));
    if (inline) raw = inline.slice("--target=".length);
  }
  if (!raw) raw = process.env.REDENTIAL_SEA_TARGET;

  if (!raw) {
    return { platform: process.platform, arch: process.arch, isHost: true };
  }

  const dashIndex = raw.lastIndexOf("-");
  if (dashIndex === -1) {
    throw new Error(`Invalid --target "${raw}" — expected "<platform>-<arch>", e.g. "darwin-x64".`);
  }
  const platform = raw.slice(0, dashIndex);
  const arch = raw.slice(dashIndex + 1);
  if (!KNOWN_PLATFORMS.has(platform) || !KNOWN_ARCHES.has(arch)) {
    throw new Error(
      `Invalid --target "${raw}" — platform must be one of ${[...KNOWN_PLATFORMS].join("/")}, ` +
        `arch one of ${[...KNOWN_ARCHES].join("/")}.`
    );
  }
  const isHost = platform === process.platform && arch === process.arch;
  return { platform, arch, isHost };
}

// nodejs.org dist naming for the download URL only (e.g. "node-v20.11.0-darwin-x64.tar.gz").
// win32 -> "win" is the one place dist naming diverges from process.platform.
function nodeDistPlatformName(platform) {
  return platform === "win32" ? "win" : platform;
}

function nodeDistArchiveExt(platform) {
  return platform === "win32" ? "zip" : "tar.gz";
}

/**
 * Downloads a URL to memory via the global `fetch` (Node >= 18, no extra
 * dependency). Used for both the SHASUMS256.txt text file and the node
 * tarball itself.
 */
async function fetchBuffer(url) {
  log(`Fetching ${url} ...`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${res.status} ${res.statusText}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Downloads (or reuses a cached copy of) the official Node tarball for
 * `version`/`target`, verifies its sha256 against the SAME release's
 * official SHASUMS256.txt, and returns the path to the verified tarball on
 * disk. The SHASUMS256.txt itself is fetched fresh every run (it's tiny)
 * so a stale/tampered cached tarball is still caught: verification never
 * trusts anything already on disk without recomputing the hash against a
 * freshly-fetched expected value.
 *
 * This is the mandatory trust boundary for a cross-target build — an
 * unverified binary is never injected into, or shipped as, a release
 * artifact.
 */
async function downloadAndVerifyNodeTarball(version, target) {
  const distPlatform = nodeDistPlatformName(target.platform);
  const ext = nodeDistArchiveExt(target.platform);
  const tarballName = `node-v${version}-${distPlatform}-${target.arch}.${ext}`;
  const distBase = `https://nodejs.org/dist/v${version}`;
  const tarballUrl = `${distBase}/${tarballName}`;
  const shasumsUrl = `${distBase}/SHASUMS256.txt`;

  mkdirSync(CACHE_DIR, { recursive: true });
  const cachedPath = join(CACHE_DIR, tarballName);

  const shasumsText = (await fetchBuffer(shasumsUrl)).toString("utf8");
  const shasumsLine = shasumsText
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.endsWith(tarballName));
  if (!shasumsLine) {
    throw new Error(`SHASUMS256.txt for v${version} has no entry for "${tarballName}".`);
  }
  const expectedSha256 = shasumsLine.split(/\s+/)[0].toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expectedSha256)) {
    throw new Error(`Could not parse a sha256 hash out of SHASUMS256.txt line: "${shasumsLine}"`);
  }

  let tarballBuffer;
  if (existsSync(cachedPath)) {
    log(`Using cached ${relative(ROOT, cachedPath)} (verifying before trusting it).`);
    tarballBuffer = readFileSync(cachedPath);
  } else {
    tarballBuffer = await fetchBuffer(tarballUrl);
  }

  const actualSha256 = createHash("sha256").update(tarballBuffer).digest("hex");
  if (actualSha256 !== expectedSha256) {
    // Never leave a rejected download sitting where a later run's
    // existsSync() cache check would find it and skip re-verifying nothing
    // new — remove it so the next run downloads fresh.
    rmSync(cachedPath, { force: true });
    throw new Error(
      `SHA256 mismatch for ${tarballName}: expected ${expectedSha256}, got ${actualSha256}. ` +
        `Refusing to use this download — this is a trust-product build step.`
    );
  }
  log(`Verified sha256 for ${tarballName} matches official SHASUMS256.txt.`);

  if (!existsSync(cachedPath)) {
    writeFileSync(cachedPath, tarballBuffer);
    log(`Cached ${relative(ROOT, cachedPath)} for future reruns.`);
  }

  return cachedPath;
}

/**
 * Extracts just the `node` binary out of a verified tarball for a foreign
 * POSIX target, into build/cache/, and returns its path. Shells out to the
 * `tar` CLI (present on every macOS/Linux GitHub-hosted runner and on this
 * repo's own dev machines) rather than adding a tar-parsing dependency for
 * a build-only, dev-only script.
 *
 * ALWAYS re-extracts from the tarball that downloadAndVerifyNodeTarball
 * just sha256-verified — there is deliberately no "reuse the previously
 * extracted binary if it already exists on disk" shortcut. An extracted
 * Mach-O sitting in build/cache/ is NOT itself hash-checked on every run
 * (only the tarball is, against SHASUMS256.txt), so trusting a cached
 * extracted binary would silently skip verification for anything that
 * modified it after extraction — the exact trust hole this comment used
 * to describe as closed while the code actually reused an unverified
 * cached file. `tar -xzf ... -O` extracting one file is on the order of a
 * second even for the ~50 MB node tarball, so paying it on every
 * cross-target run is cheap; the *tarball* cache (which IS re-verified
 * every run) is what actually saves the expensive part, the network
 * download.
 */
function extractNodeBinary(tarballPath, version, target) {
  const distPlatform = nodeDistPlatformName(target.platform);
  const entryDir = `node-v${version}-${distPlatform}-${target.arch}`;
  const extractedPath = join(CACHE_DIR, `${entryDir}-node-bin`);
  // `-O` streams the single requested archive member to stdout instead of
  // extracting the whole tree — we only need the `node` binary, not npm/
  // docs/headers that ship alongside it in the tarball.
  const nodeBinBuffer = execFileSync("tar", ["-xzf", tarballPath, "-O", `${entryDir}/bin/node`], {
    cwd: ROOT,
    maxBuffer: 1024 * 1024 * 1024,
  });
  writeFileSync(extractedPath, nodeBinBuffer);
  chmodSync(extractedPath, 0o755);
  return extractedPath;
}

/**
 * Resolves the path to the `node` binary that the SEA blob will be
 * injected into: the currently-running binary for a host build, or a
 * freshly downloaded-and-verified official binary for a foreign target.
 */
async function resolveNodeBinaryPath(target) {
  if (target.isHost) {
    return process.execPath;
  }
  if (target.platform === "win32") {
    throw new Error(
      "Cross-target builds for win32 (.zip dist archives) are not implemented/tested yet — " +
        "only POSIX (.tar.gz) foreign targets are supported today. See scripts/build-sea.mjs's top comment."
    );
  }
  const version = process.version.startsWith("v") ? process.version.slice(1) : process.version;
  log(`Cross-target build: host is ${process.platform}/${process.arch}, target is ${target.platform}/${target.arch}.`);
  const tarballPath = await downloadAndVerifyNodeTarball(version, target);
  const nodeBinPath = extractNodeBinary(tarballPath, version, target);
  log(`Using downloaded+verified node binary: ${relative(ROOT, nodeBinPath)}`);
  return nodeBinPath;
}

function listJsonFilesRecursive(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listJsonFilesRecursive(full));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Copies signatures/*.json + taxonomy.json + package.json into
 * build/sea/assets/ (SEA assets are declared by on-disk path in
 * sea-config.json) and writes a manifest of the signatures files so the
 * embedded loader (src/embedded-assets.ts + src/skill-detect.ts) can list
 * them without a directory read, which doesn't exist inside a SEA binary.
 * Returns the sea-config.json "assets" map (asset key -> path on disk).
 */
function prepareAssets() {
  rmSync(ASSETS_DIR, { recursive: true, force: true });
  mkdirSync(join(ASSETS_DIR, "signatures"), { recursive: true });

  const signaturesRoot = join(ROOT, "signatures");
  const signatureFiles = listJsonFilesRecursive(signaturesRoot);
  const manifest = [];
  const assets = {};

  for (const file of signatureFiles) {
    const relPath = relative(signaturesRoot, file).split(sep).join("/");
    const destPath = join(ASSETS_DIR, "signatures", ...relPath.split("/"));
    mkdirSync(dirname(destPath), { recursive: true });
    copyFileSync(file, destPath);
    assets[`signatures/${relPath}`] = destPath;
    // Mirrors listJsonFilesRecursive's own package-map.json exclusion in
    // src/skill-detect.ts — it's embedded above as an asset (loadPackageMap
    // reads it directly by key) but never listed as a Tier-2 signature.
    const basename = relPath.split("/").pop();
    if (basename !== PACKAGE_MAP_FILENAME) {
      manifest.push(relPath);
    }
  }

  const manifestPath = join(ASSETS_DIR, "signatures-manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest.sort()));
  assets["signatures-manifest.json"] = manifestPath;

  const taxonomyDest = join(ASSETS_DIR, "taxonomy.json");
  copyFileSync(join(ROOT, "taxonomy.json"), taxonomyDest);
  assets["taxonomy.json"] = taxonomyDest;

  const packageJsonDest = join(ASSETS_DIR, "package.json");
  copyFileSync(join(ROOT, "package.json"), packageJsonDest);
  assets["package.json"] = packageJsonDest;

  log(`Embedded ${signatureFiles.length} signature file(s) + taxonomy.json + package.json.`);
  return assets;
}

async function bundleCli() {
  mkdirSync(SEA_DIR, { recursive: true });
  // format=cjs is required by Node SEA (the bundle becomes the `main` field
  // of sea-config.json, loaded as a CommonJS entry point). platform=node +
  // no `external` means the WHOLE dependency graph (commander, typescript,
  // undici, and this repo's own src/**) is inlined into one file — the
  // published npm package is unaffected; this bundle is build-only output
  // (build/ is gitignored, never in package.json's "files").
  //
  // import.meta.url: several src/ files (program.ts, skill-detect.ts,
  // summary.ts, explain-command.ts, version-check.ts, embedded-assets.ts)
  // use `new URL(..., import.meta.url)` / `createRequire(import.meta.url)`
  // for filesystem-relative paths (dual-pathed onto SEA assets where it
  // matters — see src/embedded-assets.ts). esbuild's CJS output format does
  // NOT auto-shim `import.meta.url` (verified against this exact pinned
  // version: it silently empties the expression and only warns) — the
  // `banner`/`define` pair below replaces every `import.meta.url` occurrence
  // with a real `file://` URL computed from CJS's own `__filename`, which
  // IS available in `format: "cjs"` output. This is the same shim Node's own
  // ecosystem tooling uses for this exact esbuild limitation.
  //
  // The dynamic `import("./program.js")` (cli.ts) and `import("./submit-command.js")`
  // (scan-command.ts) are both static string literals, which esbuild
  // bundles as ordinary inlined modules (wrapped in `Promise.resolve().then(() => require(...))`
  // in CJS output) — no filesystem resolution happens at runtime.
  const importMetaUrlShimName = "__redentialSeaImportMetaUrl";
  const result = await esbuild.build({
    entryPoints: [join(ROOT, "src", "cli.ts")],
    outfile: BUNDLE_PATH,
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node20",
    external: [],
    metafile: true,
    banner: {
      js: `const ${importMetaUrlShimName} = require("url").pathToFileURL(__filename).href;`,
    },
    define: {
      "import.meta.url": importMetaUrlShimName,
    },
  });

  const bundleSource = readFileSync(BUNDLE_PATH, "utf8");
  if (!bundleSource.includes(importMetaUrlShimName)) {
    throw new Error(
      "import.meta.url shim not found in the built bundle — the banner/define pair may have stopped working " +
        "with this esbuild version; re-verify before shipping."
    );
  }
  const sizeMb = (Buffer.byteLength(bundleSource) / (1024 * 1024)).toFixed(1);
  log(`Bundled src/cli.ts -> ${relative(ROOT, BUNDLE_PATH)} (${sizeMb} MB source).`);
  return result;
}

function writeSeaConfig(assets) {
  const config = {
    main: relative(ROOT, BUNDLE_PATH),
    output: relative(ROOT, BLOB_PATH),
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
    assets: Object.fromEntries(
      Object.entries(assets).map(([key, path]) => [key, relative(ROOT, path)])
    ),
  };
  writeFileSync(SEA_CONFIG_PATH, JSON.stringify(config, null, 2));
  log(`Wrote ${relative(ROOT, SEA_CONFIG_PATH)} (${Object.keys(assets).length} embedded assets).`);
}

function buildBinary(target, nodeBinaryPath) {
  mkdirSync(BIN_DIR, { recursive: true });
  const outName = platformAssetName(target);
  const outPath = join(BIN_DIR, outName);

  // Blob generation (--experimental-sea-config) always runs on the HOST
  // node, never the target one: it's Node's own JS-level SEA tooling
  // producing a platform-independent blob (bundled JS + assets), not
  // something that needs to execute on/for the target arch. Only the copy
  // below (which `node` binary the blob gets injected into) is
  // target-specific.
  run(process.execPath, ["--experimental-sea-config", relative(ROOT, SEA_CONFIG_PATH)]);

  copyFileSync(nodeBinaryPath, outPath);
  chmodSync(outPath, 0o755);

  if (target.platform === "darwin") {
    // A copied `node` binary carries the original binary's code signature,
    // which becomes invalid the moment postject rewrites its contents —
    // macOS refuses to run a binary whose signature doesn't match its
    // bytes. Removing it first, then re-signing ad-hoc (`-s -`, no identity)
    // after injection, is the exact sequence Node's own SEA docs describe
    // for macOS. This holds for a cross-target x64 binary built on an
    // arm64 host exactly as it does for a native build: ad-hoc codesign
    // doesn't care which arch the binary it's signing is for, only that
    // the tool itself runs on this (Darwin) host.
    run("codesign", ["--remove-signature", outPath]);
  }

  // postject's sentinel fuse string is fixed by Node's SEA mechanism itself
  // (the runtime looks for this exact byte sequence to know it's a SEA
  // binary) — not a secret, not configurable.
  //
  // Invoked as `node <local postject cli.js>`, NOT `npx postject`: `npx` on
  // Windows resolves to a `.cmd` shim that `execFileSync` can't spawn
  // directly without `shell: true` (ENOENT — the same lesson
  // ci.yml's binary-smoke job already documents), and `npx` would also
  // re-resolve the package from the registry at build time — bypassing the
  // lockfile's pinned, integrity-checked, already-`npm ci`-installed copy
  // for an unverified one fetched fresh at build time. Running the local
  // install's own bin script directly avoids both problems.
  const postjectCliPath = join(ROOT, "node_modules", "postject", "dist", "cli.js");
  if (!existsSync(postjectCliPath)) {
    throw new Error(`postject not found at ${postjectCliPath} — run "npm ci" first.`);
  }
  run(process.execPath, [
    postjectCliPath,
    outPath,
    "NODE_SEA_BLOB",
    relative(ROOT, BLOB_PATH),
    "--sentinel-fuse",
    "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
    ...(target.platform === "darwin" ? ["--macho-segment-name", "NODE_SEA"] : []),
  ]);

  if (target.platform === "darwin") {
    run("codesign", ["--sign", "-", outPath]);
  }

  const stat = statSize(outPath);
  log(`Built ${relative(ROOT, outPath)} (${(stat / (1024 * 1024)).toFixed(1)} MB).`);
  return outPath;
}

function statSize(path) {
  return readFileSync(path).length;
}

async function main() {
  if (!existsSync(join(ROOT, "signatures"))) {
    throw new Error("signatures/ directory not found — run this script from the repo root.");
  }
  const target = resolveTarget(process.argv.slice(2));
  if (target.isHost) {
    log(`Building for host: ${target.platform}/${target.arch}.`);
  } else {
    log(`Building for foreign target: ${target.platform}/${target.arch} (host is ${process.platform}/${process.arch}).`);
  }
  const nodeBinaryPath = await resolveNodeBinaryPath(target);
  const assets = prepareAssets();
  await bundleCli();
  writeSeaConfig(assets);
  const binPath = buildBinary(target, nodeBinaryPath);
  log(`Done: ${binPath}`);
}

main().catch((err) => {
  process.stderr.write(`[build-sea] FAILED: ${err.message}\n`);
  process.exit(1);
});
