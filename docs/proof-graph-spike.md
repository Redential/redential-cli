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

## Draft bundle signal (not implemented)

This section is a draft only — none of it is wired into
`schema/bundle.v1.json`, `src/build-bundle.ts`, or any code path that runs
today. It exists so H5's report can evaluate a concrete proposal rather
than a vague one.

If a future go decision approves this direction, `detected_skills[]`
entries could gain two optional fields:

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
