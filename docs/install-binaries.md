# Standalone binaries

Every `redential` release also ships as a standalone executable — no Node.js
install required. This page explains what that actually is, how the install
scripts work, and how to verify what you downloaded. See
[issue #87](https://github.com/Redential/redential-cli/issues/87) for the
original design discussion.

## What a standalone binary actually is

`redential-<platform>-<arch>` is a real Node.js binary with this CLI's
entire code embedded inside it, using Node's own
[Single Executable Applications](https://nodejs.org/api/single-executable-applications.html)
(SEA) mechanism — the same official feature, not a third-party packager.

Concretely, [`scripts/build-sea.mjs`](../scripts/build-sea.mjs):

1. Bundles `src/cli.ts` and its entire dependency graph (`commander`,
   `typescript`, `undici`, and this repo's own source) into one CommonJS
   file with [esbuild](https://esbuild.github.io/).
2. Embeds `signatures/*.json` and `taxonomy.json` as SEA "assets" — the
   binary's skill detection reads the exact same closed-vocabulary data the
   npm package does, just from an embedded asset table instead of the
   filesystem (see `src/embedded-assets.ts` for the one place that branches
   on which source to read from). The privacy test suite (`test/privacy/`)
   only ever runs under `vitest`, never inside a real SEA binary, so it
   exercises the filesystem path exactly as it always has — it does not,
   and cannot, execute the SEA asset-read path. That path's own coverage is
   `scripts/smoke-sea.mjs`, run against the actual built binary in both
   `ci.yml`'s `binary-smoke` job and `release.yml`'s `binaries` job.
3. Injects that bundle into a copy of the platform's own `node` binary via
   [`postject`](https://github.com/nodejs/postject).

Nothing about **what data leaves your machine** changes: the binary runs
the identical `scan`/`submit`/`login`/etc. code paths as the npm package,
gated by the same zero-network invariant on `scan` and the same explicit
confirmation before any `submit` upload.

**Known trade-off, stated up front:** these binaries are tens of megabytes
(the bundle embeds the TypeScript compiler, which the structural detection
tier uses as a parser). That's an accepted, deliberate cost of "works with
zero Node install," not an oversight.

## Installing

```sh
curl -fsSL https://redential.com/install.sh | sh
```

```powershell
irm https://redential.com/install.ps1 | iex
```

`redential.com/install.sh` and `.../install.ps1` are redirects to the exact
versioned files in this repo —
[`scripts/install.sh`](../scripts/install.sh) and
[`scripts/install.ps1`](../scripts/install.ps1). Nothing about the
installers is opaque: read them before running them, they're short and
plain (POSIX `sh` / PowerShell, no dependencies beyond `curl`/
`Invoke-WebRequest` and `shasum`/`sha256sum`/`Get-FileHash`).

Each script:

1. Detects your OS and CPU architecture.
2. Downloads the matching binary from the **latest GitHub Release**
   (`https://github.com/Redential/redential-cli/releases/latest/download/...`).
3. Downloads `SHA256SUMS` from that same release and verifies the binary's
   checksum against it **before** installing anything.
4. Installs into a directory you own — `~/.local/bin` on macOS/Linux (or a
   writable `/usr/local/bin` as a fallback, never via `sudo`),
   `%LOCALAPPDATA%\redential\bin` on Windows — and tells you if it needs to
   be added to your `PATH`.

Neither script ever pipes a second remote script into a shell, and neither
ever requests elevated privileges.

## Manual install

If you'd rather not run a script at all, download directly from the
[Releases page](https://github.com/Redential/redential-cli/releases):

- `redential-macos-arm64` / `redential-macos-x64`
- `redential-linux-x64` / `redential-linux-arm64`
- `redential-win-x64.exe`
- `SHA256SUMS`

Verify the checksum yourself, then `chmod +x` (macOS/Linux) and move it
onto your `PATH`.

```sh
shasum -a 256 -c SHA256SUMS --ignore-missing
```

```powershell
(Get-FileHash redential-win-x64.exe -Algorithm SHA256).Hash
# compare against the matching line in SHA256SUMS
```

## Verifying build provenance

Every binary, like the npm tarball, is attested with
[`actions/attest-build-provenance`](https://github.com/actions/attest-build-provenance)
— a Sigstore-signed statement that it was built by
`.github/workflows/release.yml`, from this exact commit and tag, on
GitHub's own runners, not assembled or uploaded from anyone's laptop.
Verify it with the [GitHub CLI](https://cli.github.com/):

```sh
gh attestation verify redential-macos-arm64 --repo Redential/redential-cli
```

(Substitute the filename you downloaded.) See
[`docs/releasing.md`](releasing.md)'s "Verifying provenance" section for
the same idea applied to the npm package.

## How releases are built

A `binaries` job in `.github/workflows/release.yml` builds one binary per
platform (each on that platform's own GitHub-hosted runner — SEA embeds the
*host* Node binary, there's no cross-compilation), smoke-tests it (see
[`scripts/smoke-sea.mjs`](../scripts/smoke-sea.mjs) — `--version`, a
non-interactive `--json` scan of a throwaway git fixture asserting a
schema-valid bundle, and the input-closed error path), then a
`release-binaries` job aggregates every platform's output, generates
`SHA256SUMS`, attests provenance, and attaches everything to the tag's
GitHub Release. It only ever runs after `publish` (the npm release)
succeeds, and — like every job in `release.yml` — only ever triggers on a
pushed `v*` tag, never on `pull_request`.

A separate `binary-smoke` job in `.github/workflows/ci.yml` builds and
smoke-tests the binary on every push/PR that touches packaging-relevant
files (`scripts/build-sea.mjs`, `scripts/smoke-sea.mjs`, the installers, or
the workflows themselves) — or on demand via `workflow_dispatch` — so a
packaging regression is caught before a tag is ever pushed, not after.

## Out of scope (for now)

Docker image, Homebrew tap, and AUR/winget packages are tracked separately
(see issue #87) — AUR and winget are expected to be community
up-for-grabs once the binaries themselves are stable.
