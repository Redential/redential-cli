import { createRequire } from "node:module";

/**
 * Dual-path asset loader: the published npm package reads `signatures/`,
 * `taxonomy.json` and `package.json` straight off disk (unchanged, see
 * the individual DEFAULT_*_PATH constants in skill-detect.ts / program.ts /
 * version-check.ts). The Node SEA standalone binary (docs/install-binaries.md,
 * scripts/build-sea.mjs) has no on-disk package tree to read from at all —
 * those same files are embedded as SEA "assets" (see sea-config.json,
 * generated at build time) and fetched through `node:sea`'s `getAsset` API
 * instead.
 *
 * This module is the ONLY place that branches on "am I a SEA binary" — every
 * other file just calls `readEmbeddedText`, which is byte-identical to
 * `readFileSync(path, "utf8")` outside of a SEA binary. Keeping the branch in
 * one place is what makes the dual path auditable: a privacy reviewer only
 * has to read this file to know the SEA path can't reach anything the
 * filesystem path doesn't already read.
 */

// `node:sea` only exists on Node >= 20.12 (experimental) and is meaningless
// outside a binary built with `--experimental-sea-config`. Resolved lazily,
// once, via createRequire (this file is ESM in source and in the published
// dist/, but esbuild's CJS output for the SEA bundle also supports `require`
// natively — createRequire keeps a single code path for both).
const require = createRequire(import.meta.url);

let cachedIsSea: boolean | undefined;

/** True only inside a Node SEA binary built by scripts/build-sea.mjs. Every
 * other runtime shape (dev, `npm test`, the published npm package run via
 * `npx`/global install) returns false — this is never true in the published
 * npm artifact, only in the separately-built standalone executable. */
export function isSeaRuntime(): boolean {
  if (cachedIsSea !== undefined) return cachedIsSea;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sea = require("node:sea") as { isSea?: () => boolean };
    cachedIsSea = typeof sea.isSea === "function" && sea.isSea();
  } catch {
    // node:sea doesn't exist on this Node version, or this isn't a SEA
    // binary at all (require throws in both cases) — either way, fall back
    // to the normal filesystem path.
    cachedIsSea = false;
  }
  return cachedIsSea;
}

/** Reads one embedded SEA asset as UTF-8 text. Only ever called after
 * `isSeaRuntime()` is true, so `node:sea` is guaranteed to resolve here. */
export function readEmbeddedText(assetKey: string): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const sea = require("node:sea") as { getAsset: (key: string, encoding: string) => string };
  return sea.getAsset(assetKey, "utf8");
}

/**
 * Reads a text asset by key when running as a SEA binary, otherwise reads
 * the equivalent file straight off disk at `fsPath` — the exact same
 * `readFileSync(fsPath, "utf8")` call every caller made before the SEA path
 * existed. Callers pass their existing DEFAULT_*_PATH constant unchanged.
 */
export function readAssetOrFile(assetKey: string, fsPath: string, readFile: (path: string) => string): string {
  if (isSeaRuntime()) {
    return readEmbeddedText(assetKey);
  }
  return readFile(fsPath);
}

/**
 * `signatures/**\/*.json` is a directory tree, not a single file, so it
 * can't be embedded under one asset key — scripts/build-sea.mjs instead
 * walks the tree at build time and embeds two things: this manifest (the
 * list of relative paths, e.g. `["ml/foo.json", "security/bar.json"]`,
 * itself an asset keyed `signatures-manifest.json`) plus one asset per file,
 * keyed `signatures/<relative-path>`. Returns null outside a SEA binary —
 * callers fall back to the existing recursive filesystem walk.
 */
export function readEmbeddedSignatureManifest(): string[] | null {
  if (!isSeaRuntime()) return null;
  const raw = readEmbeddedText("signatures-manifest.json");
  return JSON.parse(raw) as string[];
}
