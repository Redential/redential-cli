# Redential CLI — repo rules

Open-source CLI (`@redential/cli`, Apache-2.0) that produces METADATA-ONLY
"proof bundles" from local git repos. The user's source code NEVER leaves
their machine. This repo is public and receives third-party PRs: every rule
here exists because trust is the product.

## What it is / what it isn't

- IS: a local detector. Reads `git log` retroactively, produces a JSON
  bundle validated against `schema/bundle.v1.json`, and uploads it ONLY
  with explicit user confirmation.
- IS NOT: a daemon, a real-time tracker, an automatic uploader. FORBIDDEN
  to implement watch mode, telemetry, or any upload without an explicit
  `redential submit`.

## Non-negotiable principles (see docs/principles.md)

Every principle has tests in `test/privacy/`. A PR that breaks a privacy
test does not get merged, no exceptions. Any change to WHAT data leaves
the machine requires: (1) a prior discussion issue, (2) a schema version
bump, (3) an entry in docs/schema.md and CHANGELOG.md.

## Security

- ZERO secrets in this repo. The CLI doesn't know anyone's API keys: only
  `SITE_URL` (public) and the user's token obtained via the device flow.
- User token: `~/.config/redential/credentials.json` with 0600
  permissions. Never in the cwd of the scanned repo. `redential logout`
  deletes it.
- Never log the token or the full bundle in errors. Stack traces without
  payload.
- Secret-scan of the PAYLOAD before any output/submit (mandatory): AWS key
  patterns, generic tokens, private keys, .env values.
- ZERO postinstall scripts in package.json. ZERO new dependencies without
  written justification in the PR (supply-chain surface). Allowed stack:
  commander, vitest. Everything else gets discussed first.
- `package.json` with explicit `files: ["dist"]`.
- Releases: only from GitHub Actions on tags, with `npm publish
  --provenance`. Release workflows NEVER run on `pull_request`.

## Conventions

- Strict TypeScript. Node >= 20. ESM.
- Code comments and public docs in ENGLISH (international repo).
- Tests with vitest. Fixtures are git repos created programmatically in
  tmpdir (never committed fixtures with real history).
- Every feature: entry in CHANGELOG.md (Keep a Changelog, strict semver)
  + a doc in docs/ explaining how it works.
- Bundle schema changes = major or minor bump depending on compatibility.
- The `scan` command ALWAYS prints the exact JSON before any submit.
- If the repo's remote looks like it's on a known public host
  (github.com/gitlab.com/bitbucket.org), `scan` suggests connecting the
  GitHub App as an alternative (anti-cannibalization guardrail) — but
  WITHOUT blocking the scan: a known host != actually public, and without
  network access there's no way to tell the difference. The CLI's PRIMARY
  use case is exactly a private employer repo hosted on github.com;
  blocking there would break the product. Real visibility verification is
  left to `submit` (which does have network access).
- When closing out each milestone or large task, BEFORE the commit: write
  in the chat a short "Explicación para el dueño" (Explanation for the
  owner) — max 10 lines, in simple Spanish, no technical jargon. It must
  answer: (1) what we built and what it's for, (2) the 2-3 important
  decisions and WHY, (3) what would break if someone mishandles each key
  piece. Meant so a non-programmer running the product can re-explain it
  to someone else. This is NOT technical documentation — that always goes
  in docs/ as usual.

## Limits for agents

- INVIOLABLE RULE — zero network in scan: `scan` makes NO network calls
  whatsoever. Skill detection is deterministic diff matching (read locally
  with `git show`/`git diff`) against `signatures/*.json` (a versioned
  signature database in this repo: imports, config files, per-library API
  patterns). No LLMs, no remote inference, in any variant.
- INVIOLABLE RULE — closed vocabulary: the bundle only admits skill slugs
  present in `taxonomy.json` (public, in this repo). A slug outside that
  list invalidates the bundle. New slugs come in via PR to `taxonomy.json`,
  never hardcoded in the CLI.
- Never create files with secrets or example values that look real (use
  `xxx-EXAMPLE-xxx`).
- Never add telemetry, analytics, or network calls outside
  `login`/`submit`.
- The server-side (the `/api/cli/*` endpoints, the `proof_bundles` table)
  lives in the redence repo, NOT here. This repo ends at the HTTP request.
- The redence repo may be mounted as READ-ONLY context. NEVER copy to this
  repo (which is public) code, paths, internal URLs, or conventions that
  reveal redence's architecture.
- Executor/advisor pattern: before starting a milestone, present the plan
  to the `advisor` subagent and apply its response. If you fail the same
  problem twice, consult it before the third attempt. Also consult it
  BEFORE the first attempt when a bug touches sensitive zones AND the
  cause isn't obvious (auth, data loss, "works in test but fails in
  production") — come to the consult with the reproduction and the
  evidence, not the bare symptom. Don't consult it for routine work: it's
  expensive on purpose.
- Closing gate: a milestone is NOT done until the `reviewer` subagent
  returns "VERDICT: APPROVED". If it returns CHANGES REQUIRED, implement
  the changes and resubmit it. The commit comes after approval, never
  before.
- Sensitive zones — reviewer ALWAYS, regardless of change size or whether
  a goal is active: any change touching src/secret-scan, src/public-remote,
  test/privacy/, schema/, taxonomy.json, network code (login/submit), or
  that modifies WHAT data leaves the machine or WHERE it travels to,
  requires "VERDICT: APPROVED" before committing. Trivial changes outside
  those zones don't require it.
