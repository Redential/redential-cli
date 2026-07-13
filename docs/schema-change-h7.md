# Schema change H7 — structural evidence on `detected_skills[]`

This document is the prior discussion record CLAUDE.md requires for any
change to WHAT data leaves the machine ("any change to WHAT data leaves
the machine requires: (1) a prior discussion issue, (2) a schema version
bump, (3) an entry in docs/schema.md and CHANGELOG.md"). This repo has a
single owner rather than a public issue tracker for this kind of decision,
so this file plays that role: the proposal, the reasoning, and the exact
contract, written down before the schema itself changes.

The proposal was drafted, deliberately unimplemented, in
[docs/proof-graph-spike.md](proof-graph-spike.md#draft-bundle-signal-not-implemented)
during the `proof-graph-spike` branch's H1–H5 milestones and carried a GO
recommendation. H7 is that milestone: landing it for real.

## What changes

Two new **optional** fields on each entry of `detected_skills[]`:

- `evidence`: `"import"` | `"structural"`
- `confidence`: `"direct"` | `"inferred"`

Both are closed enums. No free text, no third value, no way to express
anything outside these four literals across the two fields. `required[]`
for `detected_skills[]` items is unchanged — `slug`, `commit_count`,
`first_seen`, `last_seen` stay mandatory; `evidence`/`confidence` are
additive and optional.

## Why

Today, `detected_skills[]` entries all come from the same detection tier:
a package name or config file matched in an added line of a diff (see
[docs/signatures.md](signatures.md)). That is precise but shallow — it can
say "this commit imported `stripe`," never "this commit actually wired a
verified webhook handler." The proof-graph spike (see
[docs/proof-graph-spike.md](proof-graph-spike.md)) built a second,
independent tier: it follows connected relations in the code — a function
that verifies a Stripe webhook signature, feeding a database write, guarded
by an idempotency check — and only claims the skill when that whole shape
is actually present and reachable, not merely imported somewhere.

`evidence`/`confidence` let the bundle say which tier produced a given
entry, and how directly. That turns "touched stripe" into "built a
verified payment webhook flow" for the entries that earn it — a stronger
claim than plain import matching, while staying exactly as bounded as
every other field in the bundle: still a closed-vocabulary label, never a
path, a function name, or any excerpt of the matched code.

## The exact contract

- `evidence: "import" | "structural"` — which detection tier produced this
  entry.
- `confidence: "direct" | "inferred"` — for a `"structural"` entry, how
  directly the connected shape was found: `"direct"` (same function, else
  same file) or `"inferred"` (connected across files, within a bounded
  search).
- Both fields are **closed enums**. No free-form text is ever accepted by
  the schema for either field — `additionalProperties: false` on the
  `detected_skills[]` item object, plus enum-only value sets, make any
  other string invalid.
- **`AMBIGUOUS` findings are never emitted.** The proof graph's internal
  classification for a finding is one of `DIRECT` / `INFERRED` /
  `AMBIGUOUS` (see `src/proof-graph/infer.ts`). Only `DIRECT` and
  `INFERRED` ever produce a bundle entry — `AMBIGUOUS` means the skill is
  not claimed in the bundle at all, full stop. There is no bundle
  representation of "maybe" and none is ever added; the only place an
  `AMBIGUOUS` classification is visible anywhere is local, on-screen
  feedback from `redential explain`, which never writes a file or makes a
  network call.
- **Unattributed findings are never emitted.** A structural finding only
  becomes a bundle entry when it attributes to the user's own commits
  (mirroring how every other tier already works — see "implementation
  decision (b)" below). A structurally-present-but-unattributed shape
  produces no entry, the same way an import match in someone else's commit
  produces no entry today.
- **Nothing else graph-derived may ever enter the bundle.** No file paths,
  no function names, no node or edge counts, no adjacency information, no
  excerpt of the matched code — `evidence` and `confidence` are the entire
  surface the proof graph is allowed to expose outward. This is a hard
  ceiling, not a starting point for future graph fields; any future
  proposal to add more graph-derived data goes through this same ceremony
  again, starting from a fresh discussion record, not by amendment to this
  one.

## Backward compatibility

The bump is `schema_version` **`1.1.0` → `1.2.0`** (minor — see "Schema
version bump" below for what the `const` semantics actually mean here).

Precisely stated, because "backward compatible" can hand-wave:

- A **1.2.0 bundle without `evidence`/`confidence`** (i.e., every entry
  produced by import-tier detection, or a client that predates this
  change) is **fully valid** against the 1.2.0 schema. The fields are
  additive and optional — nothing about the required shape of an entry
  changed.
- **No consumer that understood 1.1.0 payloads breaks on their absence.**
  A server-side (or any other) consumer written against the 1.1.0 contract
  never expected these fields to exist; a 1.2.0 bundle that happens to omit
  them is byte-for-byte indistinguishable, on the `detected_skills[]`
  items it emits, from a 1.1.0 bundle. Nothing that already worked stops
  working.
- What is **not** backward compatible, and is not claimed to be: the
  `schema_version` field is a JSON Schema `const`, so a validator pinned
  to the literal 1.1.0 schema will reject a 1.2.0 bundle purely on the
  version string mismatch — even one that carries neither new field. That
  is by design (the `const` is what lets a consumer trust the version
  string at all) and is exactly why this is a schema **version bump** and
  not a silent, unversioned addition. "Backward compatible" in this
  document means the 1.2.0 *shape* is a superset of the 1.1.0 shape, not
  that a 1.1.0-pinned validator can be pointed at 1.2.0 data unchanged.

The `$id`/title (`bundle.v1.json`, "Redential proof bundle v1") are
unchanged: `v1` names the major schema family, and this is a minor bump
within that family, not a break.

## Trust framing (principle 6)

The two enums' meaning is not asserted on faith: it is backed by the same
public-methodology guarantee every other bundle field relies on. Detection
is open source in this repo (`src/proof-graph/*.ts`, `signatures/*.json`),
runs entirely locally with zero network calls, and any reviewer — the
bundle's recipient included — can re-derive the same classification for
any slug by running `redential explain <skill>` against the same repo
state. This keeps the structural signal inside principle 6's "Honest about
trust" framing exactly like every other local signal: it is falsifiable
(a forged history could in principle be built to match a pattern, the same
caveat that already applies to `commits`/`categories`/`languages`), so it
stays inside the WEAKEST tier ("Attested"), never promoted to a stronger
label, and never mixed visually with a server-verified tier. `evidence`/
`confidence` make an Attested claim more legible, not a stronger class of
claim.

## Implementation decisions (orchestrator)

Two decisions were made when landing this change that are not visible from
the field contract alone, recorded here for anyone reading this file as
the change's history:

**(a) Only `"structural"` entries carry the fields in this version.** An
entry produced by plain import matching omits both `evidence` and
`confidence` entirely, rather than emitting `evidence: "import"`
explicitly. The `"import"` enum value exists in the schema and is valid to
receive, but nothing in this version's detection path emits it — it is
reserved for a future change that would tag import-tier entries
explicitly (e.g. if a consumer ever needs to distinguish "known
import-tier" from "predates this schema version" for entries that omit
the field). Until that future change lands, "absent" and `"import"` are
meant to be read identically: import-tier.

**(b) A structural entry's `commit_count`/`first_seen`/`last_seen` derive
from the user's commits whose added lines touched the finding's
anchor-bearing files.** This mirrors Tier 1 (import-tier) semantics
exactly: those three fields have always meant "commits that added the
evidence," never "commits since the code has existed" or "commits that
merely touched the file for unrelated reasons." For a structural finding,
"the evidence" is the set of files carrying the anchors the proof graph
connected (the webhook handler, the DB write, the idempotency guard) —
so the count and date range are computed the same deterministic way as
every existing skill entry, just over a different (and still local, still
diff-content-only) file set. No new kind of date or count semantics is
introduced by this change.
