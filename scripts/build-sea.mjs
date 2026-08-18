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
// Usage: node scripts/build-sea.mjs
// Output: build/bin/redential-<platform>-<arch>[.exe]

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
import * as esbuild from "esbuild";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SEA_DIR = join(ROOT, "build", "sea");
const ASSETS_DIR = join(SEA_DIR, "assets");
const BIN_DIR = join(ROOT, "build", "bin");
const BUNDLE_PATH = join(SEA_DIR, "bundle.cjs");
const BLOB_PATH = join(SEA_DIR, "prep.blob");
const SEA_CONFIG_PATH = join(SEA_DIR, "sea-config.json");

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

function platformAssetName() {
  const platformMap = { darwin: "macos", linux: "linux", win32: "win" };
  const archMap = { arm64: "arm64", x64: "x64" };
  const platform = platformMap[process.platform];
  const arch = archMap[process.arch];
  if (!platform || !arch) {
    throw new Error(`Unsupported build host: ${process.platform}/${process.arch}`);
  }
  const ext = process.platform === "win32" ? ".exe" : "";
  return `redential-${platform}-${arch}${ext}`;
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

function buildBinary() {
  mkdirSync(BIN_DIR, { recursive: true });
  const outName = platformAssetName();
  const outPath = join(BIN_DIR, outName);

  run(process.execPath, ["--experimental-sea-config", relative(ROOT, SEA_CONFIG_PATH)]);

  copyFileSync(process.execPath, outPath);
  chmodSync(outPath, 0o755);

  if (process.platform === "darwin") {
    // A copied `node` binary carries the original binary's code signature,
    // which becomes invalid the moment postject rewrites its contents —
    // macOS refuses to run a binary whose signature doesn't match its
    // bytes. Removing it first, then re-signing ad-hoc (`-s -`, no identity)
    // after injection, is the exact sequence Node's own SEA docs describe
    // for macOS.
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
    ...(process.platform === "darwin" ? ["--macho-segment-name", "NODE_SEA"] : []),
  ]);

  if (process.platform === "darwin") {
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
  const assets = prepareAssets();
  await bundleCli();
  writeSeaConfig(assets);
  const binPath = buildBinary();
  log(`Done: ${binPath}`);
}

main().catch((err) => {
  process.stderr.write(`[build-sea] FAILED: ${err.message}\n`);
  process.exit(1);
});
