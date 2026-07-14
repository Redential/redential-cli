# Bundle schema — field by field

The bundle is the ONLY thing that ever leaves the user's machine. This doc
explains every field: what it measures, why it exists, and what it does NOT
contain. Schema: `schema/bundle.v1.json` (JSON Schema, `additionalProperties:
false` everywhere — unknown fields are invalid by design).

## Top level

| Field | What | Why |
|---|---|---|
| `schema_version` | `"1.2.0"` | The schema is the trust contract; the version pins it |
| `runner` | `local` \| `ci` | Local scans are user-controlled (weakest tier). CI scans (future) run in employer infrastructure and can carry an OIDC anchor |
| `tool_version` | CLI version | Reproducibility of the analysis |
| `created_at` | Scan timestamp | Freshness |

### Version note (1.1.0 → 1.2.0)

`1.2.0` adds two optional fields to `detected_skills[]` entries
(`evidence`, `confidence` — see that section below). Precisely what
"backward compatible" means for this bump: a 1.2.0 bundle that omits both
fields (every import-tier entry, and every bundle from before this change)
is fully valid against the 1.2.0 schema, and no consumer that only
understood the 1.1.0 shape breaks on their absence — the fields are purely
additive. What does NOT carry over is validating a 1.2.0 bundle against a
validator pinned to the literal 1.1.0 schema: `schema_version` is a JSON
Schema `const`, so that mismatch is rejected on the version string alone,
by design. Full rationale and the exact field contract:
[docs/schema-change-h7.md](schema-change-h7.md).

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
- **No evidence payload.** Per skill, only `commit_count`, `first_seen`,
  `last_seen`, and — since 1.2.0 — the two optional fields below. Never
  the matched lines, file names, or any excerpt.
- May be an empty array (no signatures matched); the field is always
  present.

### `evidence` / `confidence` (since schema 1.2.0)

Two optional fields, added alongside the structural detection tier (see
[docs/proof-graph-spike.md](proof-graph-spike.md) for how that tier
works and [docs/schema-change-h7.md](schema-change-h7.md) for the full
discussion record and exact contract):

```json
{ "slug": "payments/payment-webhook-flow", "commit_count": 4,
  "first_seen": "2025-01-10T09:00:00Z", "last_seen": "2025-06-02T14:20:00Z",
  "evidence": "structural", "confidence": "direct" }
```

- `evidence`: `"import"` | `"structural"` — which detection tier produced
  the entry. `"structural"` means the slug was verified by following
  connected relations in the code (anchors + call-graph reachability),
  not a single matched import line. In this version, only `"structural"`
  entries carry the field at all; an absent field means an ordinary
  import-tier match, exactly like every 1.1.0 bundle. `"import"` is a
  valid enum value, reserved for a future change that would tag
  import-tier entries explicitly.
- `confidence`: `"direct"` | `"inferred"` — present only alongside
  `evidence: "structural"`. `"direct"` means the connected shape was
  found in the same function or file; `"inferred"` means it was found
  across files, within a bounded search.
- Both are **closed enums** — no free text is ever valid for either
  field, enforced by the schema (`enum`, plus `additionalProperties:
  false` on the item object).
- **`AMBIGUOUS` findings are never emitted.** The proof graph's internal
  classification is `DIRECT` / `INFERRED` / `AMBIGUOUS`; only the first
  two ever produce a bundle entry. `AMBIGUOUS` means the skill is not
  claimed in the bundle at all — there is no bundle representation of
  "maybe." The only place an `AMBIGUOUS` classification is ever visible
  is local, on-screen feedback from `redential explain <skill>`, which
  writes nothing to disk and makes no network call.
- **Unattributed findings are never emitted.** A structural finding only
  becomes a bundle entry when it attributes to the user's own commits,
  the same rule every other skill entry already follows.
- **Nothing else graph-derived can ever appear.** No paths, no function
  names, no node/edge counts, no adjacency data. `evidence` and
  `confidence` are the entire surface the proof graph exposes outward.
- A structural entry's `commit_count`/`first_seen`/`last_seen` are
  computed the same deterministic way as any other skill entry: from the
  user's commits whose added lines touched the finding's anchor-bearing
  files (the files carrying the connected shape the proof graph found),
  mirroring import-tier semantics — these three fields have always meant
  "commits that added the evidence."

## `ownership`

`user_commit_ratio` — the user's share of total commits. Aggregate only.
Computed over the analyzed window when `--since` is set (see `commits`
above), same as `identity.other_contributors_count`.

## `integrity`

`merkle_root` over the user's commit shas (sha256). Enables future
re-verification ("does today's repo state still contain the commits you
attested last year?") without revealing a single sha.

### `date_forensics` (measurement contract)

Every git commit carries two independent dates: the **author date** (when
the change was originally written — this is what `commits.first_at`,
`last_at`, and the hour/weekday histograms above are all built from) and
the **committer date** (when the commit object currently in the repo was
actually written — set to the author date on an ordinary `git commit`, but
left untouched by an amend, rebase, `filter-branch`, or cherry-pick, and
set to merge time by most platforms' squash-merge). Everything above this
subsection is author-date only; `date_forensics` is the first (and only)
place a committer date reaches the bundle, and only as four aggregates —
never a per-commit value:

```json
"date_forensics": {
  "author_span_days": 1140,
  "committer_span_days": 0,
  "mismatch_ratio": 0.95,
  "committer_burst_ratio": 1.0
}
```

- `author_span_days` / `committer_span_days` — `max - min` (days) over the
  user's commits, computed independently for each date. Same population as
  `commits.*` (merges included, `--since`-windowed the same way — see the
  `--since` note under `commits` above; `date_forensics` is computed over
  the walked window, not full history, exactly like every other
  window-scoped field).
- `mismatch_ratio` — fraction of the user's commits whose committer date
  differs from its own author date by more than 48h.
- `committer_burst_ratio` — fraction of the user's commits whose committer
  date falls inside the single densest 24h window of committer dates
  (a sliding-window max, not a fixed calendar day).

**Why it exists.** A replayed history — fabricate commit timestamps in a
fresh repo, the scenario the README FAQ's "can't I replay someone else's
git history" answer already addresses — can forge author dates freely, but
a naive replay script (rewrite years of fabricated history in one sitting)
leaves a second, independent signature: the fabricated author dates still
span years, while the committer dates — the actual moment each commit
object was written to disk — collapse into the single sitting the script
ran in. That shows up as large `author_span_days`, near-zero
`committer_span_days`, and both ratios near `1.0`, together.

**What "normal" looks like.** An organic history has committer dates that
track author dates closely (`mismatch_ratio` near 0, occasional rebases
nudge it up) and a `committer_span_days` that tracks `author_span_days`
(both reflect the same real elapsed time), so `committer_burst_ratio`
reflects ordinary commit cadence — well below `1.0` for any history longer
than about a day.

**Known non-incriminating shapes — these fields must be read jointly, never
threshold in isolation:**

- `committer_burst_ratio` is *degenerately* near `1.0` for any repo whose
  entire walked history genuinely fits inside ~24h — a brand-new repo, a
  hackathon project, or a narrow `--since` window. It's only meaningful
  conditioned on `author_span_days` also being large; a small
  `author_span_days` alongside a high burst ratio just means "young/short
  history", not a replay.
- `mismatch_ratio` fires routinely on ordinary squash-merge and
  long-lived-PR workflows, since the merging platform sets the committer
  date to merge time regardless of when the change was authored. A high
  `mismatch_ratio` alone is not incriminating — the replay signature is
  high `mismatch_ratio` **and** large `author_span_days` **and**
  near-zero `committer_span_days`, all three together.

**This is a HEURISTIC signal for server-side scoring, not a local
verdict.** `scan`/`submit` never fail, warn, or block based on these
values — the CLI computes and reports them, exactly as it does every other
`integrity`/`commits` field, and makes no judgment. Scoring what a given
combination of values means is entirely a server-side decision outside
this repo.

## `attestation`

Records that the user confirmed "Confirm you are authorized to analyze this
repository." (the prompt defaults to N — an explicit `y` is required) and
when. The confirmation is part of the payload, not just a UI gate.

## What is deliberately absent

No source code. No diffs (they are read locally for skill detection, but
never leave the machine — only closed-vocabulary slugs do). No file or
directory names. No commit messages. No other contributors' names or emails.
No remote URLs. No branch names. No secrets (a secret-scan runs over the
serialized payload and blocks on match). If you need one of these for a
feature, the answer is no — redesign the feature.
