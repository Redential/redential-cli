# Proof graph spike

This is an EXPERIMENTAL spike. It lives entirely on branch
`proof-graph-spike` and is never merged into `main` or released without an
explicit go decision from the owner. Nothing described here ships, changes
the bundle schema, or affects `scan`/`submit` on `main` unless and until
that decision is made — this doc records the spike's scope so the decision
can be made on real evidence.

## Goal

Today, skill detection (see [docs/signatures.md](signatures.md)) is
import-based: a package name in an added line maps, deterministically, to a
taxonomy slug. That is precise but shallow — it can say "this commit
imported `stripe`," not "this commit actually wired a webhook handler."

This spike evaluates a structural alternative: instead of matching a single
line, follow connected relations in the code (a function that verifies a
Stripe webhook signature, feeding a database write, guarded by an
idempotency check) and infer a skill from that shape, with evidence for
why it was inferred.

The spike is deliberately narrow: ONE language (TypeScript) and ONE area
(payments — Stripe webhook verification → DB write → idempotency guard),
producing exactly one closed-vocabulary slug:
`payments/payment-webhook-flow`. The question the spike answers is whether
structural inference is worth the added complexity compared to import
matching — not to build a general-purpose code-understanding engine.

## Approved decisions

1. **Parser = the TypeScript compiler API (the `typescript` package),
   behind a `ParserAdapter` layer. NOT tree-sitter, NOT wasm.**
   Rationale: zero new dependencies and zero binary blobs in a
   trust-focused public repo — every third-party PR reviewer should be able
   to audit what's parsing the user's code without adding a new
   supply-chain surface. The spike's actual question ("does structural
   inference beat import matching?") is parser-agnostic — it doesn't depend
   on which parser produces the AST. Putting the TypeScript compiler API
   behind an adapter keeps a future tree-sitter migration, if and when a
   second language arrives and a single multi-language parser becomes
   worth the dependency discussion, down to hours of adapter-swapping
   rather than a rewrite.

2. **The structural signal stays OUT of the bundle for the whole spike.**
   Zero changes to `schema/bundle.v1.json`, `src/build-bundle.ts`, or
   `submit`. The spike ships only a documented draft of what the future
   signal could look like (see below) — never a working code path that
   writes it into a real bundle. This is intentional: CLAUDE.md requires a
   prior discussion issue, a schema version bump, a `docs/schema.md`
   entry, a `CHANGELOG.md` entry, and new privacy tests for any change to
   WHAT data leaves the machine. That ceremony is real work with real
   review cost, and doing it before the spike has evidence that structural
   inference is worth shipping would be backwards. It is DEFERRED until an
   explicit go decision.

## Invariants

These hold for the whole spike, unconditionally:

- **Zero network** — identical to `scan` today. The graph is built and
  walked entirely from a local `git show`/`git diff` read.
- **Zero LLM, deterministic** — the same commit produces the same graph and
  the same classification every time. No remote inference, no sampling.
- **In-memory only** — the graph lives only in memory for the duration of
  the process and dies with it. It is never serialized to disk, never
  written to `scan` output, and never included in the bundle.
- **Closed vocabulary** — the only slug the spike can ever infer is
  `payments/payment-webhook-flow`, and only because that slug is present in
  `taxonomy.json`. No skill inference of any kind can name a slug outside
  the taxonomy.

## Scope and milestones

- **H0** — branch, slug, this doc.
- **H1** — parser adapter (`ParserAdapter` wrapping the TypeScript compiler
  API) + a HEAD snapshot reader + an in-memory graph structure.
- **H2** — anchor recognizers for the three nodes (webhook signature
  verification, DB write, idempotency guard) + `DIRECT` / `INFERRED` /
  `AMBIGUOUS` classification of the connected shape + user attribution by
  file intersection with the selected author's commits. Hard timebox: if
  binding resolution (tracing which variable flows into which call) proves
  unreliable within the milestone's timebox, degrade to a coarser signal —
  module co-location plus import edges — and document that degradation
  here rather than letting the milestone run long chasing precision.
  Outcome: full receiver resolution (see `src/proof-graph/anchors.ts`'s
  `resolveReceiver`) shipped as originally planned for every recognizer. The
  one narrow, documented fallback to file-level import co-location is
  scoped ONLY to supabase/knex DB-writes, because their common calling
  idiom (`supabase.from('orders').insert(...)`, `knex('users').insert(...)`)
  invokes the table selector as a function, which collapses to a wildcard
  chain segment in the parser's syntactic model (`chainOf`'s "*" convention
  — see `parser-adapter.ts`) and leaves no root name for `resolveReceiver`
  to resolve. The blanket degradation the timebox above allowed for
  ("module co-location plus import edges" for everything) was NOT needed.

  ### Attribution rule (H2)

  A structural finding (`src/proof-graph/infer.ts`) is only ever `claimed`
  when at least one of the anchor-containing files that support it
  intersects the selected author's own added-lines file set — the same
  diff-based primitive `scan` already uses for skill detection
  (`getCommitsAddedLines`, batched the same way as
  `skill-detect.ts`'s `detectSkills`), never `git blame`. This is
  deliberately file-level, not function-level, matching the Exclusions
  section's "No per-function blame": the question asked is "did the user's
  own diff touch this file," not "which line did they write." An
  `AMBIGUOUS` finding computes attribution the same way but never claims
  regardless of the result (see `StructuralFinding.claimed`'s own comment)
  — attribution only ever upgrades a `direct`/`inferred` finding from
  unclaimed to claimed, it never changes an ambiguous finding's status.
- **H3** — programmatic tmpdir fixtures (git repos built in test setup, per
  CLAUDE.md's testing conventions — never committed fixtures with real
  history), including the deliberate false-negative case: Stripe imported
  but structurally unused (no signature verification call reachable from
  the webhook handler) classifies as `AMBIGUOUS` and the skill is NOT
  claimed.
- **H4** — a local-only `redential explain <skill>` command surfacing the
  classification and evidence for inspection. Local only — no network, no
  effect on `scan`/`submit`.
- **H5** — final report: what worked, what didn't, the draft bundle signal
  below evaluated against real fixtures, and a go/no-go recommendation for
  the owner.

### Local explain command (H4)

`redential explain <skill>` prints a local, human-readable breakdown of the
structural tier's classification for one HEAD snapshot — no network call, no
file written anywhere, no `--json`/machine-readable mode.

Usage:

```
redential explain payments/payment-webhook-flow [--repo <path>] [--author <email> ...]
```

`<skill>` must be a slug in `taxonomy.json`. Originally (H4), only
`payments/payment-webhook-flow` (`STRUCTURAL_SKILL_SLUG`,
`src/proof-graph/infer.ts`) was explainable — the spike's one target shape at
the time. As of H6 (see "Multi-provider expansion (H6)" below),
`explain`'s gate is generalized: any slug present in
`STRUCTURAL_PATTERNS` (`src/proof-graph/infer.ts`) is explainable, which is
now all 6 structural patterns (Stripe, PayPal, Mercado Pago, Lemon Squeezy,
Paddle, IAP/RevenueCat) — the pattern table itself is the source of truth
for "which slugs does `explain` cover," not a single hardcoded name. Any
other valid taxonomy slug (e.g. `payments/stripe`, a plain import-matching
slug) gets a friendly "not covered by explain in the spike" message,
dynamically listing every explainable slug from the table, and exits 1:
generalizing `explain` to Tier 1's plain import matches is still out of
scope for the whole spike, structural or not. An unknown slug (not in
`taxonomy.json` at all) is a usage error citing `taxonomy.json` as the
vocabulary source, also exit 1.

What it shows: the skill's slug and taxonomy label; the classification
(`DIRECT`/`INFERRED`/`AMBIGUOUS`) with a one-line meaning; the matched
anchors grouped by kind (webhook-verification / db-write /
idempotency-guard), each with its file path, enclosing function, line, and
the `reason` string the recognizer produced; how the anchors connect
(rendered as a plain "`a.ts -> b.ts -> c.ts`" chain for a cross-file
INFERRED finding, derived from the graph's own resolved import edges — see
`src/explain-command.ts`'s `renderConnection`); the attribution verdict
(which anchor file(s), if any, intersect the selected author's own
added-lines diff) and why; and whether the skill is claimed. A repository
with no structural finding at all prints a friendly "not detected" message
and exits 1.

For an `AMBIGUOUS` finding, the output states explicitly that the skill is
**not claimed**, why (pattern not connected closely enough, or an anchor
kind is missing entirely), and that an ambiguous finding can never enter a
`scan`/`submit` bundle regardless of attribution — matching the "Draft
bundle signal" section below.

Author selection is deliberately **non-interactive**, unlike `scan`'s
prompted picker: `scan`'s interactive confirmation exists because a bundle
is about to be built and uploaded, so getting "this is really me" right
matters for what leaves the machine. `explain` never builds or sends
anything — it's a read-only local diagnostic that should run unattended (by
a script, by a test, by a developer piping it around). It defaults to the
repo's own `git config user.email` if set, and `--author <email>`
(repeatable) always overrides that default. If the resolved author
identity(ies) matched no commits at all, `explain` still runs full
detection over the HEAD snapshot (detection is independent of attribution)
and honestly reports "no commits found for `<email(s)>`" rather than
silently producing a misleading verdict.

Screen-vs-bundle boundary: everything `explain` prints (paths, function
names, line numbers, reasons) is local, on-screen-only output — printing it
to the user's own terminal is correct and never leaves the machine that
way. It is not, and must never become, part of `scan`'s bundle or anything
`submit` uploads — see this document's "Invariants" above and
`StructuralFinding`'s own comment in `src/proof-graph/infer.ts`. No
`--json` flag exists on purpose: a structured output mode would be a
standing invitation for some other tool to capture and persist a
serialization of the in-memory graph, which the "In-memory only" invariant
above forbids.

## Exclusions

Explicitly out of scope for this spike:

- No pattern DSL in `signatures/*.json` — the spike's pattern is
  TypeScript code (the parser adapter and recognizers), not signature data.
- No schema or bundle changes of any kind.
- No second language and no second area beyond the one payments/webhook
  shape described above.
- No tsconfig paths/aliases resolution, no monorepo workspace resolution,
  no DI container resolution, no cross-file value tracking, no
  type-checker — the spike works off syntactic structure, not full
  semantic resolution.
- No per-commit graph over history — HEAD snapshot only, not a graph
  rebuilt or diffed across the commit range the way `scan` walks commits
  today.
- No graph persistence or cache on disk, anywhere, at any milestone.
- No per-function blame — attribution is file-level (does the file
  intersect the selected author's touched files), not function-level.
- No `CHANGELOG.md` entry during the spike. This is a deliberate departure
  from CLAUDE.md's usual "every feature gets a CHANGELOG entry" rule,
  noted here on purpose: the spike ships nothing user-facing on `main`, so
  there is nothing to log yet. The entry lands with the go decision, if
  and when it happens.

## Draft bundle signal (implemented in H7)

This section was originally written as a draft only — at the time it was
drafted, none of it was wired into `schema/bundle.v1.json`,
`src/build-bundle.ts`, or any code path that ran. It existed so H5's
report could evaluate a concrete proposal rather than a vague one. That
proposal was approved (H5's GO recommendation, section "f" below) and
landed for real in the H7 milestone — see
[docs/schema-change-h7.md](schema-change-h7.md) for the discussion record,
the exact field contract, and the schema `1.1.0` → `1.2.0` bump. The text
below is kept as-is for history; it describes what was proposed, not a
still-open proposal.

As implemented, `detected_skills[]` entries can gain two optional fields:

- `evidence`: `"import"` | `"structural"`
- `confidence`: `"direct"` | `"inferred"`

Both are closed enums — no free-form text, consistent with the rest of the
bundle's "Bounded output" guarantee (see
[docs/principles.md](principles.md)). `AMBIGUOUS` never travels in the
bundle under any field: ambiguous means the skill is not claimed at all,
full stop. The only place an `AMBIGUOUS` classification is ever visible is
local feedback via `redential explain`. No node or edge counts of the graph
are ever proposed for the bundle either — a count is still a value derived
from code shape, and this draft stays deliberately conservative about what
crosses the boundary.

## Dependency note

H1 moves `typescript` from `devDependencies` to `dependencies` (same
`^5.6.0` range). This is a **role change, not a new dependency**:
`typescript` is already present in this repo's tree today, as the dev-only
compiler used by `npm run build`/`typecheck`. Nothing new enters the
supply chain; what changes is that it now also runs at CLI runtime, so it
needs the written justification CLAUDE.md's "ZERO new dependencies without
written justification" policy requires, applied to this narrower case:

- **Why it's needed at runtime**: the spike parses TypeScript sources (see
  `src/proof-graph/parser-adapter.ts`) with the TypeScript compiler API —
  that's the whole point of the `ParserAdapter` decision above. A
  dev-only `typescript` wouldn't be present when a published CLI actually
  runs `scan`, so the package has to ship as a real dependency for the
  parser to work outside this repo's own dev environment.
- **Usage stays parse-only**: only `ts.createSourceFile` plus a plain AST
  walk over its output. No `ts.createProgram`, no type-checker, no
  `ts.sys` filesystem or network access — `TscParserAdapter` never touches
  disk itself, only the source text it's handed. That keeps the runtime
  dependency's surface to "turn source text into a syntax tree," not the
  full compiler.
- **Why not a lighter alternative**: a hand-rolled or regex-based
  TypeScript parser is exactly the false-positive surface this spike
  exists to eliminate — `docs/signatures.md`'s import tier already
  accepts that tradeoff deliberately for import matching, but the whole
  premise of the structural tier is that regex-based "parsing" of
  arbitrary code shapes is unreliable in ways a real parser isn't (see
  the "headline advantage" comments in
  `test/proof-graph/parser-adapter.test.ts` — import-shaped text inside
  comments/template literals produces nothing, for free, precisely
  because a real parser understands what a comment or a string is).
  tree-sitter was considered and explicitly rejected for this spike — see
  "Approved decisions" above — because it would be a genuinely new
  dependency (a native/wasm parser generator) for the same job the
  TypeScript compiler API already does with a role change, not an
  addition.
- **Supply-chain profile**: zero install scripts, pure JS (no native
  binary blobs to audit), no network access of its own, and it was already
  being pulled into every contributor's `node_modules` as a dev
  dependency before this change — the audit surface for a PR reviewer is
  "does this file only call `createSourceFile` and read its output,"
  not "should this package be trusted at all."

## Spike results and recommendation (H5)

This section closes the spike. It reports what was actually measured
(H1–H4), not a restatement of intent, and ends with a go/no-go
recommendation for the owner.

### a. Measured results

All five programmatic fixtures (`test/proof-graph/fixtures.ts`,
exercised end to end in `test/proof-graph/detection.test.ts`) classified
as designed on the **first run** in H3 — no fixture tuning, no assertion
loosening, to get any of them to pass:

| Fixture | Classification | Attribution | Claimed |
| --- | --- | --- | --- |
| `fixtureDirectPattern` — one file, all three anchors in one function | `direct`, `same-function` (edgeDistance 0) | attributed | yes |
| `fixtureLayeredPattern` — handler → service → repo, three files, relative imports only | `inferred`, `cross-file`, edgeDistance 2 | attributed | yes |
| `fixtureStripeUnused` — Stripe imported, never wired into a webhook flow | `ambiguous` | n/a (ambiguous never claims) | no — while Tier 1 import matching still reports `payments/stripe` on the same commit |
| `fixtureOtherAuthor` — full pattern present, but committed by a different author | `direct` | not attributed | no |
| `fixtureCommentsOnly` — stripe/prisma/constructEvent only inside comments and a template-literal string | no finding at all (`findAnchors` returns `[]`) | n/a | n/a |

Graph-build timing, measured today against this repo's own HEAD (not a
fixture — this repo's real, non-trivial TypeScript ESM tree):
snapshot + parse + build over **80 files** completed in **181.9ms**
(`test/proof-graph/e2e-smoke.test.ts`; H1 measured ~135–157ms over 64
files — the repo has grown by 16 files since and stayed well under
200ms). Against the spike's "single-digit seconds" criterion, this is
roughly two orders of magnitude under budget.

### b. Timebox outcome (H2)

The blanket degradation H2's timebox allowed for ("module co-location
plus import edges" for every recognizer, if binding resolution proved
unreliable) was **not triggered**. Full receiver resolution shipped as
originally planned — import binding → same-file `new`/call binding → one
alias hop (`src/proof-graph/anchors.ts`'s `resolveReceiver`) — for every
recognizer.

The one narrow, documented fallback: supabase/knex DB-writes fall back
to file-level import co-location instead of receiver resolution. Their
common calling idiom (`supabase.from('orders').insert(...)`,
`knex('users').insert(...)`) invokes the table selector as a function
call, which collapses to a wildcard ("*") chain segment in the parser's
syntactic model (`parser-adapter.ts`'s `chainOf` convention) and leaves
no root name for `resolveReceiver` to resolve against. What was lost:
per-receiver certainty for those two packages only — every other
recognizer (Stripe signature verification, Prisma/generic DB writes,
idempotency guards) got full resolution. What recovering it would take:
modeling call-result receivers in the parser (chains rooted at a call
expression, not just an identifier), a bounded parser-adapter extension
— not a rewrite.

### c. Draft bundle signal

**Update: this checklist is complete as of H7** — see
[docs/schema-change-h7.md](schema-change-h7.md). The rest of this
subsection is kept as the historical record of what was pending at the
time H5 closed.

The "Draft bundle signal" section above stays the source of truth for the
field shape (`evidence`/`confidence` closed enums on `detected_skills[]`).
At H5 close, on a GO decision, the following ceremony was **pending and
entirely deferred** — none of it happened as part of closing the spike:

- A prior discussion issue (per CLAUDE.md's "any change to WHAT data
  leaves the machine requires a prior discussion issue").
- A schema version bump: `schema/bundle.v1.json` stays untouched by the
  spike; landing this signal would move it `1.1.0 → 1.2.0` (minor —
  additive, optional fields, backward compatible).
- A `docs/schema.md` entry documenting the two new fields.
- A `CHANGELOG.md` entry (the spike itself deliberately has none, see
  "Exclusions" above; the entry lands with the go decision).
- New privacy tests for the two enum fields, in `test/privacy/`,
  following this spike's own `test/privacy/proof-graph-boundaries.test.ts`
  pattern (structural source-inspection plus a real end-to-end bundle
  assertion) — extended to prove the closed-vocabulary property holds for
  `evidence`/`confidence` the same way `taxonomy.json` already
  mechanically bounds `detected_skills[].slug`.

Nothing above is implemented as part of H5. This is a checklist for the
next milestone, contingent on a GO decision.

### d. Migration & DSL thresholds

- **Parser migration** (`typescript` compiler API → tree-sitter): only
  when a second language lands. The `ParserAdapter` interface
  (`src/proof-graph/parser-adapter.ts`) is the seam already built for
  this — swapping the adapter's implementation behind the same interface
  is estimated as an adapter-swap, not a rewrite of the graph/anchors/
  infer layers above it, none of which touch `ts.*` types directly.
- **Declarative pattern DSL** in `signatures/*.json`: only once 3+ real
  structural patterns exist beyond the current payments/webhook one. One
  pattern is code (what this spike built); three patterns is the point
  at which a shared abstraction across patterns becomes visible enough
  to design well, rather than guessed at from a single example.

### e. Known minor issues

Carried over honestly from the milestone reviews, all non-blocking:

- `webhookHits` (`src/proof-graph/anchors.ts`) carries an unused `graph`
  parameter.
- pg's `ON CONFLICT` check scans all string arguments of a call, so an
  `ON CONFLICT` string literal in a different argument position than the
  actual write-shaped argument would count as a match.
- `test/privacy/proof-graph-boundaries.test.ts`'s `stripComments` helper
  assumes no `//` or `/*` appears inside a string literal anywhere in
  `src/proof-graph/*.ts` (documented in the test itself, verified true
  today by inspection) — a self-enforcing check that asserts this
  assumption rather than just asserting it in a comment would be nicer,
  but wasn't built.
- On Windows, `listFixtureFiles` (`test/privacy/proof-graph-boundaries.test.ts`)
  yields backslash-separated paths, which makes the full relative-path
  negative assertions trivially true there (a bundle containing a
  forward-slash path won't match a backslash-joined string) — the
  basename and function-name negative assertions in the same test still
  catch a real leak on Windows, so the boundary check isn't blind there,
  just weaker on one of its three signals.

### f. GO / NO-GO recommendation

**Recommendation: GO** — evaluate the ceremony in section c above as the
next milestone, with the calibration step below as its first task.

The evidence: every fixture classified correctly on the first run, with
no loosening to make them pass. The deliberate false negative
(`fixtureStripeUnused` → `ambiguous`, unclaimed, even though Tier 1 import
matching still reports `payments/stripe` on the same commit) works and
is the anti-inflation property plain import matching structurally cannot
offer — it is the whole reason this spike exists. The attribution gate
(file-level intersection with the selected author's own touched files,
`fixtureOtherAuthor`) works. Performance is roughly two orders of
magnitude under the "single-digit seconds" budget, measured on this
repo's own real 80-file tree, not a toy fixture. The privacy boundary is
mechanically enforced, not just documented: module-boundary
(`test/privacy/proof-graph-boundaries.test.ts`'s import-reference check)
and serialization-surface (its `toJSON`/`JSON.stringify`/file-write scan)
tests both survived adversarial mutation during milestone review, and
this H5 task additionally hardened the previously-flat static
network-API scan in `test/privacy/zero-network.test.ts` to walk `src/`
recursively, closing the one gap where `src/proof-graph/*.ts` could have
escaped it.

Honest caveats: all of this evidence is at synthetic-fixture scale — one
structural pattern, one language, five small programmatically-built
repos. The `AMBIGUOUS` rate on real-world layered codebases (where
webhook verification, DB writes, and idempotency guards are often spread
across more files, more indirection, and more framework-specific
plumbing than any fixture here models) is **unmeasured**, and is the
single biggest open risk — a structural tier that classifies most
real payment-webhook code as `ambiguous` would be strictly worse than
Tier 1 import matching for this specific slug, defeating the spike's own
purpose. The recommended first post-go step, before any schema ceremony
in section c, is a calibration pass: run the structural tier's detection
(no bundle writing, no schema change — just `redential explain` or an
equivalent script) over a handful of real, permission-cleared TypeScript
repos with known payment-webhook code, and check the `ambiguous` rate
before spending any review cost on the ceremony above.

A no-go was a valid outcome of this spike — the timebox in b, the
`AMBIGUOUS` gate in the fixtures, and the honest listing of known issues
in e were all designed to surface a no-go if the evidence pointed there.
It didn't: nothing in H1–H4 forced a fallback, no fixture needed
loosening, and the privacy boundary held under adversarial review. The
evidence points to GO, with the calibration caveat above carried
forward as the first thing to check before committing further review
cost.

## Scale hardening

A follow-up milestone, after section a's "roughly two orders of magnitude
under budget" measurement above turned out to hold only for the
80-file/toy-fixture scale it was measured at. Running `redential explain`
against larger, denser real-shaped repos (many files, many DB call sites
per file — the realistic shape of a payments-heavy service layer, not a
pathological input) reproduced a hang: the process never returned and had
to be killed.

### Diagnosis

Two compounding causes, both in `findInferredTriple`
(`src/proof-graph/infer.ts`), the function that searches for a cross-file
INFERRED connection once same-function/same-file DIRECT matching has
already failed:

1. **A resort bug.** `sortAnchorHits(dbWrite)` was being re-executed on
   every outer-loop iteration, and `sortAnchorHits(idempotency)` on every
   `(webhook, dbWrite)` pair — an `O(n log n)` re-sort repeated inside an
   already-nested loop. The sibling functions in the same file
   (`findSameFunctionTriple`, `findSameFileTriple`) already hoist their
   sorts correctly; `findInferredTriple` didn't. Measured impact: roughly a
   44–50x slowdown on its own, before the second cause is even considered.
2. **An unbounded search space.** The search iterated every
   `(webhook anchor, db-write anchor, idempotency anchor)` **instance**
   triple — `O(W × D × I)` over raw anchor counts. On a realistic dense
   repo (a service layer with dozens of DB call sites in some files, plus
   a plausible 10–25% of files touching Stripe somewhere), this reaches
   billions of combinations well before any bug-fix-level constant-factor
   improvement could help: a measured 500-file dense fixture produced
   10.8 billion combinations, ran past 130 seconds, and had to be killed.
   The existing H1 size caps (`maxFileBytes`/`maxFiles` in
   `src/proof-graph/snapshot.ts`) bound snapshot *size*, not anchor
   *count* — a file well under 200 KB can still contain dozens of DB call
   sites, so those caps could never have prevented this.

### The fix

`findInferredTriple` was rewritten around three changes:

- **Hoisted sorts.** Both `sortAnchorHits` calls now run once, outside
  every loop — closing cause 1 above, matching the pattern its sibling
  functions already used.
- **File-level search, not anchor-instance-level.** Connectivity distance
  (`distanceBetween`, built on the graph's resolved import edges) is
  inherently file-level already — it takes paths, never anchors — so
  multiple anchors of the same kind in the same file always produce
  identical pairwise distances. The rewrite collapses each anchor kind to
  its **sorted set of distinct file paths** first, then searches file
  triples: `|files|` is orders of magnitude below `|anchors|` on exactly
  the dense repos where the old search blew up. This is an exact
  equivalence, not an approximation — the file triple minimizing the
  maximum pairwise distance (≤ 3, per the INFERRED rule) is identical
  either way, and the specific representative `AnchorHit` picked for each
  chosen file (the lowest-line anchor of that kind in that file, by the
  existing `sortAnchorHits` order) is provably the same one the old
  anchor-instance-level search would have converged on — see
  `findInferredTriple`'s own doc comment in `src/proof-graph/infer.ts` for
  the full argument. `test/proof-graph/infer.test.ts` and
  `test/proof-graph/detection.test.ts`'s existing assertions on the
  resulting `finding.anchors`/`connection` pass unchanged.
- **A deterministic work budget, not a wall-clock timeout.** The original
  ask was "timeout with clean degradation," but a wall-clock cut would
  make the classification depend on how fast the machine happens to be at
  the moment it runs — the same repo could classify `inferred` on a
  fast/idle machine and `ambiguous`-by-timeout on a loaded CI runner or an
  older laptop, breaking this whole spike's "same input → same output,
  always" determinism invariant. Instead, `INFER_WORK_BUDGET` (2,000,000)
  counts real search work against one shared counter — every full
  file-triple evaluation plus every node a BFS visits while computing a
  fresh distance — and stops the search once it's exceeded. This gives the
  same practical guarantee ("this can never hang the terminal") without
  the nondeterminism: the same graph and anchors always perform the exact
  same number of counted work units, so they always land on the same side
  of the budget, on any machine, under any load. `StructuralFinding` gained
  a new optional field, `searchBounded?: true`, set only when the budget
  was hit; a search-bounded finding degrades to `ambiguous` and — like
  every `ambiguous` finding — never claims. `redential explain` prints one
  extra line in this case, distinguishing "search cut short" from
  "genuinely not connected."
- **The BFS itself is depth-capped at 3 (`MAX_EDGE_DISTANCE`), not just
  the search loop.** `findInferredTriple` only ever cares whether a
  pairwise file distance is `<= MAX_EDGE_DISTANCE` — anything past that is
  already treated identically to "unreachable" at the read site. An
  earlier version of this fix ran the BFS itself uncapped (walking the
  distance-computing helper's whole connected component every time),
  which is semantics-preserving but was flagged in review as wasted work
  that inflates the shared work-budget counter for no benefit: on a
  large, well-connected repo, `workUnits += <BFS result size>` could add
  up to a whole component's worth of nodes per distinct anchor file BFS'd
  from, tripping `INFER_WORK_BUDGET` and spuriously degrading a repo the
  depth-capped design should classify fully. `bfsDistances` now stops
  enqueuing neighbors once `currentDistance >= MAX_EDGE_DISTANCE`, so it
  never visits (or charges work-budget cost for) a node past the radius
  that could ever matter — see `bfsDistances`' own doc comment in
  `src/proof-graph/infer.ts` for the semantics-preservation argument
  (every node the OLD, uncapped BFS returned within the cap is still
  returned, with the identical distance; only nodes strictly past the cap
  are pruned, and those already collapsed to "too far, treat as
  unreachable" at every read site). Measured effect: on the diagnosis
  harness's larger, sparser `fixture-2000`-shaped fixture, capping cut the
  BFS-attributable work from 275,220 to 95,321 units (a ~65% reduction)
  and the infer phase from ~80ms to ~12ms; on the denser
  `fixture-500-hang`-shaped fixture the reduction was smaller (1,385,550
  → 1,301,414 units, ~6%) because that fixture's whole connected
  component already sits mostly within the depth-3 radius. See "Measured
  before/after" below for the full numbers.

### Snapshot-local exclusions (hygiene, not the hang fix)

While building the scale-hardening test fixtures, four generated-code
shapes were noticed that `src/churn-exclusions.ts`'s `isExcludedPath`
doesn't already cover (its own `GENERATED_DIR_PATTERN` only knows
`dist/`, `build/`, `.next/`, `node_modules/`): `out/` (a Next.js static
export), `coverage/` (test-coverage reports), `.vercel/` (a deployment
build cache some repos commit), `storybook-static/` (a built Storybook
site), any directory literally named `generated/`, and `.min.ts` files.
`src/proof-graph/snapshot.ts`'s `readHeadSnapshot` now excludes these
too, **applied snapshot-side only** — `churn-exclusions.ts` itself was
deliberately left untouched this milestone, so the shipping `scan`
command's own behavior is unchanged. Upstreaming some or all of these
into `churn-exclusions.ts` (so the shipping churn/skill-detection path
benefits too) is a separate future discussion, not decided here.

This is explicitly **not** part of the hang fix: the fixture that
reproduced the hang (`fixture-500-hang` in the diagnosis harness)
contained zero generated content — the hang was purely a search-space-size
problem, reproducible with completely ordinary, non-generated source.
(One practical note for anyone reusing that diagnosis fixture after this
change: its content happens to live under a `src/generated/` directory,
which the new exclusion now filters out entirely at snapshot time — a
regenerated fixture under a differently-named directory is needed to
exercise `findInferredTriple` end-to-end through `readHeadSnapshot` going
forward.)

### Measured before/after

All numbers below are the `inferStructuralSkills`/`findInferredTriple`
phase specifically (isolated with a phase-by-phase timing harness), on
fixtures built with the same generator shape as
`test/proof-graph/scale-fixtures.ts` (distinct-file counts, DB write call
sites per file, and weak-signal "stripe noise" file fraction are all
parameters). The "After" column reflects the FINAL fix, including the BFS
depth cap above — an intermediate version without the depth cap was
briefly in place during development and is called out separately below
where the cap made a measurable difference.

| Fixture | Shape | Before (pre-fix) | After (post-fix, depth-capped) |
|---|---|---|---|
| 500 files, dense | 150 db-write files × 80 calls/file (12,000 db-write anchor instances), 125 weak-signal stripe-noise files, 10.8 billion instance-level combinations | > 130s, killed (never completed) | infer phase: **108.3ms**; classified `inferred` |
| 2,000 files | 600 db-write files × 1 call/file, no stripe noise | not separately measured pre-fix (superset of the 500-file case's blowup) | infer phase: **11.8ms**; total pipeline wall time: **1.28s**; classified `inferred` |
| ~300 files (test suite fixture) | 90 db-write files × 40 calls/file, 20% weak stripe-noise files (real work count: 631,652 — ~3.2x of headroom under the 2,000,000 budget) | would have taken minutes (anchor-instance search over ~3,600+ db-write instances alone) | infer phase: **~28ms**; classified `inferred`, `searchBounded` absent |
| Engineered budget-exceeding fixture (test suite) | 130 distinct files per anchor kind, star topology (all within distance ≤ 2 of each other, so no early pruning) — 130³ = 2,197,000 file-triple evaluations | n/a (didn't exist pre-fix; the file-level search itself is new) | infer phase: **~54ms**; classified `ambiguous`, `searchBounded: true` (work units: 2,000,001, i.e. cut off exactly one unit past the budget); identical result on repeated runs |

The 500-file dense case is the same shape the original diagnosis reported
as "10.8e9 combinations, > 130s, killed" — post-fix, the file-level search
over that same fixture's distinct file counts (2 webhook files, 150
db-write files, up to ~150 idempotency files once upsert/lookup-before
-write dual-hits are counted) finishes in well under 200ms.

**Effect of the BFS depth cap specifically** (measured by temporarily
reverting just the cap, on the same two diagnosis-harness fixtures):

| Fixture | Work units, uncapped BFS | Work units, depth-capped BFS | Reduction | Infer phase, uncapped | Infer phase, capped |
|---|---|---|---|---|---|
| 500 files, dense (`fixture-500-hang`-shaped) | 1,385,550 | 1,301,414 | ~6% | ~158ms | ~108–146ms |
| 2,000 files (`fixture-2000`-shaped) | 275,220 | 95,321 | ~65% | ~80ms | ~12ms |

The cap matters far more on the sparser, larger-component 2,000-file
fixture than on the denser 500-file one: the 500-file fixture's whole
connected component already sits mostly within the depth-3 radius (little
left to prune), while the 2,000-file fixture has a larger component with
real structure past distance 3 that an uncapped BFS was walking (and
charging work-budget cost for) for no benefit. This is exactly the
"500 distinct anchor files × 5000-file component" failure mode the cap
exists to prevent: on a big enough well-connected repo, uncapped
per-BFS work could dominate the budget and trigger a spurious
`searchBounded` degradation that has nothing to do with the actual
search — the depth-capped design avoids that by construction, not by
having a large enough budget to absorb it.

### History-dominated repos (follow-up)

A second, separate scale finding, on top of the anchor-search hang above:
once the anchor-search cost was fixed, phase-by-phase timing on
history-heavy fixtures (thousands of files, thousands of commits, several
distinct authors — the realistic shape of a mature team repo, not a toy)
showed a DIFFERENT phase dominating wall time. `redential explain`'s own
history-reading phase — `getAllCommits` walking and `--numstat`-diffing
**every commit by every author**, then filtering down to the selected
author's commits in JS afterward — measured at 49% of total wall time on a
5,000-file/5,750-commit fixture, ahead of snapshot, parse, and the anchor
search combined. `collectUserTouchedFiles` (the per-user added-lines diff
fetch, downstream of that same over-broad commit set) was the next-largest
cost. A raw-git A/B (`git log --numstat` filtered by `--author` at the git
level vs. the full unfiltered walk) measured author-filtered git as
3.4–4.5x faster than the full walk on the same history.

Three quick wins landed here to close the gap between "what `explain` reads"
and "what it actually needs" (author-scoped attribution over a
possibly-narrowed date window), without touching the anchor-search fix
above or reopening any of its invariants:

1. **Git-level author filtering (`src/git.ts`).** `GetAllCommitsOptions`
   gained an optional `authorEmails?: string[]`, translated to one
   `--author=<escaped>` arg per email (git ORs multiple `--author` patterns
   together). This is an OPTIMIZATION ONLY, never the correctness boundary:
   `git log --author` is a substring match against the whole `"Name
   <email>"` field, not an exact-equality match on the email alone, so
   `explain-command.ts`'s existing exact-equality JS filter over the
   result stays in place unchanged and remains the actual source of truth
   — git-level filtering can only ever narrow what git streams back for
   speed, never redefine which commits count as "the author's". Escaping
   required care: `git log --author` matches with POSIX BASIC regular
   expressions by default, where `+`/`?`/`(`/`)`/`{`/`}`/`|` are literal
   characters unless backslash-escaped (escaping them is what turns them
   INTO metacharacters — a GNU BRE extension, the opposite of
   extended/PCRE regex) — a naive "escape every ERE metacharacter"
   approach was tried first and verified, against a real git commit, to
   silently break plus-tag addresses like `user+tag@example.com` (an
   escaped `\+` matched nothing; the literal `+` matched correctly). Only
   `.`/`*`/`^`/`$`/`[`/`]`/`\` are escaped. `scan.ts`'s existing
   `getAllCommits` calls (`listAuthors`, and `runScan`'s own walk) are
   unchanged and stay unfiltered — `listAuthors` needs every author to
   build its candidate list, and `runScan` computes
   `identity.other_contributors_count`/`ownership.user_commit_ratio` from
   the full population, both of which need every commit, not just the
   selected author's.
2. **`explain` passes the resolved author into the walk, plus a new
   `--since`.** `explain-command.ts` now threads its already-resolved
   author email(s) into `getAllCommits`'s new option. `redential explain`
   also gained a `--since <spec>` flag (`src/cli.ts`), parsed with the
   exact same `src/since.ts` spec/plumbing `scan`'s own `--since` uses
   (relative windows like `"2years"`, or an absolute date), defaulting to
   full history. Attribution semantics: `--since` can only NARROW the
   author's touched-file set — it can turn `attributed=true` into `false`
   by excluding commits, never invent attribution the unwindowed history
   didn't already support. It's an explicit user-requested narrowing of
   the evidence window, not new inference. Because a windowed run can
   silently look like "no evidence" if the window itself isn't visible,
   the `Attribution (author: ...)` output line now also names the active
   `--since` window whenever one is set, so the narrowing shows up in the
   printed evidence itself, not just in how the command happened to be
   invoked.
3. **Snapshot content-fetch batch size (`src/proof-graph/snapshot.ts`).**
   `CONTENT_BATCH_SIZE` (the `git cat-file --batch` chunk size
   `readHeadSnapshot` fetches file content in) was raised from 200 to
   1000. Measured: at 2,000 files, 200 meant 10 batches, each paying a
   fixed `git cat-file --batch` process-spawn cost on top of its actual
   read work — that per-batch overhead alone measured ~300ms across those
   10 batches. 1000 keeps worst-case memory comfortably bounded: 1000
   files × the existing 200 KiB per-file cap (`maxFileBytes`) is a 200 MB
   theoretical ceiling, and real TypeScript source sits far below that cap
   in practice, so a batch's actual footprint is a small fraction of the
   theoretical worst case. Not raised further: 1000 already cuts batch
   count 5x on the largest fixture measured here (5,000 files → 5 batches
   instead of 25), and going higher grows the worst-case-memory ceiling
   for no further measured benefit.

**Measured impact**, phase-by-phase, on two history-heavy fixtures (a
multi-author repo, several thousand files/commits each), comparing the
pre-fix unfiltered walk against the post-fix author-filtered walk (same
built `dist/`, same machine, single-run measurements — expect normal
run-to-run variance from background load, not a rigorous benchmark suite):

| Fixture | Phase | Before | After |
|---|---|---|---|
| 3,500 files / 2,967 commits | `getAllCommits` | 4,127ms (walks all 2,967 commits) | 1,249ms (walks only the 1,518 matching commits) |
| 3,500 files / 2,967 commits | total pipeline wall time | 8,856ms | 5,479ms |
| 5,000 files / 5,750 commits | `getAllCommits` | 7,630ms (walks all 5,750 commits) | 3,337ms (walks only the 2,896 matching commits) |
| 5,000 files / 5,750 commits | total pipeline wall time | 17,647ms | 10,603ms |

Both fixtures land close to the raw-git A/B's 3.4–4.5x range on the
`getAllCommits` phase itself (3.3x and 2.3x respectively — the gap from the
raw-git number reflects this harness's Node-side commit parsing/streaming
overhead, present on both sides of the comparison, on top of the git
process's own filtering work). The `collectUserTouchedFiles` phase (still
downstream of the filtered commit set, un-optimized in this milestone) and
`snapshot`/`parse` remain the next-largest costs on these fixtures — see
"Deferred" below for what a further pass at those would need.

**Deferred to a future milestone** (diagnosed, not landed here — each of
these is a larger design decision than a quick win, and none of them was
needed to close the specific 49%-of-wall gap measured above):

- **Attribution early-exit.** Semantics-preserving for the positive case
  only: once a supporting anchor file is confirmed touched by the author,
  no more commits need scanning for THAT finding, since more history can
  only add confirmations, never remove one already found (see the
  `--since` narrowing note above — the same "more evidence only adds,
  never subtracts positive attribution" direction, just applied to when
  the walk itself can stop rather than how far back it goes). Not
  semantics-preserving for the negative case (a "not attributed" result
  still requires having scanned everything in the window), so this would
  need care to land correctly, not just an early `break`.
- **Candidate/lazy parsing.** Sound in principle — per anchor-rule
  substring analysis of a file's content narrows which files even need
  full parsing/graph-building before an anchor could exist in them — but
  the actual neighborhood size (how many files a real candidate set
  touches once resolved-import connectivity is followed outward) needs to
  be MEASURED on a real repo before betting engineering effort on it:
  synthetic random import graphs are known to balloon the reachable
  neighborhood to effectively 100% of files past a small hop count, which
  would make this optimization a no-op on exactly the repos it's meant to
  help. Diagnosed, not landed, pending that real-repo measurement.
- **Worker-thread parallel parse.** A secondary target (~14% of wall on
  the measured fixtures), lower priority than the history-walk fix above
  because it's a smaller fraction of the total and (unlike the git-level
  author filter) would add real concurrency-correctness surface — not
  attempted in this milestone.

## Multi-provider expansion (H6)

A follow-up milestone, after H5's GO recommendation, widening the
structural tier from ONE pattern (Stripe webhook → DB write → idempotency
guard) to SIX: the original Stripe pattern plus PayPal, Mercado Pago, Lemon
Squeezy, Paddle (all the same "webhook-flow" shape family) and RevenueCat/
IAP (its own, unrelated shape). Same invariants as the rest of the spike,
unconditionally: zero network, zero LLM, in-memory-only graph, closed
vocabulary — every new slug (`payments/paypal-webhook-flow`,
`payments/mercadopago-flow`, `payments/lemonsqueezy-webhook-flow`,
`payments/paddle-webhook-flow`, `payments/iap-subscription-flow`) was added
to `taxonomy.json` (minor bump, `1.4.0 → 1.5.0`) BEFORE any code could
produce it, matching every other slug in this spike's history. Nothing
here touches `schema/`, `src/build-bundle.ts`, or `submit` — the structural
signal stays out of the bundle for the whole spike, unchanged from H5's
"Approved decisions" #2.

### The descriptor-table approach

Phase 1 of H6 generalized `src/proof-graph/anchors.ts`'s single hardcoded
Stripe recognizer into a `WEBHOOK_PROVIDERS: WebhookProviderDescriptor[]`
table — package specifiers, verify-call chain suffixes, and signature-header
literals, one entry per provider — walked by one shared `webhookHits`
function instead of one function per provider. Landed with exactly ONE
entry (Stripe) as an intentionally provable no-op: the refactor's own test
suite (H2's 25 tests, H3's 5 end-to-end fixtures) passed UNMODIFIED, proving
the abstraction changed no observable behavior before a second provider was
ever added. `src/proof-graph/infer.ts` mirrors the same shape:
`STRUCTURAL_PATTERNS: StructuralPattern[]`, one entry per taxonomy slug,
each carrying its own `anchorKinds` (which 3 anchor kinds make up its
DIRECT/INFERRED shape, in the exact positional order
`findSameFunctionTriple`/`findSameFileTriple`/`findInferredTriple` already
expected) and `packages` (reused by the generalized AMBIGUOUS gate). Phase
2a then added the 4 remaining webhook-flow descriptors plus IAP's own
recognizer and pattern entry — see `src/proof-graph/anchors.ts`'s
`WEBHOOK_PROVIDERS` and `src/proof-graph/infer.ts`'s `STRUCTURAL_PATTERNS`
for the full tables and their own extensive inline rationale.

Two of `WebhookProviderDescriptor`'s fields are ADDITIVE extensions, not
present in the original table shape, each added for exactly one provider
that didn't fit the original "dedicated verify-call" model:

- **`creationChainSuffixes`** (Mercado Pago only). Mercado Pago's SDK has
  no `verifyWebhookSignature`-style method at all — its shape is "create a
  Preference/Payment" (the call that starts the flow) followed by an
  IPN/webhook notification the provider sends back later (covered by the
  existing `signatureLiterals` field). Rather than stretch
  `verifyChainSuffixes`'s meaning ("this call verifies a signature") to
  also cover "this call merely starts the flow," this is a separate,
  explicitly-named field, checked the same way (receiver resolved to one
  of `packages`, chain-suffix match) but producing a hit with a DIFFERENT
  `reason` string, so `explain` output never claims a creation call is a
  signature check it isn't.
- **`manualHmacLiteral`** (Lemon Squeezy only). Lemon Squeezy's SDK exposes
  no signature-verification helper either — their own docs show
  hand-rolled HMAC verification instead (`createHmac(...)` +
  `timingSafeEqual(...)`, co-located with the provider's signature header
  literal, anywhere in the same file). This is the one documented exception
  in the whole table to "webhook-verification always requires SOME
  reference to the provider's own package": the rule fires even without
  importing `@lemonsqueezy/lemonsqueezy.js` at all, because the real-world
  pattern genuinely doesn't reference it.

### Slug-per-provider decision

Each of the 5 webhook-flow providers gets its OWN taxonomy slug
(`payments/paypal-webhook-flow`, `payments/mercadopago-flow`, etc.) rather
than collapsing them into one generic `payments/payment-webhook-flow` for
every provider. Decided, not defaulted: the provider is part of the
EVIDENCE and the LABEL a company sees on a proof bundle, not an
implementation detail to abstract away — "this repo has a Mercado Pago
integration" is a materially different, more useful claim than "this repo
has *a* payment webhook integration," and collapsing the two would throw
away real signal for no simplification a bundle consumer would want.

### Mercado Pago's optional-anchor cap

Mercado Pago is the one pattern with an `optionalAnchorKinds` entry:
`idempotency-guard` is real, common, and provider-agnostic (shared with
every other webhook-flow pattern), but not universal in real Mercado Pago
integrations the way it's expected to be structurally reachable for the
other 4 webhook-flow providers. The rule: when `idempotency-guard` is
present anywhere in the repo, Mercado Pago classifies exactly like every
other webhook-flow pattern (DIRECT/INFERRED/AMBIGUOUS over the full
3-anchor shape). When it's globally ABSENT (zero anchors of that kind
anywhere), the pattern still classifies — via a 2-kind PAIR search over just
`webhook-verification`/`db-write` (`findSameFunctionPair`/
`findSameFilePair`/`findInferredPair`, additive siblings of the existing
triple-search functions) — but the resulting `confidence` is CAPPED at
`inferred` regardless of which connectivity tier the pair search actually
found: even a same-function pair, which for a normal 3-kind pattern would
be DIRECT, comes out `inferred` here. `connection` still reports the ACTUAL
topology found (same-function / same-file / cross-file); only `confidence`
is capped, so `redential explain` stays fully honest about both facts at
once — see `src/explain-command.ts`'s `cappedOptionalAnchorKind` (H6 phase
2c) for how `explain` derives and surfaces this from the finding's own
public fields (there is no dedicated `capped` field on `StructuralFinding`;
the derivation is documented inline there) and prints an explicit note
distinguishing "capped because idempotency-guard is missing" from a
genuine cross-file INFERRED finding.

### IAP/RevenueCat's own shape and known gaps

An in-app-purchase flow has no webhook at all, so IAP doesn't reuse the
webhook-flow shape — it gets its own 3 anchor kinds (`iap-configure`,
`iap-purchase`, `iap-entitlement-gate`, see `AnchorKind` in
`src/proof-graph/anchors.ts`) and its own `StructuralPattern` entry
(`kind: "iap-flow"`), reusing the SAME `findSameFunctionTriple`/
`findSameFileTriple`/`findInferredTriple` machinery unchanged — none of
those functions ever inspect `AnchorHit.kind`, only `path`/
`enclosingFunction`, so a second, unrelated 3-kind shape needed zero changes
to the search functions themselves, only a second table entry naming its
own 3 kinds.

Two documented, accepted gaps, carried over honestly rather than fixed
under this milestone's timebox:

- **Entitlement-gate is call-shape only.** `iapEntitlementGateHits` only
  recognizes a CALL whose chain contains an `"entitlements"` segment
  (e.g. `customerInfo.entitlements.active.get('pro')`). The single most
  common real-world RevenueCat shape,
  `if (customerInfo.entitlements.active['pro'])`, is a bare property/
  element-access expression — not a `CallExpression` — so it produces no
  `ParsedCall` at all and this rule can't see it. Assigning it to a
  `const` first is captured as a `ParsedBinding`, but `ParsedBinding`
  carries no line/`enclosingFunction` (deliberately kept off this
  milestone's scope), so there is no `AnchorHit` this rule could honestly
  construct from a binding alone. Fixtures use a made-up CALL-shaped
  entitlement check specifically to exercise the rule despite this gap
  (see `test/proof-graph/fixtures.ts`'s IAP section comment).
- **Paddle's construction-only gap.** A bare `new Paddle(...)` /
  `new Preference(...)` (Mercado Pago has the same gap) that's never
  followed by the actual verify/creation call produces no hit at all —
  `parser-adapter.ts` only tracks `CallExpression` nodes as `ParsedCall`, so
  a `NewExpression` used purely as a binding's initializer, with no
  method call chained off the resulting object anywhere else, is invisible
  to every recognizer in this file. In practice every real Paddle/Mercado
  Pago integration DOES follow construction with the actual verify/create
  call, so this gap is expected to be invisible on real repos — the same
  reasoning `WebhookProviderDescriptor.creationChainSuffixes`' own comment
  already applies to Mercado Pago specifically.

### The `x-signature` collision

Mercado Pago's real IPN/webhook header (`x-signature`) and Lemon Squeezy's
own signature literal are the SAME string. `manualHmacLiteral`'s rule
doesn't check for the ABSENCE of a Mercado Pago import, so a file that
hand-rolls HMAC verification (Lemon Squeezy's shape) AND happens to also
import `"mercadopago"` (or just contains the `"x-signature"` literal for an
unrelated reason) could, in principle, produce BOTH a Lemon Squeezy
manual-HMAC hit and a Mercado Pago file-level-fallback hit in the same
file. Accepted, not fixed, for three reasons: (a) it still requires the
SAME file to independently satisfy Mercado Pago's OWN package-import gate
too — the manual-HMAC rule doesn't relax anything about the OTHER
provider's own matching; (b) a Mercado Pago IPN handler hand-rolling HMAC
with `timingSafeEqual` specifically is not how that SDK's integrations are
typically written; (c) even if both fire, `infer.ts`'s per-pattern
`providerSlug` filtering keeps each pattern's classification looking ONLY
at its own `webhook-verification` hits — a spurious extra hit for provider
A never pollutes provider B's triple/pair search. See
`test/proof-graph/anchors.test.ts`'s dedicated collision-shaped test.

### DSL threshold reached (not implemented)

The "Migration & DSL thresholds" section above (H5) set the bar for a
declarative pattern DSL in `signatures/*.json` at "3+ real structural
patterns beyond the current payments/webhook one" — the point where a
shared abstraction across patterns becomes visible enough to design well,
rather than guessed at from a single example. H6 crosses that threshold: 6
patterns now exist as hand-written TypeScript table entries
(`WEBHOOK_PROVIDERS` in `anchors.ts`, `STRUCTURAL_PATTERNS` in `infer.ts`).
This is recorded here as INPUT for a future decision, not acted on: the
descriptor-table shape that emerged organically across H6's 6 entries (
`packages`/chain-suffix/literal fields, plus the two additive extensions
above) is itself a reasonable starting sketch for what a DSL's schema could
look like, if and when that discussion happens. Nothing about the DSL
question was decided or implemented this milestone.

### Testing posture

Each of the 5 new patterns got the same fixture shape used for Stripe in
H3: connected/one-file → DIRECT, layered/3-file relative-import chain →
INFERRED, package imported but structurally unused (alongside an unrelated,
fully-connected Stripe pattern in the same commit, proving a *different*
provider's own anchors never leak into this provider's AMBIGUOUS finding)
→ AMBIGUOUS/not claimed, and full pattern present but committed by a
different author → detected but not attributed. Mercado Pago additionally
gets a 5th fixture pair (the cap case and the cap-lifted-by-upsert case) for
its `optionalAnchorKinds` rule specifically. All fixtures are the usual tiny
tmpdir git repos (`test/proof-graph/fixtures.ts`), never committed history.
`test/privacy/proof-graph-boundaries.test.ts` extends its own "structural
slug never enters the bundle" assertion from the one original slug to all 6,
over two scanned bundles (the original Stripe-only fixture, plus one
non-vacuous PayPal-shaped fixture for the new tier), keeping the existing
Stripe/PayPal Tier-1 positive controls that prove each scan actually looked
at real content rather than an empty repo.
