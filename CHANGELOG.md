# Changelog

All notable changes to this project will be documented in this file.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: strict [semver](https://semver.org/) — bundle schema changes
always bump at least minor; breaking schema changes bump major.

## [Unreleased]

### Added
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
