# Changelog

All notable changes to this project will be documented in this file.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: strict [semver](https://semver.org/) — bundle schema changes
always bump at least minor; breaking schema changes bump major.

## [Unreleased]

### Fixed
- Fix the author identity prompt showing "1 commits" instead of "1 commit" when a single commit is found.

## [0.6.0] - 2026-07-22

### Fixed
- Tier 2 `importPatterns`/`apiPatterns` no longer match line comments and
  block comments (honest-scan false positives such as `// supabase.from("x")`
  deprecation notes); template-literal and string content remain matchable
  for `apiPatterns`.

### Added
- Add `ai/mcp` to the closed skill taxonomy for Model Context Protocol work.
- Map official MCP SDK imports (`@modelcontextprotocol/sdk`, Python `mcp` /
  `fastmcp`, Rust `rmcp`, Java `io.modelcontextprotocol`, Go
  `github.com/modelcontextprotocol/go-sdk/mcp`, C# `ModelContextProtocol`) to
  `ai/mcp`.

### Changed
- **Bare-name alias packages published: `redential` and `redential-cli`.**
  Two thin launcher packages, `packages/redential/` and
  `packages/redential-cli/` (in this repo, published manually by the owner
  — not part of this package's own release pipeline; see
  [docs/releasing.md](docs/releasing.md#alias-packages)), so `npx redential
  scan` and `npm install -g redential` work without the `@redential/`
  scope. Each is a 3-file package (`package.json`, a minimal ESM `bin.js`
  that does nothing but `import "@redential/cli/dist/cli.js"`, and a
  README) with a floating `"@redential/cli": ">=0.5.0"` dependency, no
  `devDependencies`, and no scripts — zero postinstall, per this repo's
  security rules. `redential-cli` exists purely as a defensive
  registration against typosquatting and points users at `redential` or
  `@redential/cli` instead. **The canonical package, `@redential/cli`, is
  completely unaffected** — its `package.json`, `files`, and published
  tarball contents are unchanged (verified via `npm pack --dry-run`
  producing an identical file list before and after).
  README examples updated to lead with the shorter `npx redential
  scan`/`login`/`submit`/`logout` and `npm install -g redential`, with the
  canonical `@redential/cli` name kept visible alongside each for trust
  and provenance verification.

## [0.5.0] - 2026-07-14

### Added
- **Mandatory private label on `submit`** — a repo nickname only you ever
  see, sent as a SECOND request (`POST /api/cli/private-label`) after the
  bundle upload succeeds, never inside the bundle itself. No schema
  change: the bundle payload, its bytes, and every existing guardrail test
  are completely unaffected — this is additive, out-of-band data, not a
  new bundle field. See [docs/private-label.md](docs/private-label.md) for
  the full design record (what travels, why outside the bundle, the fixed
  server contract, and failure semantics).
  - **BEHAVIOR CHANGE for scripted/non-interactive submits: `--label
    <text>` is now REQUIRED.** `redential submit --yes --confirm-upload`
    (or any non-TTY/piped invocation) without `--label` now fails
    immediately — before any network call, exit 1, nothing uploaded — with
    a clear error naming the missing flag. Existing automation that calls
    `submit` non-interactively must add `--label "<some nickname>"` to
    keep working.
  - On a real TTY without `--label`, `submit` now asks interactively:
    `Private label for this repo (only you will ever see it): `. An
    invalid answer (empty, over 64 characters, containing control
    characters, or itself secret-shaped) re-asks up to twice; failing all
    3 attempts aborts the whole submit — exit 1, nothing uploaded, not
    even the bundle.
  - The label is validated with the same secret-scan the bundle payload
    itself is checked against (`assertNoSecrets`) — a secret typed into
    the label blocks the entire submit, same as a secret found in the
    bundle.
  - Printed as part of the same consent surface as the exact JSON payload,
    right before the final "Upload this bundle? (y/n)" prompt: `Plus your
    private label: «X» (travels alongside the bundle, never inside it —
    only you will ever see it)`.
  - If the label request fails after the bundle already uploaded
    successfully (network error, or the server returns 401/404/422),
    `submit` never retries it and never re-uploads the bundle — it prints
    a warning naming the label (with a note that it can be set later from
    the web) and still exits 0, since the bundle itself is safely
    uploaded.
  - Never persisted to `last-submission.json` or any other local file —
    see [docs/private-label.md#never-stored-locally](docs/private-label.md#never-stored-locally).

## [0.4.0] - 2026-07-14

### Changed
- **Console UX (phase 2): `scan` becomes a summary-first command; the
  wrapped summary is replaced by a "CAPABILITIES DETECTED" layout; new
  `--details` flag; taxonomy label cleanup.** Presentation-only — the
  bundle payload, the schema, and the piped/no-flags stdout contract (still
  the exact JSON, byte-identical to every prior release) are unchanged.
  Supersedes the phase-1-adjacent "structural evidence gets a badge in
  SKILLS DETECTED" entry above: that badge and its separate STRUCTURAL
  EVIDENCE (proof graph) section (with a `redential explain <slug>`
  pointer line) are folded into this new layout instead, described below.
  - **`scan`'s default TTY output is now the human-readable summary ONLY —
    no JSON dump.** Previously a real terminal got the consent box, the
    exact JSON, and the wrapped summary, in that order; now it gets just
    the summary, which itself points at `redential scan --json` for the
    exact payload. `--json` forces JSON-only output even on a TTY (existing
    flag, now also treated as "non-interactive" throughout: it skips the
    connectable-repo notice's "Continue locally?" follow-up and the
    huge-repo progress line too, exactly as a piped run always has).
    `scan`'s own consent box is removed (it's fully superseded by the new
    summary's own closing "Nothing left your machine..." block plus the
    `--json` pointer); `submit`'s consent box (`formatConsentSummary`) is
    unchanged and still prints before its own upload confirmation. Piped
    stdout with no flags is byte-identical to every prior release.
  - **New `redential scan --details` flag** adds the COMMITS BY
    HOUR/WEEKDAY histogram sections (unchanged content, just relocated) to
    the summary; the default view omits them to stay a short, shareable
    overview. No effect on `--json`/piped output.
  - **New summary layout.** Header: `PRIVATE WORK, LOCALLY DERIVED` /
    `<span> · <commits> authored commits · <ownership>% ownership`
    (replaces the old boxed "YOUR PRIVATE REPO, WRAPPED" title and
    `<span>, <commits> commits` line — ownership now appears up top too, not
    only in the footer block). `CAPABILITIES DETECTED` replaces `SKILLS
    DETECTED`: structural findings (`evidence: "structural"`) are always
    listed FIRST with a `STRUCTURAL · DIRECT`/`INFERRED` tag (nothing is
    printed when there are none); every other detected skill is grouped by
    taxonomy slug prefix (`frontend` → "Frontend", `payments` → "Payments",
    `queues` → "Background jobs & queues", etc. — 14 named prefixes, falling
    back to a capitalized prefix otherwise), groups ordered by total commit
    count descending, entries within a group capped at 4 with an honest
    "+N more". Every capability/group/category label is now the taxonomy's
    own human label, never the raw lowercase slug (falling back to the slug
    only if a taxonomy label is genuinely missing). `TOP CATEGORIES` is now
    humanized the same way (never a raw category slug), always hides the
    `other` catch-all bucket, and hides any category under 2% churn share;
    the `(N commits)` suffix is dropped (percentage only). The closing CTA
    header changes from "Want this on a public, verifiable profile?" to
    "Add this private work to your public Redential profile:" (never says
    "verifiable profile" going forward); the footer's fixed "Nothing left
    your machine..." block is expanded to also name what's uploaded
    (aggregates, salted fingerprints, closed-vocabulary capability slugs)
    and what never is, followed by `redential scan --json` /
    `redential scan --details` pointers. The signed-commit tip's copy
    changes to "Tip: signing future commits adds a stronger identity anchor
    to your attestation." (same 0%-ratio trigger, shorter copy, no longer
    names the `git config` command directly).
  - **`formatConsentSummary`'s "top:" clause (`submit`'s consent box) now
    shows human labels, not raw slugs** — e.g. "top: Stripe, PostgreSQL"
    instead of "top: payments/stripe, db/postgres" (deferred from phase 1).
    Same width-safety/honest-"+N more" behavior, just over labels instead
    of slugs.
  - **`taxonomy.json` (1.5.0 → 1.5.1, patch, label-only):** the 5
    webhook/payment-flow structural slugs drop their redundant " (structural)"
    label suffix (e.g. "Payment webhook flow (structural)" → "Payment
    webhook flow") — the summary's own `STRUCTURAL · DIRECT`/`INFERRED` tag
    already conveys that, making the suffix redundant noise in the new
    label-driven display. `payments/iap-subscription-flow`'s label
    ("...(RevenueCat)") is unaffected — it never carried the suffix. No
    slugs added, removed, or renamed.
  - See [docs/scan.md](docs/scan.md) for the full new output contract and
    an example.
- **Console UX (phase 1): connectable-repo notice, prompt copy, and
  `submit`'s TTY output order.** Presentation-only — the bundle payload,
  the schema, and every non-TTY/piped output contract are unchanged.
  - The connectable-repo notice (`scan`/`submit`, shown when the remote
    looks like it's hosted on github.com/gitlab.com/bitbucket.org) is
    rewritten to a short three-line notice: "This repo appears connectable
    through GitHub. / For repos you own, the GitHub App provides stronger
    evidence. / For employer or NDA-protected repos, continue with the
    local scan." On a real TTY only, a new follow-up question — "Continue
    locally? (Y/n)", Y default — now appears right after it. Declining (`n`)
    exits cleanly (exit code 0) without scanning anything, printing a brief
    note pointing at the GitHub App instead. Piped/non-TTY output is
    unaffected: the notice still prints (non-blocking, to stderr), but no
    interactive question is ever asked, matching every prior release.
  - The two identity-confirmation prompts (`scan`/`submit`'s single-author
    and git-identity pre-selection flows) now share one unified,
    thousands-separated copy: "Found 1,378 commits authored by
    you@example.com. Use this identity? (Y/n)" (Y default, unchanged).
  - The authorization-attestation prompt's copy and displayed default
    change to "Confirm you are authorized to analyze this repository.
    (y/N)" — pressing Enter now visibly declines; typing `y` is required to
    proceed. The check itself already only ever accepted an explicit `y`
    answer, so what gets recorded in the bundle's `attestation` field is
    unchanged — only the prompt's copy and shown default changed.
  - `submit`'s TTY output is reordered: a new one-line short summary
    ("<span> of private work · <n> commits · <k> capabilities detected",
    with a "(<s> structural)" suffix appended whenever at least one
    detected skill carries `evidence: "structural"`) now prints first,
    followed by the identity-corroboration line (if any), the consent box
    ("WHAT GETS UPLOADED", title unchanged), and finally the payload header
    followed by the exact bundle JSON, with the upload prompt immediately
    after. The inviolable guarantee is unchanged and, if anything,
    strengthened: the exact byte-for-byte JSON is always the last thing
    printed before the upload prompt, on every code path. Piped/non-TTY
    `submit` output, and the JSON bytes sent to the server, are unchanged.

## [0.3.0] - 2026-07-13

### Added
- **Structural skill detection (the "proof graph") and `redential
  explain`.** Alongside the existing import-based detection tier (a
  package name matched in an added line), skill detection can now also
  follow connected relations across a diff's code — a function that
  verifies a Stripe webhook signature, feeding a database write, guarded
  by an idempotency check — and only claim a skill when that whole shape
  is actually present and reachable, not merely imported somewhere. This
  ships for one language (TypeScript, via the TypeScript compiler API
  behind a `ParserAdapter` seam) and one taxonomy slug,
  `payments/payment-webhook-flow`, now recognized across five real payment
  providers (Stripe, PayPal, MercadoPago, Lemon Squeezy, Paddle) plus a
  call-shape-only IAP/RevenueCat pattern — six providers in total. Detection
  stays entirely local and zero-network, matching `signatures/*.json`-style
  determinism — no LLMs, no remote inference. `redential explain <skill>`
  is a new, read-only, local-only command that shows why a given taxonomy
  slug did or didn't classify for the current repo (including the
  `AMBIGUOUS` case, which never reaches a bundle — see below); it accepts
  the same `--author`/`--since` flags as `scan` (same attribution/window
  semantics — see [docs/scan.md](docs/scan.md#huge-repositories-and---since))
  and writes nothing to disk and makes no network call. See
  [docs/proof-graph-spike.md](docs/proof-graph-spike.md).
- **Two new optional `detected_skills[]` fields, `evidence` and
  `confidence` — bundle schema `1.1.0` → `1.2.0` (minor, additive).**
  `evidence: "import" | "structural"` records which detection tier
  produced an entry; `confidence: "direct" | "inferred"` records how
  directly a structural finding was attributed. Both are closed enums, no
  free text. `AMBIGUOUS` classifications and unattributed findings are
  never emitted under any field — ambiguous means the skill is not
  claimed in the bundle at all. Nothing else graph-derived (paths,
  function names, node/edge counts) ever enters the bundle. A `1.2.0`
  bundle that omits both fields (every import-tier entry) is fully valid;
  the change is purely additive to the shape a `1.1.0`-era consumer
  already understood. Full contract and rationale:
  [docs/schema-change-h7.md](docs/schema-change-h7.md); field docs:
  [docs/schema.md](docs/schema.md#evidence--confidence-since-schema-120).

### Changed
- **Performance and progress reporting for `redential explain`/structural
  detection.** The cross-file structural search now runs over distinct
  files with cached, depth-capped BFS and a deterministic work budget
  (instead of the earlier O(anchor-instance) search, which could hang for
  minutes on dense real-world repos) — search that exceeds the budget
  degrades to `AMBIGUOUS`, never a false claim. `getAllCommits` now
  filters by author at the git level (`--author`) instead of walking and
  diffing every author's commits in JS. `explain` prints a live,
  TTY-gated progress line on stderr (closed set of phase labels + counts
  only, never paths/names/emails, same paste-safety invariant as
  `--debug`); piped output is unaffected. No change to bundle contents or
  to what `scan`/`submit` output.

## [0.2.2] - 2026-07-12

### Changed
- **`submit`'s TTY output reordered: consent box now prints right before the
  upload prompt, not before the JSON.** The exact payload header and JSON
  (`Exact payload (byte-for-byte what gets sent):` + the bundle JSON) now
  print first; the human-readable consent box (`formatConsentSummary`) and
  the identity-corroboration line (if any) print after the JSON, immediately
  before the "Upload this bundle?" confirmation — so the last thing read
  before consenting is the plain-language summary, not the tail of the JSON.
  Piped/non-TTY `submit` output is unaffected (byte-identical). `scan`'s own
  TTY order (consent box before the JSON) is unchanged.

## [0.2.1] - 2026-07-11

### Added
- **Consent summary before the exact payload (`scan`/`submit`, TTY-only, no
  schema change).** Both commands now print a short human-readable
  **consent summary** immediately before the exact JSON bundle — a boxed
  block using the same visual language as the "wrapped" summary (Unicode
  box-drawing characters + ANSI on rich terminals, the same ASCII fallback
  on plain Windows `conhost` via the existing `shouldUsePlainOutput`
  logic), listing what IS uploaded (commit count and span, detected-skill
  count with up to the top 3 skill names (as many as fit the box, the
  rest marked "+N more"), "time patterns, languages and
  categories as aggregates", salted fingerprints) and what is NEVER
  uploaded (source code, file names, commit messages, the repo's name,
  other contributors' identities). Every number in the block is read off
  the actual bundle being printed, never hardcoded (`formatConsentSummary`,
  `src/summary.ts` — pure formatting over the bundle already computed: no
  new data collection, no network). Right after the block, a header line
  makes explicit what follows is the literal payload: `Exact payload
  (byte-for-byte what gets sent):` on `submit`, `Exact payload
  (byte-for-byte what \`redential submit\` would send):` on `scan` (which
  uploads nothing itself, hence "would"). On `scan`'s TTY output the order
  is now consent summary → header → JSON → wrapped summary (wrapped stays
  last, unchanged); on `submit`'s TTY output it's consent summary → header
  → JSON → identity-corroboration line (if any) → upload confirmation
  prompt, so the user reads the plain-language summary and the exact
  payload before consenting. Piped stdout and `--json` are completely
  unchanged — `scan | jq` and a scripted `submit` see no new output,
  byte-identical to prior releases. No schema change: schema stays
  `1.1.0`, since nothing about WHAT data leaves the machine changed, only
  how it's explained on screen before upload. See
  [docs/scan.md](docs/scan.md#the-consent-summary) and
  [docs/login-submit.md](docs/login-submit.md#submit-review-then-upload).

## [0.2.0] - 2026-07-10

### Added
- **Identity corroboration (`submit`-only, no schema change).** Between
  printing the bundle and asking "Upload this bundle?", `submit` now makes
  one more authenticated request, `GET {SITE_URL}/api/cli/identity/emails`
  (Bearer token, 5s timeout, fail-open) — the account's verified emails
  (Redential account email plus verified GitHub primary email, typically
  1-2 entries; deliberately short, since a real git history legitimately
  contains `noreply`/old-work addresses that won't be on it). Each is
  hashed locally with the same device salt used for
  `identity.author_identity_hashes` and compared, producing only two
  integers (`corroborated_count`/`total_claimed`), never anything more
  granular. Per principle 4 ("no hidden fields, no enrichment after
  review"), since these counts leave the machine but aren't inside the
  printed bundle, `submit` prints one calm line with the result *before*
  the upload confirmation (never accusatory, never blocking — an
  unmatched identity just doesn't earn a corroborated marker). On upload,
  the counts ride as an optional `X-Redential-Identity-Corroboration:
  {"corroborated_count": N, "total_claimed": M}` header on `POST
  /api/cli/bundles` — never inside the bundle body, so the bundle stays
  byte-identical to what was printed and the header plays no part in the
  server's duplicate-bundle dedup. Fail-open end to end: an unreachable
  endpoint, a timeout, any non-2xx (including `429`), an unexpected
  response shape, or `total_claimed` exceeding the server's bound simply
  omits both the printed line and the header, and `submit` proceeds
  normally — corroboration can never fail or delay a submit. The fetched
  emails live in process memory only for the comparison — never logged,
  never written to disk, never placed in the bundle or any request body —
  pinned by a new privacy test,
  `test/privacy/identity-corroboration.test.ts`. See
  [docs/login-submit.md](docs/login-submit.md#identity-corroboration-submit-only)
  for the full contract.
- **Rewrite-forensics signal: `integrity.date_forensics` (schema `1.0.0` →
  `1.1.0`, minor/additive).** `getAllCommits` now also reads each commit's
  committer date (`%cI`, alongside the existing author date `%aI`) —
  distinct from the author date because a rebase, `filter-branch`, amend,
  or squash-merge platform rewrites the committer date while leaving the
  author date untouched. Four new aggregate fields, no per-commit dates:
  `author_span_days`/`committer_span_days` (max−min, in days, computed
  independently per date), `mismatch_ratio` (fraction of the user's commits
  whose committer date differs from its own author date by >48h), and
  `committer_burst_ratio` (fraction of the user's commits whose committer
  date falls inside the single densest 24h window). A script that replays
  years of fabricated history in one sitting (the scenario the README
  FAQ's "can't I replay someone else's git history" answer already
  addresses) can forge author dates freely, but its committer dates all
  land in that one sitting — large `author_span_days`, near-zero
  `committer_span_days`, both ratios near `1.0`, together. Documented as a
  **heuristic signal for server-side scoring only** — `scan`/`submit` never
  fail, warn, or block on these values, and two known non-incriminating
  shapes (a genuinely young/short-window repo degenerately bursts; ordinary
  squash-merge workflows routinely mismatch) are called out explicitly so
  the fields are read jointly, never thresholded alone. See
  [docs/schema.md](docs/schema.md#date_forensics-measurement-contract) for
  the full measurement contract and the README FAQ for the user-facing
  version. The wrapped terminal summary does not display this field — it's
  for server-side scoring, not for surfacing messy rebase habits locally.
  Prior-discussion issue:
  [#1](https://github.com/Redential/redential-cli/issues/1) (CLAUDE.md
  requires one for any change to what data leaves the machine).
- **Launch-polish batch: shallow-clone detection, author pre-selection,
  `redential status`, and `--debug`.**
  - **Shallow-clone detection.** `scan`/`submit` warn (never block) when
    the repo is a shallow clone (`git rev-parse
    --is-shallow-repository`), naming the `git fetch --unshallow` remedy
    — history before the shallow boundary is entirely absent locally, so
    commit counts/span/age would otherwise silently understate real
    activity. The TTY wrapped summary repeats a short note. See
    [docs/scan.md](docs/scan.md#shallow-clones).
  - **Author pre-selection from your git identity.** When `git config
    user.email` matches one of 2+ candidate authors, it's offered first
    as a fast Y/n default ("Found your git identity: ... Use it?")
    before the existing list/single-candidate flows — which run
    unchanged on decline, no match, a single candidate (avoids asking
    the same yes/no question twice), or when `--author` is passed. See
    [docs/scan.md](docs/scan.md#how-it-works).
  - **New `redential status` command.** Read-only, zero network, works
    logged out: CLI version, config dir, login state + site_url, and the
    last submission on record (timestamp, plus 12-hex-char prefixes of
    the bundle hash and repo fingerprint — never the full values). Adds
    an optional `repo_fingerprint` field to the local
    `last-submission.json` record (never leaves the machine; the value
    is already inside the bundle `submit` uploads). See
    [docs/login-submit.md](docs/login-submit.md#status-local-state-read-only).
  - **`--debug` global flag.** Verbose diagnostics to stderr only (git
    commands run — argv only, never the repo path or diff content;
    phase timings; commit/batch counts). Piped stdout stays
    byte-identical; a privacy test
    (`test/privacy/debug-output.test.ts`) asserts the session token and
    bundle field values can never appear in `--debug` output. See
    [docs/scan.md](docs/scan.md#--debug).
- **Skill detection now covers Rust, Java, Kotlin, C#, and Swift.**
  `src/import-detect.ts` gains five new Tier 1 extractors, same
  architecture as the existing JS/Python/Go/Ruby/PHP ones (regex-based, no
  new dependencies, gated against comments and string-literal near-misses):
  Rust `use` statements and `Cargo.toml` dependencies (hyphen/underscore
  crate-name normalization; a dotted `[dependencies.tokio]` section header
  is read as the crate name without key-scanning its body); Java/Kotlin
  `import` statements, normalized via a new multi-depth candidate scheme
  (1-3 dotted segments, map membership decides which depth is real — lets
  `org.springframework.*` collapse to one entry while `com.google.gson`/
  `com.google.inject` stay distinct); C# `using` directives (same
  multi-depth scheme) and `.csproj` `<PackageReference>` XML attributes;
  Swift `import` statements and `Package.swift` SPM dependency URLs. See
  [docs/signatures.md](docs/signatures.md#rust-jvm-and-c-scope-honestly)
  for the exact rules and their documented approximations, matching the
  existing PHP-namespace precedent.
  - `signatures/package-map.json` grows by 129 entries (594 total,
    `jq '.map | length' signatures/package-map.json`), `taxonomy.json` by
    94 new slugs (207 total, version 1.3.0) across `backend/`, `db/`,
    `data/`, `testing/`, `observability/`, `auth/`, `queues/`, `frontend/`,
    `storage/`, and `infra/` — real, well-known packages per ecosystem
    (Tokio, Serde, Actix, Warp, Clap; Spring, Hibernate, Jackson, JUnit,
    Retrofit, Mockito; ASP.NET Core, EF Core, xUnit, Newtonsoft.Json,
    Dapper; Alamofire, Vapor, SwiftUI, Combine, and more).
  - `axum` deliberately stays a Tier 2 signature (unchanged) rather than
    also becoming a Tier 1 map entry — its existing `importPatterns`
    already matches a bare `use axum::...;`, so it's already functionally
    equivalent to a Tier 1 entry; duplicating it would only add a second
    place to keep in sync for zero behavior change.
  - `test/package-map.test.ts` gains an invariant test (no dotted map key
    is a strict prefix of another) that the new multi-depth candidate
    scheme depends on for correctness.
  - Verified end to end with a synthetic 5-language fixture repo in
    `test/scan.test.ts` (Rust+Cargo.toml, Java, Kotlin, C#+.csproj,
    Swift+Package.swift in one commit history), asserting the exact
    `detected_skills` slugs a real multi-language contributor's history
    would produce.
- **`scan` handles huge repositories gracefully.** Three changes, all in
  service of the same goal: `scan` staying fast, bounded, and honest on a
  repo with tens of thousands of commits. See
  [docs/scan.md](docs/scan.md#huge-repositories-and---since).
  - **Streaming, batched commit walk.** `git.ts`'s commit walk now streams
    `git log`'s output incrementally via `spawn` instead of buffering it
    all through `execFileSync` (which silently hit Node's default 1MB
    child-process buffer on a large-enough repo, previously misread as
    "no commits"). Skill detection's diff-content fetch now runs in
    batches of ~200 commits per `git show` process instead of one process
    per commit — the dominant cost at scale was subprocess spawn count,
    not git's own work — so at most one batch's diff text is ever held in
    memory at once. A programmatically generated 20,000-commit fixture now
    scans in a few seconds; asserted under 60s in a new, separate slow
    suite (`test/slow/`, `npm run test:slow`, excluded from the default
    `npm test`; CI runs it as its own `ubuntu-latest` job).
  - **Huge-repo progress on stderr.** On a real TTY, `scan` prints a
    throttled "scanning commits... N/Total" line to stderr while it walks
    history. Piped/redirected stdout (`scan | jq`, `--json`) gets no
    progress output at all — the existing JSON-only stdout contract is
    byte-identical either way, covered by a dedicated test.
  - **`--since <spec>` flag.** Limits analysis to commits at or after a
    relative window (`2years`, `18months`, `30days`) or an absolute date
    (`2024-01-01`) — `src/since.ts`. No new bundle field: `first_at`,
    `span_days`, and the other window-scoped fields simply reflect the
    analyzed window (see [docs/schema.md](docs/schema.md#commits)).
    `repo.age_days`/`repo.repo_fingerprint` deliberately stay
    window-independent, always reflecting the repo's true root commit. The
    wrapped summary states the active window (e.g. "last 2 years") next to
    the span line when one is applied.
- **Closing next-step hint on the wrapped summary.** `scan`'s TTY-only
  "wrapped" summary now ends with a next-step CTA after the "Nothing left
  your machine" line, in one of three states: no stored session shows
  `redential login && redential submit`; a stored session with this exact
  bundle not yet uploaded shows `redential submit` only; a stored session
  with this exact bundle already uploaded shows nothing (re-submitting
  would send nothing new). "Already uploaded" is decided locally by a new
  `src/submission-record.ts` (`bundleContentHash` — a local, unsalted
  sha256 over the bundle with wall-clock-derived fields stripped —  plus
  `last-submission.json`, written by `submit` right after a successful
  upload, alongside `credentials.json`). See
  [docs/scan.md](docs/scan.md#closing-next-step-hint) and
  [docs/login-submit.md](docs/login-submit.md#where-the-token-lives). No
  schema change — the bundle payload itself is untouched, this is local
  CLI state only.
- Strengthened `submit`'s existing "not logged in" behavior with a test
  asserting the exact friendly message (`AuthError("Not logged in. Run
  \`redential login\` first.")`, no stack trace) rather than just its type.
- **Windows support, verified by CI.** `.github/workflows/ci.yml` now runs
  the full test suite on a matrix of `ubuntu-latest`/`macos-latest`/
  `windows-latest` × Node 20/22 (6 cells, `fail-fast: false`). Fixes and
  hardening that came out of auditing the codebase for this:
  - **Platform-appropriate config directory.** `config.ts`'s
    `DEFAULT_CONFIG_DIR` (shared by `credentials.json` and the device
    `salt`) is now derived per-platform from `os.homedir()`:
    `~/.config/redential` on macOS/Linux (unchanged),
    `%USERPROFILE%\AppData\Roaming\redential` on Windows (new — there is no
    prior Windows install to migrate from). Documented in
    [docs/login-submit.md](docs/login-submit.md#where-the-token-lives),
    including why the `0600` file mode is a no-op on Windows (NTFS has no
    POSIX permission bits) and what actually protects the token there
    (NTFS ACL inheritance from the user's own profile directory).
  - **CRLF-safe diff parsing.** `git.ts`'s `getCommitAddedLines` now
    normalizes `\r\n` to `\n` on the raw `git show` output before any
    parsing — a CRLF-authored file's added lines previously carried a
    trailing `\r` once split only on `\n`, which could perturb
    `import-detect.ts`'s line-anchored regexes (JS treats a bare `\r` as
    its own line terminator under the `m` flag). This can happen on any
    scanning OS, not just Windows. Covered by a new
    `test/git.test.ts` CRLF fixture test; `test/support/fixtures.ts`'s
    `createRepo` now pins `core.autocrlf=false` so fixture repos store
    bytes verbatim on every CI platform instead of a Windows runner's
    global `autocrlf=true` silently normalizing injected CRLF test content
    away before it reaches a diff.
  - **Plain-terminal fallback for the "wrapped" summary.** `summary.ts`
    gained a themed rendering path: `shouldUsePlainOutput` detects plain
    Windows `conhost` (no `WT_SESSION`/`TERM_PROGRAM`/`ConEmuANSI=ON`) and
    switches the TTY-only summary to a pure-ASCII, no-color theme instead
    of ANSI + Unicode box-drawing/block characters — same data, different
    rendering. Wired through `scan-command.ts`'s new `plain` option and
    computed once in `cli.ts`.
  - Confirmed `execFileSync("git", ...)` (no `shell: true`) and the
    `categorize.ts`/`churn-exclusions.ts` hardcoded `"/"` path-splitting
    need no change: git always reports paths `/`-separated regardless of
    host OS, and spawning a bare executable name without a shell resolves
    correctly via Windows' own PATH/PATHEXT search.
- README: supported-platforms line (macOS, Linux, Windows; Node 20/22).

## [0.1.0] - 2026-07-09

### Added
- **Automated release pipeline.** `.github/workflows/release.yml` publishes
  to npm only on a pushed `v*` tag (`npm ci && npm test && tsc --noEmit &&
  npm run build && npm publish --provenance --access public`, authenticated
  via the `NPM_TOKEN` secret) — never on `pull_request`, so a fork's PR can
  never see the token. `.github/workflows/ci.yml` runs `npm ci`, typecheck,
  test, and build on every PR (including from forks) and every push to
  `main`; it references no secrets at all. `package.json` hardened for
  publication: `repository`/`homepage`/`bugs` fields (required for npm's
  provenance UI to link a published version back to its source commit),
  `keywords`, and a `prepublishOnly` script (`npm test && npm run build`)
  as a last-line guard against a manual `npm publish` of stale/broken
  `dist/` output. `files` (already `["dist", "signatures",
  "taxonomy.json"]`) re-verified correct via `npm pack --dry-run` —
  `signatures/`/`taxonomy.json` are genuinely required at runtime for skill
  detection, not scope creep beyond `dist`. Added the Apache-2.0 `LICENSE`
  file at the repo root (canonical, unmodified text — the form GitHub's
  license detector expects). See [docs/releasing.md](docs/releasing.md)
  for the full release process, provenance verification, and what to do if
  a release fails mid-way.
- **Update notice — `login`/`submit` only, never `scan`.** After a
  successful `login` or a successful `submit` upload, a best-effort,
  non-blocking check against the public npm registry prints a one-line
  notice if a newer version of the CLI is available (`src/version-check.ts`,
  via a new `getJson` helper in `src/http-client.ts`). Fast-timeout and
  swallows every error by contract: it can never fail or delay the command
  it's attached to. Deliberately never wired into `scan-command.ts` —
  principle 1 ("`scan` makes ZERO network calls") is inviolable regardless
  of how harmless a given outbound call looks in isolation, so the notice
  only ever rides on `login`/`submit`, which already touch the network.
  `checkForUpdate` never references `fetch`/`http`/`https` directly (it
  goes through `getJson`), so `test/privacy/zero-network.test.ts`'s
  existing static allowlist alone couldn't have caught it being wired into
  `scan` by mistake — a review pass on this milestone flagged exactly that
  gap, so a new dedicated test was added asserting `version-check.ts` is
  only ever imported by `login.ts`/`submit-command.ts`, full stop. See
  [docs/login-submit.md](docs/login-submit.md)'s "Version check" section
  for the full boundary reasoning; reviewed as a sensitive-zone change
  before merging.
- **`scan`'s "wrapped" terminal summary.** When stdout is an interactive
  terminal, `scan` now prints a human-readable summary — total commits and
  span, an hour-of-day sparkline and weekday bar chart, top languages and
  categories, detected skills (or a teaser when none matched), ownership
  and signed-commit ratios, and a closing "Nothing left your machine"
  line — **after** the JSON bundle, under a divider (`src/summary.ts`).
  Printed last on purpose: the JSON scrolls up, and the summary is what's
  left on screen once the command finishes. If the signed-commit ratio is
  0%, the footer adds one more line nudging the user to sign their commits
  (`git config commit.gpgsign true`). Rendered with ANSI colors and
  box-drawing characters only — no new dependency — and is pure formatting
  over the bundle `runScan` already computed: no new data collection, zero
  network, nothing the JSON above it doesn't already contain. A new
  `--json` flag forces JSON-only output even on a terminal.
  Piped/redirected stdout is unaffected: `scan | jq` still gets only the
  raw bundle, byte-identical to before this summary existed
  (`test/scan-command.test.ts`'s byte-identical-output test).
  Documented in [docs/scan.md](docs/scan.md).

### Changed
- **Skill detection refactored to two tiers.** Previously every technology
  needed its own hand-written `signatures/*.json` regex file (48 of them).
  Now: **Tier 1** (`src/import-detect.ts` + `signatures/package-map.json`,
  465 entries) parses import statements across JS/TS, Python, Go, Ruby, and
  PHP, normalizes to a package name, and looks it up in a flat
  `{"package": "slug"}` map — for the common case where a bare import
  unambiguously identifies the technology, no regex needed at all. **Tier 2**
  (the signature-file format, now 15 files) remains only for what
  Tier 1 genuinely can't express: config-file-only tech (Docker, Terraform,
  Kubernetes, GitHub Actions — no import exists), an import shared
  ambiguously between two slugs (`@supabase/supabase-js` serves both
  `auth/supabase-auth` and `db/supabase`; `@xenova/transformers` serves both
  `ai/whisper` and `ai/huggingface`), and inheritance-based detection where
  the dependency isn't separately declared (Rails' Active Record, Laravel's
  Eloquent, both bundled with their framework). 37 of the original 48
  signatures collapsed into map entries (each package already had a real,
  unambiguous map alias); 4 new Tier 2 signatures were added:
  `db/activerecord` and `db/eloquent` for the inheritance case;
  `auth/firebase-auth` because `firebase`/`firebase-admin` are used for
  Firestore, Storage, and other Firebase products beyond auth — too
  ambiguous for a flat map entry, so it's detected by its distinctive
  `auth` sub-import (`firebase/auth`, `firebase-admin/auth`) and API calls
  (`signInWithEmailAndPassword(`, etc.) instead; and `backend/axum` because
  Rust isn't one of Tier 1's five supported language families — detected by
  its `use axum::` import and `axum::Router` API usage instead. `rails`
  (Ruby gem), `laravel/framework` (composer package), and `illuminate`
  (the first-segment PHP namespace `use Illuminate\...` resolves to, per
  the "PHP scope" tradeoff below) were added as ordinary Tier 1 map
  entries, since all three are unambiguous declared or inherited
  dependencies. See `docs/signatures.md` for the full design and
  contribution guide.
  - `taxonomy.json` extended 48 → 113 slugs (`auth/lucia`, `auth/passport`,
    `auth/firebase-auth`, `auth/workos`, `auth/devise`; `payments/lemonsqueezy`,
    `payments/paddle`; ten new `db/*` slugs including `db/sqlalchemy` and
    `db/gorm` — genuinely missing major ORMs, added per "extended as
    needed"; nine new `ai/*` slugs (Ollama, Replicate, Groq, Gemini,
    Cohere, Pinecone, Weaviate, Chroma, Mistral); eight new `frontend/*`,
    eight new `backend/*`, three new `infra/*`, six new `queues/*`, three
    new `observability/*`, three new `testing/*`; and three new categories,
    `email/*`, `storage/*`, `realtime/*`. Version bumped 1.1.0 → 1.2.0
    (additive; still no bundle schema change — `detected_skills`' shape was
    already declared).
  - Closed-vocabulary enforcement now covers Tier 1 too: `detectSkills`
    throws if any package-map value isn't a `taxonomy.json` member, inside
    the same call path `runScan` uses (not a standalone check) — same
    pattern as the existing per-signature check.
  - **Pattern-quality lessons from the signature-file era carried forward
    explicitly** (documented in `docs/signatures.md`'s "Pattern discipline"
    section): a prior review pass found 11 real false positives from
    generic verbs shared across an ecosystem (`app.get(` misattributing
    Fastify to Express, `.upsert(` misattributing Prisma to a vector
    database, `toMatchSnapshot(` misattributing Vitest to Jest, etc.) — the
    four new Tier 2 signatures and every Tier 1 map entry were written
    against that same discipline (anchor on the distinctive import
    specifier; never a generic verb alone).
  - New tests: `test/import-detect.test.ts` (32 cases — 5 languages ×
    positive imports, plus mandatory near-miss negatives: comments, plain
    strings, markdown code blocks, package names inside URLs, all proven
    NOT to match), `test/package-map.test.ts` (≥400-entry floor, every
    value is a real taxonomy member, correct slug shape, no duplicate keys
    — checked against the raw file text, since `JSON.parse` silently drops
    a literal duplicate key rather than erroring). `test/scan.test.ts`
    gained a multi-commit aggregation test (`commit_count` counts distinct
    matching commits correctly across non-consecutive commits) and a
    performance test (300-commit fixture repo scans in under 30 seconds;
    measured ~12s).
  - Re-verified against a real repo (redence): 10 skills detected, all
    plausible for a Next.js/Supabase/Anthropic/Resend app, including one
    the old signature-only system never caught at all (`email/resend` — no
    prior signature existed for it). `frontend/react`'s count dropped from
    47 to 33 and `frontend/nextjs` rose from 38 to 39 — both are honest
    consequences of Tier 1 counting fresh imports only, not (as the old
    signature did) any commit reusing an already-imported hook/subpath
    without re-adding the import line; not a regression.

### Added
- **Skill detection**: `detected_skills` is no longer always `[]` —
  `scan` now matches the selected author's own commits (added diff lines,
  read locally via `git show`, never leaving the machine) against a new
  versioned signature database, `signatures/*.json`
  (`src/skill-detect.ts`, `docs/signatures.md`). Zero network, no LLMs, per
  principle 3 ("Bounded output"). Closed vocabulary is enforced in code,
  not just documented: a signature naming a slug outside `taxonomy.json`
  makes `detectSkills` throw before `runScan` can ever construct a bundle
  — proven by a real-call-path privacy test
  (`test/privacy/skill-detection-taxonomy.test.ts`), not a standalone unit
  test of the check in isolation.
  - Scope: the original ask mentioned "~150 libraries"; `taxonomy.json`
    already had a placeholder set of 38 slugs ("to be expanded", per this
    file's own history). Extended it to 48 (10 new: `auth/clerk`, 4 new
    `ai/*` slugs — `langgraph`, `llamaindex`, `vercel-ai-sdk`, `whisper` —
    and two new categories, `queues/*` and `observability/*`) and wrote one
    signature per slug, rather than fabricating ~100 more without real
    fixtures behind them. `taxonomy.json` bumped to `1.1.0` (additive; no
    bundle schema change, since `schema/bundle.v1.json`'s `detected_skills`
    shape was already declared — populating it isn't a shape change).
  - Every signature carries its own `fixtures.positive`/`fixtures.negative`
    (synthetic diffs) directly in the JSON file — one generic test
    (`test/skill-detect.test.ts`) loads every `signatures/*.json` and
    mechanically enforces: every positive fixture matches, no negative
    fixture matches, every declared pattern is exercised by at least one
    positive fixture (catches dead/typo'd regexes), and at least one
    negative fixture is a genuine near-miss mentioning the library by name
    (not just unrelated text) — this is what makes "contribute a signature
    via PR" (`docs/signatures.md`) self-checking.
  - Excludes the same paths already excluded from churn (lockfiles,
    minified bundles, build output, single-commit generated dumps —
    `src/churn-exclusions.ts`) and skips merge commits (consistent with
    `getAllCommits`' own `--numstat`, which already emits nothing for
    them) — a vendored dependency's content matching an import pattern
    would be a false "you wrote this" signal.
  - `detected_skills` is sorted by slug for deterministic, byte-identical
    output across repeated scans of the same history (principle 4,
    "User-reviewed").
  - Ships as data files, not code: `signatures/` and `taxonomy.json` are
    now in `package.json`'s `files` array (verified via `npm pack
    --dry-run`) so they're present on disk next to `dist/` after
    `npm install -g @redential/cli` — the CLI didn't read either file at
    runtime before this milestone.

### Changed
- `languages`/`categories` churn computation now excludes checked-in
  artifacts that aren't authored work: known lockfiles
  (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lockb`),
  `*.min.js`, anything under a `dist/`/`build/`/`.next/`/`node_modules/`
  directory, and a new heuristic — a path whose entire churn (within the
  selected author's commits) is a single commit adding 1,000+ lines, never
  touched again, which is almost always a vendored/generated dump rather
  than hand-authored code (`src/churn-exclusions.ts`). Without this, a
  single dependency-install or build-output commit could dwarf months of
  real work and dominate every share — this was visible in a real bundle
  as `other` at 36% and `.json` at 19%, almost entirely lockfile/generated
  noise. Excluded churn is removed from both the numerator and denominator
  of every share (the file behaves as if it never existed for this
  computation), not merely reclassified as `other`. No schema shape change
  (`schema/bundle.v1.json`'s `languages`/`categories` definitions are
  unchanged — this only changes which files count, not the field shapes),
  so no version bump. Documented as part of the measurement contract in
  `docs/schema.md`.
- `scan`'s interactive author selection (`promptAuthors`): with a single
  candidate identity, replaced the numbered list with a Y/n confirmation
  ("Found 1 identity: you@example.com (12 commits). Is this you? (Y/n)"),
  Y as the default — pressing Enter accepts. The numbered list stays for
  2+ candidates, where there's no single obvious default to pick.
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
  regression guard CLAUDE.md mandates ("Secret-scan of the PAYLOAD before
  any output/submit"), wired into `runScan` itself. Never echoes the
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
