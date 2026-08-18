# Releasing

`@redential/cli` publishes to npm exclusively through
[`.github/workflows/release.yml`](../.github/workflows/release.yml),
triggered by pushing a `v*` tag. There is no manual `npm publish` path in
normal operation — `prepublishOnly` (below) exists as a last-line guard for
the rare case someone runs it by hand anyway, not as the intended flow.

## How a release works

1. **Bump the version and update the changelog.** Edit `package.json`'s
   `version` and move `CHANGELOG.md`'s `[Unreleased]` section under a new
   `## [x.y.z] - YYYY-MM-DD` heading (Keep a Changelog format — see
   `CHANGELOG.md`'s own header for the versioning rule: bundle schema
   changes always bump at least minor, breaking schema changes bump
   major). Commit this on `main` through the normal PR flow.
2. **Tag the commit and push the tag:**
   ```bash
   git tag v0.2.0
   git push origin v0.2.0
   ```
   The tag name must match `v*` (`v0.2.0`, not `0.2.0`) — that's what
   `release.yml`'s `on.push.tags` filters on. Pushing the tag is the only
   action that starts a release; pushing to `main` alone never does.
3. **GitHub Actions takes over.** The `Release` workflow runs on a fresh
   `ubuntu-latest` runner: `npm ci`, `npm test`, `npx tsc --noEmit`,
   `npm run build`, then `npm publish --provenance --access public`. Any
   failing step stops the workflow before `npm publish` ever runs — the
   full test suite (including `test/privacy/`) and a clean typecheck are
   both hard gates on every release, not just CI.
4. **`npm publish` authenticates via OIDC trusted publishing** — no token
   secret exists at all. npmjs.com's package settings pin a Trusted
   Publisher to exactly this repository and this workflow file
   (`Redential/redential-cli` + `release.yml`), and npm exchanges the
   workflow run's OIDC identity for publish access at publish time.
   Nothing to expire, nothing to steal — and a fork's PR can never
   publish: `release.yml` only ever runs on a `v*` tag push, never on a
   `pull_request` (see `.github/workflows/ci.yml`'s own comment on this,
   and CLAUDE.md's "Releases: only from GitHub Actions on tags... Release
   workflows NEVER run on `pull_request`").

## The macos-13 retirement and the darwin-x64 cross-target build

`release.yml`'s standalone-binaries job (see
[`docs/install-binaries.md`](install-binaries.md#how-releases-are-built))
used to build the Intel mac binary on a dedicated `macos-13` GitHub-hosted
runner, same as every other platform: one binary, built natively, on that
platform's own runner. That stopped being viable in practice — a release
run was observed queued 75+ minutes waiting for a `macos-13` runner while
every other matrix leg (including the `macos-14` arm64 leg) started within
seconds, strongly suggesting GitHub's `macos-13` runner pool is retired or
close to it, not just busy.

The fix removes the `macos-13` leg entirely and instead CROSS-TARGETS the
Intel binary from the `macos-14` (Apple Silicon) runner:
`scripts/build-sea.mjs --target darwin-x64` downloads the official
`darwin-x64` Node binary for the exact Node version the build is running
under from `nodejs.org`, verifies its sha256 against that same release's
own `SHASUMS256.txt` (mandatory — refuses and discards the download on any
mismatch, no exceptions, this is a trust product), and injects the SEA
blob into that verified binary instead of into the arm64 runner's own
`node`. This is sound, not a compromise, because the SEA blob (the bundled
CLI plus embedded `taxonomy.json`/`signatures/*.json`) is
platform-independent JavaScript and data — `postject` just injects the
same bytes into a different `node` executable, and macOS's ad-hoc
`codesign` doesn't care which architecture the binary it's signing targets
either. Only `darwin-x64` cross-target is implemented and tested; a
Windows (`.zip`-packaged) foreign target isn't — see
`scripts/build-sea.mjs`'s own top comment for that boundary.

Both `release.yml` and `ci.yml`'s `binary-smoke` job smoke-test the
cross-built `darwin-x64` binary on the arm64 runner that built it, via
Rosetta (`softwareupdate --install-rosetta --agree-to-license` first, in
case a future runner image ever ships without it — GitHub's own macOS
runner images document this as how to add it). Direct execution of an x64
binary on an arm64 mac with Rosetta installed already works transparently,
without needing an `arch -x86_64` wrapper.

## Verifying provenance

`--provenance` has `npm publish` attach a
[Sigstore](https://www.sigstore.dev/)-signed attestation proving the
published tarball was built by this exact GitHub Actions workflow run, from
this exact commit, triggered by this exact tag — not built or uploaded from
anyone's laptop. Verify it after a release with:

```bash
npm audit signatures
```

run from a project that has `@redential/cli` installed (or `npx
@redential/cli` while working in a directory where it's a dependency).
A verified package prints something like:

```
audited 1 package in Xs

1 package has a verified registry signature
```

You can also inspect the attestation directly on
[npmjs.com](https://www.npmjs.com/package/@redential/cli) — packages
published with provenance show a "Provenance" section linking back to the
exact workflow run and commit.

## If a release fails mid-way

- **Failed before `npm publish` ran** (`npm ci`/`npm test`/`tsc`/`npm run
  build` failed): nothing was published. Fix the underlying issue on
  `main`, then delete and re-push the tag:
  ```bash
  git tag -d v0.2.0 && git push origin :refs/tags/v0.2.0
  # fix, commit, merge
  git tag v0.2.0 && git push origin v0.2.0
  ```
- **`npm publish` itself failed** (registry outage, network error, or an
  OIDC/Trusted Publisher mismatch): same recovery — nothing reached the
  registry on a failed publish, so re-running is safe. If the error names
  authentication/OIDC, check that npmjs.com's Trusted Publisher config
  still points at `Redential/redential-cli` + `release.yml` and that the
  workflow kept its `id-token: write` permission, then retry.
- **`npm publish` succeeded but something is wrong with the published
  package** (e.g. a file that should have been in `files` wasn't): npm
  does not allow overwriting a published version. Fix the issue, bump to
  the next patch version, and cut a new release (`v0.2.1`) — never attempt
  to `unpublish` and reuse a version number; that breaks anyone who
  already resolved against it, including via a lockfile.
- **The tag was pushed but the workflow never triggered at all**: confirm
  the tag actually matches `v*` (a typo like `V0.2.0` or `release-0.2.0`
  won't match) and that Actions is enabled for the repository. Re-tagging
  with a correct name and re-pushing is safe — an untriggered workflow run
  published nothing.

## Alias packages

`packages/redential/` and `packages/redential-cli/` are thin, bare-name
launcher packages (`redential` and `redential-cli` on npm) that exist so
`npx redential scan` and `npm install -g redential` work without the
`@redential/` scope — `redential-cli` additionally exists as a defensive
registration against typosquatting. Each is just a `package.json`, a
minimal `bin.js` that imports `@redential/cli`'s real bin, and a README —
no build step, no `dist/`.

**Both aliases publish automatically**, as a `publish-alias` job in
`release.yml` gated on `needs: publish` (so it only runs after a
successful `@redential/cli` release). That job runs `npm publish` twice,
once per directory — `packages/redential-cli` under its checked-in name
`redential-cli`, then `packages/redential` under its checked-in name
`redential`. There's no rename trick: each is its own directory with its
own `package.json` name, publishing the exact same launcher under two
names. This replaced a manual step: both aliases had drifted to 0.5.0 on
npm while `@redential/cli` reached 0.9.0 before this automation existed.

OIDC trusted publishing requires npmjs.com's Trusted Publisher config to be
set up for **each** package name separately, pointing at
`Redential/redential-cli` + `release.yml` — `redential-cli` and `redential`
each need their own entry, same as `@redential/cli`'s. If one is missing
or misconfigured, only that directory's publish step in `publish-alias`
fails; the `publish` job (the main `@redential/cli` release) and the other
alias's publish step are unaffected.

**When to bump an alias's own version:** the automated `publish-alias` job
relies on both `packages/redential-cli` and `packages/redential` having
their version and `"@redential/cli"` dependency floor bumped on every
`@redential/cli` release, as part of the same version-bump step described
above — this keeps stale ranges or npm's resolution cache from pinning a
fresh install below the current release, even though the range itself
(`>=x.y.z`) already floats to the latest compatible `@redential/cli` on
every install regardless of the floor's exact value. Neither alias is
published manually anymore.

## Local checks before tagging

`npm run typecheck`, `npm test`, and `npm run build` all run again in CI,
but running them locally first (plus `npm pack --dry-run` to eyeball
exactly which files would ship) catches most problems before a tag — and
therefore a public release attempt — is even pushed.
