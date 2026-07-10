# Bundle schema — field by field

The bundle is the ONLY thing that ever leaves the user's machine. This doc
explains every field: what it measures, why it exists, and what it does NOT
contain. Schema: `schema/bundle.v1.json` (JSON Schema, `additionalProperties:
false` everywhere — unknown fields are invalid by design).

## Top level

| Field | What | Why |
|---|---|---|
| `schema_version` | `"1.0.0"` | The schema is the trust contract; the version pins it |
| `runner` | `local` \| `ci` | Local scans are user-controlled (weakest tier). CI scans (future) run in employer infrastructure and can carry an OIDC anchor |
| `tool_version` | CLI version | Reproducibility of the analysis |
| `created_at` | Scan timestamp | Freshness |

## `repo`

- `host_type` — only the KIND of host ("github"). Never the URL, org, or
  repo name. The employer name is a separate claim the user makes in the
  Redential UI, clearly labeled as unverified.
- `age_days` — the repo's TRUE root commit to now. Always the whole repo's
  age, even when `scan --since <spec>` limits the WALK to a recent window
  (see docs/scan.md#huge-repositories-and---since) — this field answers
  "how old is this repo", never "how old is the analyzed window".
- `repo_fingerprint` — salted hash of the root commit sha. The server can
  detect the same repo being re-submitted (consistency) without ever knowing
  which repo it is. Also always the true root, unaffected by `--since`.

## `identity`

- `author_identity_hashes` — the user explicitly selects which author
  emails are theirs during `scan`; only salted hashes are included. Other
  contributors are never identified in any form.
- `other_contributors_count` — an aggregate count, nothing else. Counted
  only among commits in the analyzed window (see `commits` below) when
  `--since` is set — narrower disclosure, not broader.

## `commits`

Volume (`user_total`), span (`first_at`, `last_at`, `span_days`) and cadence
(`hour_histogram` 24 buckets UTC, `weekday_histogram` 7 buckets). The
histograms double as a behavioral fingerprint: they can be compared against
the same user's verified public activity as a soft authenticity anchor.

**`--since <spec>` and this section.** `scan --since <spec>` (relative:
`2years`/`18months`/`30days`; absolute: `2024-01-01`) limits the commit
WALK to that window — see docs/scan.md#huge-repositories-and---since for
the full CLI-facing behavior. No new bundle field exists for this: every
field above simply reflects the analyzed window instead of full history —
`user_total` counts only windowed commits, `first_at`/`last_at`/`span_days`
bound the window, and the histograms only tally windowed commits. This is
narrower disclosure than a full scan, never fabricated or hidden history —
`repo.age_days` and `repo.repo_fingerprint` stay window-independent (see
`repo` above) specifically so a windowed scan can never be mistaken for
"this repo is only N days old".

## `signed`

Count and ratio of cryptographically signed commits (GPG/SSH/x509). The
strongest local signal, because signatures cannot be forged retroactively
without the key.

A commit counts as signed only when git reports its signature status
(`%G?`) as `G` — a good signature that verifies against a known key. Every
other status is treated as unsigned, deliberately:

- `U` (good signature, but the key isn't trusted/matched) and `E` (can't be
  checked, e.g. no matching key available) mean the crypto operation itself
  never actually confirmed anything — the raw signature bytes can be
  present in the commit object without git ever having validated them.
- `B` (bad signature) means the signature explicitly failed verification.
- `X`/`Y`/`R` (expired signature / expired key / revoked key) mean the
  signature was valid under conditions that no longer hold.

Counting any of these as "signed" would let a fabricated or unverifiable
signature masquerade as a strong trust signal. `G` is the only status where
git has actually verified the signature against a key it recognizes.

## `languages`

Share of churn by file EXTENSION only (`.ts`, `.py`). Never file names.

## `categories`

Churn share per technical category (`auth`, `payments`, `infra`, `frontend`,
`backend`, `data`, `testing`, `ai-workflow`, `docs`, `other`). The category
is inferred locally from paths BEFORE hashing — the inference result
survives, the path does not. `ai-workflow` detects agent-assisted
development signals (Co-Authored-By trailers, presence of agent config
files) as counts/booleans only.

### What is excluded from churn

Both `languages` and `categories` are computed only over churn that survives
this exclusion list (`src/churn-exclusions.ts`) — part of the measurement
contract, not an implementation detail, since it changes what a commit's
"weight" means. Without it, one `npm install` or a checked-in build artifact
can dwarf months of actually authored code and dominate every share.

- **Known lockfiles**, matched by exact basename regardless of directory:
  `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lockb`.
- **Minified JS**: any path ending in `.min.js`.
- **Build-output directories**: any path with `dist/`, `build/`, `.next/`,
  or `node_modules/` as a full path segment (not a substring — a directory
  literally named `redistribute/` is not excluded).
- **Heuristically generated files**: a path whose entire churn — within the
  selected author's own commits — is exactly ONE commit that added at least
  1,000 lines (`GENERATED_FILE_MIN_ADDED_LINES`), with no commit touching it
  before or after. A single huge add with no ongoing history is almost
  always a vendored dependency, a generated client, or a one-time codegen
  dump that happened to get committed — not hand-authored work. This is a
  per-scan heuristic over the author's own commit set, not a repo-wide fact
  (a legitimately huge one-off refactor commit that's never touched again
  would also match — the tradeoff favors not letting a generated dump
  inflate the numbers over perfectly classifying every edge case).

Excluded churn is removed from BOTH the numerator and the denominator of
every share — it's as if the file never existed for this computation, not
merely reclassified as `other`.

## `detected_skills`

Skills detected from the user's commits, e.g.:

```json
{ "slug": "payments/stripe", "commit_count": 12,
  "first_seen": "2024-03-01T10:00:00Z", "last_seen": "2025-11-20T18:30:00Z" }
```

How detection works, and why it is safe to have in the bundle:

- **Local reads, bounded output.** Detection reads diff contents via
  `git show`/`git diff` — on the user's machine only, with ZERO network
  calls, no LLMs — and matches them against deterministic signatures
  (`signatures/*.json` in this repo: imports, config files, per-library API
  patterns). See principle 3 ("Bounded output") in
  [principles.md](principles.md).
- **Closed vocabulary.** `slug` MUST be one of the entries in
  [`taxonomy.json`](../taxonomy.json) (public, versioned in this repo). Any
  slug outside that list makes the bundle invalid. The taxonomy is the
  complete, enumerable universe of what detection can ever report.
- **No evidence payload.** Per skill, only `commit_count`, `first_seen` and
  `last_seen` — never the matched lines, file names, or any excerpt.
- May be an empty array (no signatures matched); the field is always
  present.

## `ownership`

`user_commit_ratio` — the user's share of total commits. Aggregate only.
Computed over the analyzed window when `--since` is set (see `commits`
above), same as `identity.other_contributors_count`.

## `integrity`

`merkle_root` over the user's commit shas (sha256). Enables future
re-verification ("does today's repo state still contain the commits you
attested last year?") without revealing a single sha.

## `attestation`

Records that the user confirmed "I am authorized to analyze this repository"
and when. The confirmation is part of the payload, not just a UI gate.

## What is deliberately absent

No source code. No diffs (they are read locally for skill detection, but
never leave the machine — only closed-vocabulary slugs do). No file or
directory names. No commit messages. No other contributors' names or emails.
No remote URLs. No branch names. No secrets (a secret-scan runs over the
serialized payload and blocks on match). If you need one of these for a
feature, the answer is no — redesign the feature.
