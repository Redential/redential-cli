# Changelog

All notable changes to this project will be documented in this file.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: strict [semver](https://semver.org/) — bundle schema changes
always bump at least minor; breaking schema changes bump major.

## [Unreleased]

### Changed
- `redential login` now makes a best-effort attempt to open
  `verification_uri` in the default browser after printing it, instead of
  only printing it — a deliberate reversal of the earlier design ("the CLI
  itself never opens one"): most device-flow CLIs (`gh auth login`,
  `vercel login`) auto-open, and the printed URL/code remain as the
  fallback for any failure (headless/SSH/no browser). Implemented with
  `node:child_process.spawn` only — no new dependency, no shell string on
  any platform (Windows uses `rundll32 url.dll,FileProtocolHandler` instead
  of `cmd /c start`, which can be split into a second command by a legal
  URL character like `&`). `verification_uri` is server-controlled, so it's
  validated as `http`/`https` before ever reaching a native opener. See
  `docs/login-submit.md`.

### Fixed
- `redential login`: polling `/api/cli/device/token` no longer treats
  `authorization_pending`/`slow_down` as a fatal network failure. The real
  server (RFC 8628 shape) returns every `{error: "..."}` state as HTTP 400,
  reserving 200 for `{access_token}` success — but the shared `postJson`
  helper throws on any non-2xx before reading the body, so the very first
  poll during normal waiting killed the whole login flow. New `pollJson`
  (`src/http-client.ts`), used only by the token poll, parses the body on
  both 200 and 400; the poll loop's existing handling of
  `authorization_pending`/`slow_down`/`access_denied`/`expired_token` is
  unchanged. `docs/login-submit.md` now states the HTTP status for each
  response shape explicitly.

### Added
- `redential login`, `redential submit`, `redential logout`: the first
  network-touching commands, per principle 1 ("the only network calls are
  login (device flow) and submit"). See
  [docs/login-submit.md](docs/login-submit.md).
  - `login`: RFC 8628-shaped device authorization flow against `SITE_URL`
    (public constant, overridable via `REDENTIAL_SITE_URL`). No backend for
    this exists yet in `redence` — this doc defines the contract redence
    implements against, not something mirrored from existing code. Stores
    `{access_token, site_url, obtained_at}` at
    `~/.config/redential/credentials.json`, mode `0600` (same pattern as the
    device salt). `submit` refuses a stored token whose `site_url` doesn't
    match the current `SITE_URL`.
  - `submit`: builds the bundle through the exact same
    `buildBundleInteractively` path `scan` uses (`src/build-bundle.ts`,
    extracted from `scan-command.ts` so both commands share it), prints it,
    then asks a **separate** "Upload this bundle?" confirmation
    (`--confirm-upload`) distinct from the authorization attestation
    (`--yes`) — consenting to be scanned and consenting to upload are
    different decisions. The exact printed string is what's sent
    (`postRawJson`, not a re-serialization), closing the byte-for-byte gap
    `docs/privacy-tests.md` had tracked since the `scan` milestone.
  - Remote-visibility gate (`src/submit.ts`'s `checkVisibilityGate`):
    implements the `TODO` left in `src/public-remote.ts` — an anonymous
    `HEAD` request straight to the remote URL itself (never to `SITE_URL`),
    gated on the existing local `isKnownPublicHost` heuristic. A confirmed
    `2xx`/`3xx` blocks `submit` (with a GitHub App suggestion); anything
    inconclusive (network error, timeout, private/`4xx`) fails open, same
    as `scan`'s warn-only stance. `scan` itself is unchanged — still zero
    network, still warn-never-block.
  - `logout`: deletes `credentials.json` if present; a no-op, not an error,
    if there's nothing to delete.
  - No new dependencies: Node 20's global `fetch`/`Response`/`AbortSignal`
    typecheck cleanly under this project's existing `tsconfig.json` without
    any ambient shims. Network calls are confined to three files
    (`http-client.ts`, `login.ts`, `submit.ts`) —
    `test/privacy/zero-network.test.ts`'s static backstop now allowlists
    exactly those three instead of asserting all of `src/` is network-free, since that
    blanket assertion contradicted principle 1 once login/submit existed;
    its runtime-mocked proof (now also stubbing `fetch`, not just
    `node:http`/`node:https`) still proves the full `scan` path makes zero
    network calls.
  - Errors are one of `ScanError`/`AuthError`/`SubmitError`/`NetworkError`
    (`src/errors.ts`); `NetworkError` messages are built only from a
    request's host and status, never headers or body, so a failed request
    can never echo the bearer token or bundle content into a printed error.
    EOF on `submit`'s new upload-confirmation prompt aborts non-zero, same
    as `scan`'s existing prompts.
- Repo scaffolding: principles, schema draft (bundle v1), contributing and
  security policies.
- `detected_skills` field in the bundle v1 draft schema: array of
  `{slug, commit_count, first_seen, last_seen}` (may be empty, always
  present). Skills are detected locally by deterministic signature matching
  (`signatures/*.json`) over diff contents — zero network calls during
  `scan`, no LLMs.
- Initial `taxonomy.json`: the closed public vocabulary of skill slugs. A
  slug outside this list invalidates the bundle. Placeholder set (~38
  slugs), to be expanded.
- `redential scan`: first working CLI command. Reads local git history and
  prints a proof bundle validated against `schema/bundle.v1.json`
  (`detected_skills` stays `[]` until signature matching lands). Interactive
  author-identity selection and authorization confirmation by default;
  `--author <email>` (repeatable) and `--yes` for non-interactive use — kept
  as two separate flags on purpose, since one answers "which emails are
  mine" and the other "I'm authorized to scan this repo". See
  [docs/scan.md](docs/scan.md). TypeScript, ESM, zero dependencies beyond
  `commander` (`vitest` for tests) — no `@types/node` either; `src/`
  ships its own minimal ambient Node type shims to keep the dependency
  surface exactly at what CLAUDE.md permits.

- Privacy test suite in `test/privacy/`: a hostile fixture repo (planted
  `xxx-EXAMPLE-xxx`-style AWS/PEM/`.env` secrets, a revealing path, remote
  URL, and commit message, plus a second contributor) proves the bundle
  never contains any of it — only extensions, closed-vocabulary categories,
  `host_type`, and salted hashes survive. Every principle in
  `docs/principles.md` now maps to at least one test; see
  [docs/privacy-tests.md](docs/privacy-tests.md) for the full map.
- `assertNoSecrets`/`findSecretPatterns` (`src/secret-scan.ts`): scans the
  final serialized bundle for AWS-key-, PEM-key-, `api_key=`-, and
  `.env`-shaped strings and refuses to return a bundle if any match — the
  regression guard CLAUDE.md mandates ("Secret-scan del PAYLOAD antes de
  cualquier output/submit"), wired into `runScan` itself. Never echoes the
  matched value in its own error message.
- Known-public-host warning: if the repo's remote looks like GitHub,
  GitLab, or Bitbucket (and carries no embedded credentials/token), `scan`
  prints an informational note suggesting the GitHub App as an alternative
  — and then continues scanning regardless. Known host != publicly
  accessible, and `scan` has no network access to tell them apart; the
  CLI's primary use case is a *private* employer repo hosted on
  `github.com`, so this guardrail warns, it never blocks.
  `src/public-remote.ts`'s `isKnownPublicHost`/`publicHostWarning` are pure,
  local functions of the remote URL string, never a network check (see
  docs/privacy-tests.md's naming note and TODO on the real, network-backed
  verification planned for the `submit` milestone).
- `test/privacy/zero-network.test.ts`: runtime proof (mocked `node:http`/
  `node:https`) that `listAuthors`, the guardrail check, and `runScan` never
  call either module, plus a static backstop grepping `src/` for any
  `fetch`/`http`/`https` reference.

### Changed
- Principle 3 renamed from "Metadata-only" to "Bounded output": the CLI DOES
  read diff contents locally for skill detection; what leaves the machine is
  bounded to aggregates, salted hashes, and the closed vocabulary of
  `taxonomy.json` (see `docs/principles.md`).
- `src/git.ts`'s signed-commit detection now counts only `%G? == "G"`
  (fully verified signature) as signed — `"U"`/`"B"`/`"E"`/expired/revoked
  statuses are all treated as unsigned; documented in `docs/schema.md`.
- Interactive prompts (`src/prompt.ts`) now fail loudly on EOF (closed
  stdin) instead of hanging and letting the process exit 0 silently with no
  bundle.
