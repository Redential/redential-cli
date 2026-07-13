// H2 of the proof-graph spike (see docs/proof-graph-spike.md), part 2 of 2:
// classifies findAnchors' (anchors.ts) output into a connected shape
// (DIRECT / INFERRED / AMBIGUOUS) for the spike's one target slug, and
// attributes the result to the selected author by file intersection with
// their added-lines diff. Same posture as every other proof-graph module:
// deterministic, in-memory, zero network — this file never calls out to
// anything beyond a local `git show` (via collectUserTouchedFiles) and never
// writes anywhere.
//
// IMPORTANT — this is a SPIKE-ONLY structure. Per docs/proof-graph-spike.md's
// "Invariants", StructuralFinding must NEVER gain a toJSON method and must
// NEVER be JSON.stringify'd into `scan` output or a bundle. test/privacy/
// (H3) is expected to enforce this at the privacy-test layer; this comment
// is the code-level half of that guarantee.
import { loadTaxonomySlugs } from "../skill-detect.js";
import { getCommitsAddedLines, type RawCommit } from "../git.js";
import { isExcludedPath } from "../churn-exclusions.js";
import { ScanError } from "../errors.js";
import { WEBHOOK_PROVIDERS, IAP_PACKAGES } from "./anchors.js";
import type { AnchorHit, AnchorKind } from "./anchors.js";
import type { ProofGraph } from "./graph.js";

// -----------------------------------------------------------------------
// STRUCTURAL_PATTERNS — H6 phase 1 made this module iterate a pattern table
// instead of hardcoding the single Stripe/webhook shape. `kind` is a
// discriminated-union tag; phase 2a (this file's current state) adds the
// "iap-flow" member it was left room for — RevenueCat-style in-app-purchase
// flows, which have no "webhook verification" node at all, a genuinely
// different connected shape (see anchors.ts's own IAP section comment).
//
// Phase 1's table was derived 1:1 from WEBHOOK_PROVIDERS (anchors.ts) and
// had exactly one entry (Stripe) — an intentionally-provable-no-op posture.
// Phase 2a's 4 new webhook providers (PayPal, Mercado Pago, Lemon Squeezy,
// Paddle) still appear here automatically, with zero change to THIS file,
// the moment they're added to WEBHOOK_PROVIDERS — see WEBHOOK_FLOW_PATTERNS
// below. The one new "iap-flow" entry is a hand-written literal instead,
// since it isn't derived from WEBHOOK_PROVIDERS at all.
export type StructuralPatternKind = "webhook-flow" | "iap-flow";

export interface StructuralPattern {
  /** Taxonomy slug (taxonomy.json) this pattern's classification produces. */
  slug: string;
  kind: StructuralPatternKind;
  /** npm specifiers that identify this pattern's provider/library — reused
   * by the generalized AMBIGUOUS gate below (see hasExternalImportForPackages). */
  packages: string[];
  /**
   * The 3 anchor kinds (in the SAME positional order
   * findSameFunctionTriple/findSameFileTriple/findInferredTriple's first/
   * second/third parameters expect) that make up this pattern's
   * DIRECT/INFERRED connected shape. `anchorKinds[0]` is this pattern's
   * PRIMARY anchor by convention — the one whose lone presence (without the
   * other two) already means "ambiguous", not "nothing at all" (mirrors how
   * a webhook-verification anchor alone already meant that for the
   * single-pattern phase-1 version of this module; see the AMBIGUOUS gate
   * below).
   *
   * For every "webhook-flow" pattern this is
   * ["webhook-verification","db-write","idempotency-guard"] — the exact
   * shape findSameFunctionTriple/findSameFileTriple/findInferredTriple were
   * originally written for. "iap-flow" uses this SAME machinery with its
   * own, entirely different 3 kinds
   * (["iap-configure","iap-purchase","iap-entitlement-gate"]) — this needed
   * ZERO changes to those three functions, because none of them ever
   * inspects AnchorHit.kind itself; they only compare `path`/
   * `enclosingFunction` between whatever 3 AnchorHit arrays their caller
   * passes in. The "generalization over which 3 kinds" this milestone's
   * task asked for therefore lives entirely in this field plus
   * anchorsForPatternKind below, not in the search functions.
   */
  anchorKinds: [AnchorKind, AnchorKind, AnchorKind];
  /**
   * OPTIONAL (H6 phase 2a, Mercado Pago only today) — ADDITIVE. Per-pattern
   * anchor kinds that are NOT required for a finding to exist at all, but
   * CAP the resulting confidence when globally absent (zero anchors of that
   * kind anywhere in the repo — idempotency-guard is provider-agnostic/
   * shared across every pattern, so "for this pattern" and "globally" are
   * the same check; see anchorsForPatternKind). Mercado Pago's shape is
   * creation-call + webhook/IPN -> DB write, with an idempotency guard
   * being common but not universal in real integrations: when it's
   * present, this pattern classifies exactly like any other webhook-flow
   * pattern (DIRECT reachable); when it's missing, the pattern still
   * classifies — via the 2-kind PAIR search (findSameFunctionPair/
   * findSameFilePair/findInferredPair, additive siblings of the existing
   * triple functions, added because degrading a 3-ary function to 2
   * arguments would have needed a signature change the "reuse... byte for
   * byte" plan above deliberately avoided) — but the resulting confidence
   * is capped at `maxConfidenceWithoutOptional` REGARDLESS of which
   * connectivity tier the pair search found (so even a same-function pair
   * — which for a normal 3-kind pattern would be DIRECT — comes out
   * "inferred" here): a payment webhook flow with no idempotency guard
   * anywhere in the repo is real, provable connectivity, but not the same
   * strength of claim as one that also guards against double-processing.
   * `connection` still reports the ACTUAL topology found (same-function /
   * same-file / cross-file) — only `confidence` is capped, so `explain`
   * output stays fully honest about both facts at once.
   *
   * Data-shaped (a table entry, not an if/else in inferStructuralSkills) so
   * a future pattern with its own optional-kind rule is a table edit, not
   * new branching logic.
   */
  optionalAnchorKinds?: { kind: AnchorKind; maxConfidenceWithoutOptional: StructuralConfidence }[];
}

const WEBHOOK_FLOW_ANCHOR_KINDS: [AnchorKind, AnchorKind, AnchorKind] = ["webhook-verification", "db-write", "idempotency-guard"];

// Mercado Pago's own slug, per its WEBHOOK_PROVIDERS descriptor in
// anchors.ts — matched by slug (not by object identity) because
// STRUCTURAL_PATTERNS derives fresh objects from WEBHOOK_PROVIDERS below,
// not the descriptors themselves.
const MERCADOPAGO_SLUG = "payments/mercadopago-flow";

export const STRUCTURAL_PATTERNS: StructuralPattern[] = [
  ...WEBHOOK_PROVIDERS.map(
    (provider): StructuralPattern => ({
      slug: provider.slug,
      kind: "webhook-flow",
      packages: provider.packages,
      anchorKinds: WEBHOOK_FLOW_ANCHOR_KINDS,
      // See StructuralPattern.optionalAnchorKinds' own comment for why
      // Mercado Pago is the one pattern that gets this.
      ...(provider.slug === MERCADOPAGO_SLUG
        ? { optionalAnchorKinds: [{ kind: "idempotency-guard" as AnchorKind, maxConfidenceWithoutOptional: "inferred" as StructuralConfidence }] }
        : {}),
    })
  ),
  {
    slug: "payments/iap-subscription-flow",
    kind: "iap-flow",
    packages: IAP_PACKAGES, // derived from anchors.ts's own IAP_PACKAGES — see that constant's own comment
    anchorKinds: ["iap-configure", "iap-purchase", "iap-entitlement-gate"],
  },
];

// Deprecated alias for the (today, only) Stripe pattern's slug — kept for
// explain-command.ts and existing tests, which reference this constant by
// name rather than by indexing STRUCTURAL_PATTERNS. Kept as its own literal
// (not derived from STRUCTURAL_PATTERNS[0]) so this alias can never throw or
// go undefined if a future edit reorders/empties WEBHOOK_PROVIDERS — it is
// intentionally the LAST thing anyone should still depend on; new code
// should read STRUCTURAL_PATTERNS instead.
//
// Named in code (unlike signatures/*.json's slugs, which are pure data) —
// but that's a convenience for this experimental module's own readability,
// NOT a bypass of the closed-vocabulary rule. inferStructuralSkills below
// still validates every STRUCTURAL_PATTERNS slug (this one included, today)
// against the real taxonomy.json at runtime, in the function real code
// calls, mirroring skill-detect.ts's compile() (see its own "Defense in
// depth" comment) — a hardcoded slug string is exactly the kind of thing a
// future refactor could silently drift from taxonomy.json without this
// check.
export const STRUCTURAL_SKILL_SLUG = "payments/payment-webhook-flow";

export type StructuralConfidence = "direct" | "inferred" | "ambiguous";

export interface StructuralFinding {
  slug: string;
  confidence: StructuralConfidence;
  /** >=1 anchor-containing file (among the anchors that support THIS
   * finding, not the whole anchor pool) is in the caller-supplied
   * userTouchedFiles set. */
  attributed: boolean;
  /** true ONLY if confidence is "direct" or "inferred" AND attributed. An
   * ambiguous finding NEVER claims (see docs/proof-graph-spike.md's H3 false
   * -negative case), and an unattributed finding NEVER claims either — this
   * field is THE gate: an unclaimed finding exists only for local `explain`
   * output (H4), never for any bundle. */
  claimed: boolean;
  anchors: AnchorHit[];
  /** null for ambiguous (there is no single connected shape to describe);
   * edgeDistance is always 0 for both direct variants (same-function and
   * same-file are, definitionally, zero file-hops apart) and 1-3 for
   * "cross-file" (inferred). */
  connection: null | { kind: "same-function" | "same-file" | "cross-file"; edgeDistance: number };
  /** Present (always `true`) ONLY when the cross-file INFERRED search hit
   * INFER_WORK_BUDGET before finishing and this finding degraded to
   * AMBIGUOUS as a result — see findInferredTriple's own comment on why a
   * deterministic work budget, not a wall-clock timeout, is what "never
   * hangs" means for this module. Absent (not just `false`) in every other
   * case, so a plain `finding.searchBounded` check (no `=== true` needed)
   * distinguishes "degraded by the budget" from "genuinely not connected
   * closely enough" or "not even attempted" (DIRECT/no-finding). */
  searchBounded?: true;
}

// -----------------------------------------------------------------------
// Deterministic ordering, mirroring anchors.ts's own (private, unexported)
// sortHits — duplicated here rather than imported because anchors.ts
// deliberately keeps it module-private (findAnchors' own output is already
// sorted; this module needs the same comparator for anchor SUBSETS it picks
// out of that output, e.g. a same-file triple assembled from unsorted
// filter() results). Same three-key comparator: path, then line, then kind.
// -----------------------------------------------------------------------
function sortAnchorHits(hits: AnchorHit[]): AnchorHit[] {
  return [...hits].sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    if (a.line !== b.line) return a.line - b.line;
    if (a.kind !== b.kind) return (a.kind < b.kind ? -1 : 1);
    return 0;
  });
}

// -----------------------------------------------------------------------
// DIRECT — same-function / same-file
// -----------------------------------------------------------------------

type Triple = [AnchorHit, AnchorHit, AnchorHit];

// H6 phase 2a note (no behavior change — the two functions below are
// UNCHANGED from phase 1, byte for byte): despite the `webhook`/`dbWrite`/
// `idempotency` parameter names (kept as-is for readability against their
// original, still-primary use case), neither function ever inspects
// AnchorHit.kind — they only compare `path`/`enclosingFunction` across
// whatever 3 arrays their caller passes in. inferStructuralSkills' "iap-
// flow" pattern below reuses BOTH functions unchanged, passing
// iap-configure/iap-purchase/iap-entitlement-gate anchors in those same 3
// positional slots — see StructuralPattern.anchorKinds' own comment.
//
// Rule: at least one anchor of EACH of the 3 kinds where all three share
// BOTH path and enclosingFunction. Iterates in sorted order so the first
// match found is deterministic regardless of the input arrays' own order
// (the caller's anchors come from a plain Array#filter over `anchors`,
// which is NOT guaranteed sorted the way findAnchors' full output is).
function findSameFunctionTriple(webhook: AnchorHit[], dbWrite: AnchorHit[], idempotency: AnchorHit[]): Triple | null {
  const dbSorted = sortAnchorHits(dbWrite);
  const idemSorted = sortAnchorHits(idempotency);
  for (const w of sortAnchorHits(webhook)) {
    for (const d of dbSorted) {
      if (d.path !== w.path || d.enclosingFunction !== w.enclosingFunction) continue;
      for (const i of idemSorted) {
        if (i.path === w.path && i.enclosingFunction === w.enclosingFunction) return [w, d, i];
      }
    }
  }
  return null;
}

// Rule: all 3 kinds present in the same file (any function, or module top
// level) — weaker than same-function, only tried once same-function fails.
function findSameFileTriple(webhook: AnchorHit[], dbWrite: AnchorHit[], idempotency: AnchorHit[]): Triple | null {
  const dbSorted = sortAnchorHits(dbWrite);
  const idemSorted = sortAnchorHits(idempotency);
  for (const w of sortAnchorHits(webhook)) {
    const d = dbSorted.find((x) => x.path === w.path);
    if (!d) continue;
    const i = idemSorted.find((x) => x.path === w.path);
    if (i) return [w, d, i];
  }
  return null;
}

// H6 phase 2a — ADDITIVE siblings of findSameFunctionTriple/
// findSameFileTriple, added ONLY for Mercado Pago's "idempotency-guard
// missing entirely" case (see StructuralPattern.optionalAnchorKinds' own
// comment). A 2-ary version can't be expressed by calling the 3-ary
// functions above with an empty third array — an empty group would just
// make the innermost loop never execute, returning null unconditionally,
// which is NOT "search for a connected PAIR" — so these are genuinely
// separate, smaller functions rather than a parameter-count trick. Exact
// same "first found, in sorted order, wins" determinism as their triple
// counterparts.
type Pair = [AnchorHit, AnchorHit];

function findSameFunctionPair(a: AnchorHit[], b: AnchorHit[]): Pair | null {
  const bSorted = sortAnchorHits(b);
  for (const x of sortAnchorHits(a)) {
    for (const y of bSorted) {
      if (y.path === x.path && y.enclosingFunction === x.enclosingFunction) return [x, y];
    }
  }
  return null;
}

function findSameFilePair(a: AnchorHit[], b: AnchorHit[]): Pair | null {
  const bSorted = sortAnchorHits(b);
  for (const x of sortAnchorHits(a)) {
    const y = bSorted.find((z) => z.path === x.path);
    if (y) return [x, y];
  }
  return null;
}

// -----------------------------------------------------------------------
// INFERRED — cross-file, connected within <=3 edges of undirected
// file-adjacency built from the graph's RESOLVED import edges.
//
// Deliberate simplification (per the milestone's hard timebox — see
// docs/proof-graph-spike.md's H2 entry): "connected" here means reachable
// through relative import edges (graph.importEdgesOf, resolvedPath !=
// null), NOT the graph's own call-edge resolution (resolveCallTargets).
// A handler that imports a service module and calls one of its exports is
// exactly the shape import edges already capture; walking actual call
// edges instead would need to handle indirect calls (a value passed
// through several layers before being invoked) that the spike's syntactic,
// no-type-checker posture can't resolve reliably anyway (see graph.ts's own
// resolveCallTargets doc comment on its limited rule set). Import-edge
// co-location is the documented, narrower signal this milestone settled on
// instead of chasing full call-graph precision — full receiver resolution
// (anchors.ts) shipped as planned; this file-adjacency approximation is the
// ONE place H2 narrowed scope, and only here.
// -----------------------------------------------------------------------

function buildFileAdjacency(graph: ProofGraph): Map<string, Set<string>> {
  const adjacency = new Map<string, Set<string>>();
  const ensure = (path: string): Set<string> => {
    let set = adjacency.get(path);
    if (!set) {
      set = new Set();
      adjacency.set(path, set);
    }
    return set;
  };
  for (const path of graph.files()) {
    ensure(path);
    for (const edge of graph.importEdgesOf(path)) {
      if (edge.resolvedPath === null) continue;
      ensure(path).add(edge.resolvedPath);
      ensure(edge.resolvedPath).add(path);
    }
  }
  return adjacency;
}

// Shared by bfsDistances (the search radius BFS itself never needs to
// explore past) and findInferredTriple (the actual INFERRED-eligibility
// bound applied to the max of the three pairwise distances) — a single
// module-level constant so the two can never drift apart. findInferredTriple
// used to declare its own local copy of this value; bfsDistances is its
// only other consumer, and both need the exact same number, so hoisting it
// here is the one-source-of-truth fix, not just a style choice.
const MAX_EDGE_DISTANCE = 3;

/**
 * BFS distances from `from`, capped at MAX_EDGE_DISTANCE. findInferredTriple
 * (this function's only caller, via distanceBetween) only ever cares
 * whether a distance is `<= MAX_EDGE_DISTANCE` — anything past that is
 * treated identically to "unreachable" (distanceBetween's own `?? Number
 * .POSITIVE_INFINITY` fallback for a path not present in the returned map
 * doesn't distinguish "too far" from "no path at all", and the caller's own
 * `> MAX_EDGE_DISTANCE` checks treat both the same way).
 *
 * Semantics-preserving by construction: BFS visits nodes in non-decreasing
 * distance order, so stopping enqueue once `currentDistance >=
 * MAX_EDGE_DISTANCE` never skips a node the caller can actually use —
 * every node within the cap is still visited and gets its exact correct
 * distance; only nodes STRICTLY PAST the cap are pruned, and those would
 * have been read back as "too far, treat as unreachable" anyway. What this
 * caps is pure waste, not behavior: an uncapped BFS would additionally walk
 * (and, via INFER_WORK_BUDGET's per-BFS `workUnits += fromA.size`
 * accounting, pay the work-budget cost for) every remaining node in a large
 * connected component, even though nothing past distance 3 can ever change
 * findInferredTriple's outcome. Left uncapped, that inflates the shared
 * work counter by up to the WHOLE component's size per distinct anchor
 * file BFS'd from — on a large, well-connected repo (many distinct anchor
 * files, one big component) that alone can trip INFER_WORK_BUDGET and
 * spuriously degrade to `searchBounded`/AMBIGUOUS a repo the depth-capped
 * design should classify fully.
 */
function bfsDistances(adjacency: Map<string, Set<string>>, from: string): Map<string, number> {
  const distances = new Map<string, number>([[from, 0]]);
  const queue: string[] = [from];
  let head = 0;
  while (head < queue.length) {
    const current = queue[head++];
    const currentDistance = distances.get(current)!;
    if (currentDistance >= MAX_EDGE_DISTANCE) continue; // nothing past the cap is ever useful to visit
    for (const neighbor of adjacency.get(current) ?? []) {
      if (!distances.has(neighbor)) {
        distances.set(neighbor, currentDistance + 1);
        queue.push(neighbor);
      }
    }
  }
  return distances;
}

// Deterministic work budget for the cross-file search below (see
// findInferredTriple's own comment for the full rationale). Counts two
// things against ONE shared counter: (a) every full (webhook-file,
// db-write-file, idempotency-file) triple actually evaluated by the inner
// loop, and (b) every node a BFS visits while computing a fresh distance
// cache entry — capped at MAX_EDGE_DISTANCE per BFS run (see bfsDistances'
// own comment): only nodes within the cap can ever affect
// findInferredTriple's outcome, so walking (and charging work-budget cost
// for) the rest of a large connected component would be pure waste, not
// real search work. Both scale with the real work findInferredTriple does,
// so a single budget bounds the whole search regardless of which of the
// two dominates for a given repo's shape (many distinct anchor files vs. a
// large/dense import graph).
//
// Why a WORK BUDGET and not a wall-clock timeout (the owner's original ask
// was "timeout with clean degradation"): a wall-clock cut makes the
// classification depend on how fast the machine happens to be at the
// moment it runs — the same repo could classify INFERRED on a fast/idle
// machine and AMBIGUOUS-by-timeout on a loaded CI runner or an older
// laptop, which breaks this whole spike's "same input -> same output,
// always" invariant (see this file's own module doc comment and
// docs/proof-graph-spike.md's Invariants). A deterministic unit count gives
// the exact same guarantee the owner actually wants ("this can never hang
// the terminal") without that nondeterminism: the same graph + same
// anchors always perform the exact same number of counted work units, so
// they always land on the same side of the budget, on any machine, under
// any load.
//
// Value: comfortably above every normal (even fairly dense) repo's real
// work count — see test/proof-graph/scale.test.ts's "300 files, 40 db
// calls/file, 20% stripe noise" case, measured at 631,652 work units
// (~3.2x of headroom under this budget, not the "order of magnitude" this
// comment used to (incorrectly) claim before the number was actually
// measured) — and comfortably below the territory where the PRE-FIX
// anchor-instance-level search used to hang (this file-level rewrite's
// worst case is bounded by distinct FILE counts, not anchor INSTANCE
// counts, so it never gets remotely close to this budget on realistic
// repos in the first place; the budget exists for the
// pathological/adversarial shapes that push distinct-file counts high too
// — see scale.test.ts's dedicated budget-exceeding case). 3.2x is real
// headroom, not a thin margin: that scale.test.ts fixture is already
// engineered to be denser than any real repo measured so far (see
// docs/proof-graph-spike.md's "Scale hardening" before/after table), and
// the BFS depth cap above additionally keeps large-but-well-connected real
// repos (e.g. fixture-2000 in the diagnosis harness) well under budget too
// — see that same table for the measured before/after work counts.
export const INFER_WORK_BUDGET = 2_000_000;

// -----------------------------------------------------------------------
// SearchBudgetState — H6 phase 1: with STRUCTURAL_PATTERNS now iterable
// (today: one entry), inferStructuralSkills creates exactly ONE of these per
// call and threads it through every pattern's findInferredTriple invocation,
// so INFER_WORK_BUDGET bounds the WHOLE run's cross-file search work, not
// each pattern's search independently — a repo with N webhook providers
// present can't spend up to N x INFER_WORK_BUDGET total work units just
// because N patterns each get their own fresh counter. This is a deliberate
// choice, not an oversight: the "never hangs the terminal" guarantee
// (INFER_WORK_BUDGET's own comment) is about wall-clock-equivalent work for
// one `redential scan` invocation as a whole, not about any single pattern
// in isolation. distanceCache is shared for the same reason AND because it's
// a legitimate optimization: file-adjacency distances don't depend on which
// pattern asked for them, so a distance computed while classifying one
// pattern is exactly reusable for the next. With today's single-pattern
// table this is unobservable (there is only ever one findInferredTriple call
// per inferStructuralSkills call, so a shared vs. per-pattern counter behave
// identically) — this exists for phase 2's multi-provider case.
interface SearchBudgetState {
  workUnits: number;
  distanceCache: Map<string, Map<string, number>>;
}

function createSearchBudgetState(): SearchBudgetState {
  return { workUnits: 0, distanceCache: new Map() };
}

/**
 * Finds the anchor triple (one per kind) whose maximum pairwise
 * file-adjacency distance is smallest and <= 3, per the milestone's INFERRED
 * rule. Only reached once findSameFileTriple has already failed to find a
 * single file holding all 3 kinds — so by construction every candidate
 * triple here spans more than one file, satisfying "across multiple files".
 *
 * FILE-LEVEL search, not anchor-INSTANCE-level (the pre-fix version of this
 * function searched every (webhook anchor, db-write anchor, idempotency
 * anchor) INSTANCE triple — O(W×D×I) over anchor counts, which on a dense
 * real repo (many DB call sites per file) reaches billions of combinations;
 * see docs/proof-graph-spike.md's "Scale hardening" subsection for the full
 * diagnosis). Connectivity distance (distanceBetween, via graph import
 * edges) is inherently FILE-level already — distanceBetween takes paths,
 * never anchors — so multiple anchors of the same kind in the same file are
 * indistinguishable for the purpose of this search: they always produce the
 * exact same pairwise distances. Collapsing each anchor kind to its sorted
 * set of DISTINCT FILES first (distinctSortedPaths) and searching FILE
 * triples is therefore an exact equivalence, not an approximation: |files|
 * is orders of magnitude below |anchors| on exactly the dense repos where
 * the old search blew up, while the set of (file-triple, edgeDistance)
 * pairs it can find is identical.
 *
 * Determinism of the file-triple search matches the pre-fix anchor-level
 * one exactly: sortAnchorHits' (path, then line) order means that, for a
 * fixed path, the FIRST anchor of a given kind encountered in sorted order
 * is always the lowest-line one in that file — so the old nested loop over
 * sorted ANCHOR instances visited each distinct file's anchors as a
 * contiguous run, all sharing the same pairwise distances, in the exact
 * same file-visitation order this function's nested loop over sorted
 * DISTINCT FILES uses. A "first found wins ties" search (this function's
 * `<` comparison, unchanged) therefore converges on the identical
 * (best.wPath, best.dPath, best.iPath) triple either way — and once that
 * file triple is fixed, pickRepresentativeAnchor's "first by
 * sortAnchorHits order" selection recovers exactly the specific AnchorHit
 * (lowest line in that file) the old anchor-level loop would have picked as
 * part of the very same first-found triple. See
 * test/proof-graph/infer.test.ts / detection.test.ts, whose assertions on
 * the resulting `finding.anchors`/`connection` are unchanged by this
 * rewrite.
 *
 * Returns `{ result: null, bounded: false }` if no combination connects
 * within the 3-edge bound (or at all). Returns `{ result: null, bounded:
 * true }` if INFER_WORK_BUDGET is exhausted before the search finishes —
 * the caller treats this exactly like "not connected" (AMBIGUOUS) but
 * additionally marks the finding as `searchBounded`, per this module's own
 * "never claims from an incomplete search" posture: a partially-completed
 * search might have been about to find a connected triple, so reporting
 * "not found" plainly (without the budget flag) would be misleading, but
 * reporting whatever partial "best so far" the search had would make the
 * result depend on iteration order/budget placement in a way that isn't a
 * genuine claim about the repo's structure either. Discarding the partial
 * best and flagging the degradation is the deterministic, honest answer.
 */
function findInferredTriple(
  adjacency: Map<string, Set<string>>,
  webhook: AnchorHit[],
  dbWrite: AnchorHit[],
  idempotency: AnchorHit[],
  // Shared across every pattern in one inferStructuralSkills call — see
  // SearchBudgetState's own comment on why one counter/cache, not one per
  // call to this function.
  budget: SearchBudgetState
): { result: { triple: Triple; edgeDistance: number } | null; bounded: boolean } {
  // MAX_EDGE_DISTANCE is now a module-level constant (shared with
  // bfsDistances' own depth cap) — see its own comment above bfsDistances.

  const distinctSortedPaths = (hits: AnchorHit[]): string[] => {
    const seen = new Set<string>();
    const paths: string[] = [];
    for (const hit of sortAnchorHits(hits)) {
      if (!seen.has(hit.path)) {
        seen.add(hit.path);
        paths.push(hit.path);
      }
    }
    return paths;
  };

  const webhookFiles = distinctSortedPaths(webhook);
  const dbWriteFiles = distinctSortedPaths(dbWrite);
  const idempotencyFiles = distinctSortedPaths(idempotency);

  // Shared across every pattern in one inferStructuralSkills call — see
  // SearchBudgetState's own comment on what it counts and why a single
  // counter (not one per sub-search, and — as of H6 phase 1 — not one per
  // pattern either) is the right unit of "how much work has this run done".
  let bounded = false;

  // BFS is run at most once per distinct source FILE across the WHOLE run
  // (cached in budget.distanceCache, shared across patterns), not once per
  // candidate pair — cheap even with several distinct anchor files on each
  // side.
  const distanceCache = budget.distanceCache;
  const distanceBetween = (a: string, b: string): number => {
    if (a === b) return 0;
    let fromA = distanceCache.get(a);
    if (!fromA) {
      fromA = bfsDistances(adjacency, a);
      distanceCache.set(a, fromA);
      // Counted once per fresh BFS (cache miss), not per lookup: a cached
      // distanceBetween call is an O(1) map read, not real search work.
      budget.workUnits += fromA.size;
    }
    return fromA.get(b) ?? Number.POSITIVE_INFINITY;
  };

  let best: { wPath: string; dPath: string; iPath: string; edgeDistance: number } | null = null;

  searchLoop: for (const wPath of webhookFiles) {
    for (const dPath of dbWriteFiles) {
      if (budget.workUnits > INFER_WORK_BUDGET) {
        bounded = true;
        break searchLoop;
      }
      const wd = distanceBetween(wPath, dPath);
      if (budget.workUnits > INFER_WORK_BUDGET) {
        bounded = true;
        break searchLoop;
      }
      if (wd > MAX_EDGE_DISTANCE) continue; // the max of the three can only grow from here
      for (const iPath of idempotencyFiles) {
        budget.workUnits++; // one file-triple evaluation
        if (budget.workUnits > INFER_WORK_BUDGET) {
          bounded = true;
          break searchLoop;
        }
        const wi = distanceBetween(wPath, iPath);
        const di = distanceBetween(dPath, iPath);
        const maxDistance = Math.max(wd, wi, di);
        if (maxDistance > MAX_EDGE_DISTANCE) continue;
        if (!best || maxDistance < best.edgeDistance) best = { wPath, dPath, iPath, edgeDistance: maxDistance };
      }
    }
  }

  if (bounded) return { result: null, bounded: true };
  if (!best) return { result: null, bounded: false };

  // Deterministically recover the representative AnchorHit per chosen file
  // — first by sortAnchorHits order (path, then line) — see this
  // function's own doc comment for why this is an exact match for what the
  // pre-fix anchor-instance-level search would have picked.
  const pickRepresentativeAnchor = (hits: AnchorHit[], path: string): AnchorHit => {
    const found = sortAnchorHits(hits).find((h) => h.path === path);
    // Defensive only: `path` always comes from `hits` itself via
    // distinctSortedPaths above, so a miss here would mean this function's
    // own invariant broke, not a real runtime condition.
    if (!found) throw new ScanError(`Internal error: no anchor found for path "${path}" while resolving an INFERRED triple.`);
    return found;
  };

  const triple: Triple = [
    pickRepresentativeAnchor(webhook, best.wPath),
    pickRepresentativeAnchor(dbWrite, best.dPath),
    pickRepresentativeAnchor(idempotency, best.iPath),
  ];
  return { result: { triple, edgeDistance: best.edgeDistance }, bounded: false };
}

// H6 phase 2a — ADDITIVE sibling of findInferredTriple, for Mercado Pago's
// "idempotency-guard globally missing" case only (see
// StructuralPattern.optionalAnchorKinds' own comment and
// findSameFunctionPair's own comment on why a smaller dedicated function,
// not a parameter trick on the 3-ary version). Same MAX_EDGE_DISTANCE cap,
// same SHARED SearchBudgetState/distanceCache (a pair search costs
// strictly LESS work than a triple search over the same files — one nested
// loop instead of two — so reusing the same budget only ever makes it
// EASIER to stay under INFER_WORK_BUDGET, never harder), same "never
// claims from an incomplete search" posture (`bounded: true` on budget
// exhaustion, discarding whatever partial best existed).
function findInferredPair(
  adjacency: Map<string, Set<string>>,
  a: AnchorHit[],
  b: AnchorHit[],
  budget: SearchBudgetState
): { result: { pair: Pair; edgeDistance: number } | null; bounded: boolean } {
  const distinctSortedPaths = (hits: AnchorHit[]): string[] => {
    const seen = new Set<string>();
    const paths: string[] = [];
    for (const hit of sortAnchorHits(hits)) {
      if (!seen.has(hit.path)) {
        seen.add(hit.path);
        paths.push(hit.path);
      }
    }
    return paths;
  };

  const aFiles = distinctSortedPaths(a);
  const bFiles = distinctSortedPaths(b);

  let bounded = false;

  const distanceCache = budget.distanceCache;
  const distanceBetween = (x: string, y: string): number => {
    if (x === y) return 0;
    let fromX = distanceCache.get(x);
    if (!fromX) {
      fromX = bfsDistances(adjacency, x);
      distanceCache.set(x, fromX);
      budget.workUnits += fromX.size;
    }
    return fromX.get(y) ?? Number.POSITIVE_INFINITY;
  };

  let best: { aPath: string; bPath: string; edgeDistance: number } | null = null;

  searchLoop: for (const aPath of aFiles) {
    for (const bPath of bFiles) {
      budget.workUnits++; // one file-pair evaluation
      if (budget.workUnits > INFER_WORK_BUDGET) {
        bounded = true;
        break searchLoop;
      }
      const distance = distanceBetween(aPath, bPath);
      if (budget.workUnits > INFER_WORK_BUDGET) {
        bounded = true;
        break searchLoop;
      }
      if (distance > MAX_EDGE_DISTANCE) continue;
      if (!best || distance < best.edgeDistance) best = { aPath, bPath, edgeDistance: distance };
    }
  }

  if (bounded) return { result: null, bounded: true };
  if (!best) return { result: null, bounded: false };

  const pickRepresentativeAnchor = (hits: AnchorHit[], path: string): AnchorHit => {
    const found = sortAnchorHits(hits).find((h) => h.path === path);
    if (!found) throw new ScanError(`Internal error: no anchor found for path "${path}" while resolving an INFERRED pair.`);
    return found;
  };

  const pair: Pair = [pickRepresentativeAnchor(a, best.aPath), pickRepresentativeAnchor(b, best.bPath)];
  return { result: { pair, edgeDistance: best.edgeDistance }, bounded: false };
}

// -----------------------------------------------------------------------
// AMBIGUOUS
// -----------------------------------------------------------------------

// Generalized (H6 phase 1) version of what used to be a single
// hasStripeExternalImport check hardcoded to STRIPE_IMPORT_SPECIFIER: any
// pattern's `packages` list (STRUCTURAL_PATTERNS, itself sourced from
// WEBHOOK_PROVIDERS' own `packages` — see anchors.ts) is a raw npm import
// specifier list, not a taxonomy slug — same "spike detector data" status as
// every table in anchors.ts (see that file's own comment on why that's
// unrelated to the closed-vocabulary rule). With today's single-entry
// STRUCTURAL_PATTERNS table (`packages: ["stripe"]`), this produces
// byte-for-byte the same decision as the old hardcoded check.
function hasExternalImportForPackages(graph: ProofGraph, packages: string[]): boolean {
  const packageSet = new Set(packages);
  return graph.files().some((path) => graph.externalImportsOf(path).some((imp) => packageSet.has(imp.specifier)));
}

// -----------------------------------------------------------------------
// inferStructuralSkills
// -----------------------------------------------------------------------

function buildFinding(
  slug: string,
  confidence: StructuralConfidence,
  supportingAnchors: AnchorHit[],
  connection: StructuralFinding["connection"],
  userTouchedFiles: ReadonlySet<string>,
  searchBounded?: true
): StructuralFinding {
  // Attribution is computed over the anchors that actually SUPPORT this
  // finding (the chosen triple for direct/inferred; whatever partial
  // anchors exist for ambiguous) — never the whole anchor pool findAnchors
  // returned, which could include anchors from an unrelated part of the
  // codebase that happens to also touch stripe/DB packages.
  const attributed = supportingAnchors.some((a) => userTouchedFiles.has(a.path));
  // THE gate (see StructuralFinding.claimed's own comment): ambiguous never
  // claims regardless of attribution; direct/inferred claim only when
  // attributed.
  const claimed = confidence !== "ambiguous" && attributed;
  const finding: StructuralFinding = {
    slug,
    confidence,
    attributed,
    claimed,
    anchors: sortAnchorHits(supportingAnchors),
    connection,
  };
  // Only ever set (to `true`) when the caller explicitly passes it — see
  // StructuralFinding.searchBounded's own comment on why "absent" (not
  // "false") is this field's normal state.
  if (searchBounded) finding.searchBounded = true;
  return finding;
}

// Resolves the AnchorHit array for one (pattern, anchorKind) pair.
// "webhook-verification" is the one kind that needs PER-PATTERN filtering
// (by AnchorHit.providerSlug — a payment-webhook-flow pattern must never
// see another provider's webhook hits); every other kind (db-write,
// idempotency-guard, and the 3 iap-* kinds) is provider-agnostic (see
// WEBHOOK_PROVIDERS' own comment in anchors.ts and anchors.ts's IAP section
// comment) and therefore SHARED across every pattern that uses it — cached
// by kind in `cache` so it's still only filtered once per distinct kind
// across the whole inferStructuralSkills call, same "computed once, not
// re-filtered per pattern" posture the phase-1 version had for db-write/
// idempotency-guard specifically.
function anchorsForPatternKind(
  anchors: AnchorHit[],
  kind: AnchorKind,
  pattern: StructuralPattern,
  cache: Map<AnchorKind, AnchorHit[]>
): AnchorHit[] {
  if (kind === "webhook-verification") {
    return anchors.filter((a) => a.kind === "webhook-verification" && a.providerSlug === pattern.slug);
  }
  let cached = cache.get(kind);
  if (!cached) {
    cached = anchors.filter((a) => a.kind === kind);
    cache.set(kind, cached);
  }
  return cached;
}

/**
 * Classifies findAnchors' output into a connected shape PER PATTERN in
 * STRUCTURAL_PATTERNS and attributes each finding to the caller-supplied
 * touched-files set. Deterministic: same graph + same anchors + same
 * userTouchedFiles always produce the same result array, sorted by slug.
 *
 * For EACH pattern, classification order is first-match-wins, scoped to
 * that pattern's own 3 anchorKinds (see StructuralPattern.anchorKinds' own
 * comment — `anchorsForPatternKind` above resolves each of the 3 kinds to
 * the right AnchorHit array, filtering by providerSlug ONLY for
 * "webhook-verification"):
 *   1. DIRECT (same-function, else same-file) — only tried when all 3 of
 *      this pattern's anchor kinds are present, UNLESS this pattern has an
 *      optionalAnchorKinds entry whose kind is globally ABSENT (zero
 *      anchors of that kind anywhere) — see step 1b.
 *   1b. Mercado Pago's optional-idempotency case ONLY (see
 *      StructuralPattern.optionalAnchorKinds' own comment): when the
 *      optional kind is missing, run the 2-kind PAIR search
 *      (findSameFunctionPair / findSameFilePair / findInferredPair) over
 *      the remaining 2 required kinds instead, and cap the resulting
 *      confidence at `maxConfidenceWithoutOptional` regardless of which
 *      tier the pair search found — `connection` still reports the ACTUAL
 *      topology found.
 *   2. INFERRED (cross-file, connected within <=3 edges) — only reached
 *      when DIRECT (1 or 1b) didn't fire, still gated on the same
 *      kind-presence rules. Uses a SINGLE SearchBudgetState shared across
 *      every pattern AND every triple/pair search in this call — see that
 *      type's own comment on why the never-hangs guarantee is per-run, not
 *      per-pattern-or-search.
 *   3. AMBIGUOUS — reached whenever neither of the above fired (including
 *      "all required kinds present but not connected closely enough"), AND
 *      either this pattern's provider package is imported anywhere in the
 *      graph OR this pattern's PRIMARY anchor kind (anchorKinds[0]) has a
 *      hit on its own. Never claims (see StructuralFinding's own comment)
 *      — this is the one shape that surfaces ONLY via a future local-only
 *      `redential explain` (H4), never a bundle. Carries ONLY this
 *      pattern's OWN anchors (this pattern's 3 anchorKinds, filtered the
 *      same way as everywhere else in this function) — NOT the whole
 *      cross-provider anchor pool findAnchors returned (fixed in H6 phase
 *      2a, per the reviewer note on phase 1: an ambiguous finding used to
 *      carry every anchor in the repo, including other providers'/
 *      patterns' hits that have nothing to do with THIS finding).
 *   4. No finding at all for this pattern — no provider presence anywhere
 *      and no anchors for it: there is nothing shaped like this pattern to
 *      say anything about, not even tentatively.
 */
export function inferStructuralSkills(
  graph: ProofGraph,
  anchors: AnchorHit[],
  userTouchedFiles: Set<string>,
  opts: { taxonomyPath?: string } = {}
): StructuralFinding[] {
  // Closed-vocabulary defense in depth: enforced HERE, inside the function
  // real code calls (mirrors skill-detect.ts's compile()) — not just as a
  // standalone check a future refactor could unwire without failing any
  // test. EVERY slug in STRUCTURAL_PATTERNS is checked — if any pattern's
  // slug is ever missing from taxonomy.json, this module can never produce
  // a finding naming it.
  const taxonomySlugs = loadTaxonomySlugs(opts.taxonomyPath);
  for (const pattern of STRUCTURAL_PATTERNS) {
    if (!taxonomySlugs.has(pattern.slug)) {
      throw new ScanError(`Structural skill slug "${pattern.slug}" is not in taxonomy.json.`);
    }
  }

  // Shared (non-provider-filtered) anchor-kind cache — see
  // anchorsForPatternKind's own comment.
  const sharedKindCache = new Map<AnchorKind, AnchorHit[]>();

  // Lazily built (only if some pattern actually reaches the cross-file
  // search) and memoized across the whole loop — file adjacency doesn't
  // depend on which pattern is being classified, so one build serves every
  // pattern in this call, same reuse rationale as SearchBudgetState below.
  let adjacency: Map<string, Set<string>> | null = null;
  const getAdjacency = (): Map<string, Set<string>> => (adjacency ??= buildFileAdjacency(graph));

  // ONE budget for the whole run — see SearchBudgetState's own comment.
  const budget = createSearchBudgetState();

  const findings: StructuralFinding[] = [];

  for (const pattern of STRUCTURAL_PATTERNS) {
    const [kindA, kindB, kindC] = pattern.anchorKinds;
    const anchorsA = anchorsForPatternKind(anchors, kindA, pattern, sharedKindCache);
    const anchorsB = anchorsForPatternKind(anchors, kindB, pattern, sharedKindCache);
    const anchorsC = anchorsForPatternKind(anchors, kindC, pattern, sharedKindCache);
    // This pattern's OWN anchors only — used for every AMBIGUOUS finding
    // below (see this function's own doc comment, step 3).
    const ownAnchors = [...anchorsA, ...anchorsB, ...anchorsC];

    const missingOptional = (pattern.optionalAnchorKinds ?? []).find(
      (opt) => anchorsForPatternKind(anchors, opt.kind, pattern, sharedKindCache).length === 0
    );

    if (missingOptional) {
      // Step 1b — see this function's own doc comment and
      // StructuralPattern.optionalAnchorKinds' own comment.
      const allKindHits: [AnchorKind, AnchorHit[]][] = [
        [kindA, anchorsA],
        [kindB, anchorsB],
        [kindC, anchorsC],
      ];
      const requiredKindHits = allKindHits.filter(([kind]) => kind !== missingOptional.kind);

      if (requiredKindHits.length === 2 && requiredKindHits[0][1].length > 0 && requiredKindHits[1][1].length > 0) {
        const [first, second] = [requiredKindHits[0][1], requiredKindHits[1][1]];
        const cap = missingOptional.maxConfidenceWithoutOptional;

        const sameFunction = findSameFunctionPair(first, second);
        if (sameFunction) {
          findings.push(buildFinding(pattern.slug, cap, sameFunction, { kind: "same-function", edgeDistance: 0 }, userTouchedFiles));
          continue;
        }

        const sameFile = findSameFilePair(first, second);
        if (sameFile) {
          findings.push(buildFinding(pattern.slug, cap, sameFile, { kind: "same-file", edgeDistance: 0 }, userTouchedFiles));
          continue;
        }

        const inferredPair = findInferredPair(getAdjacency(), first, second, budget);
        if (inferredPair.result) {
          findings.push(
            buildFinding(
              pattern.slug,
              cap,
              inferredPair.result.pair,
              { kind: "cross-file", edgeDistance: inferredPair.result.edgeDistance },
              userTouchedFiles
            )
          );
          continue;
        }
        if (inferredPair.bounded) {
          findings.push(buildFinding(pattern.slug, "ambiguous", ownAnchors, null, userTouchedFiles, true));
          continue;
        }
      }
      // Neither required kind present, or present-but-not-connected: falls
      // through to the shared AMBIGUOUS gate below, same as step 1's own
      // fall-through.
    } else if (anchorsA.length > 0 && anchorsB.length > 0 && anchorsC.length > 0) {
      // Step 1/2 — the original (phase-1) triple logic, unchanged in spirit,
      // now generalized over pattern.anchorKinds via anchorsA/B/C instead of
      // hardcoded webhook/dbWrite/idempotency variables. findSameFunctionTriple/
      // findSameFileTriple/findInferredTriple themselves are BYTE-FOR-BYTE
      // unchanged (see their own comments) — this is the "reuse... generalized
      // over which 3 kinds it looks for" the milestone asked for.
      const sameFunction = findSameFunctionTriple(anchorsA, anchorsB, anchorsC);
      if (sameFunction) {
        findings.push(buildFinding(pattern.slug, "direct", sameFunction, { kind: "same-function", edgeDistance: 0 }, userTouchedFiles));
        continue;
      }

      const sameFile = findSameFileTriple(anchorsA, anchorsB, anchorsC);
      if (sameFile) {
        findings.push(buildFinding(pattern.slug, "direct", sameFile, { kind: "same-file", edgeDistance: 0 }, userTouchedFiles));
        continue;
      }

      const inferred = findInferredTriple(getAdjacency(), anchorsA, anchorsB, anchorsC, budget);
      if (inferred.result) {
        findings.push(
          buildFinding(
            pattern.slug,
            "inferred",
            inferred.result.triple,
            { kind: "cross-file", edgeDistance: inferred.result.edgeDistance },
            userTouchedFiles
          )
        );
        continue;
      }
      if (inferred.bounded) {
        // The cross-file search never finished — degrade to AMBIGUOUS with
        // `searchBounded` set (see findInferredTriple's own comment). All
        // three anchor kinds are already known to be present for this
        // pattern at this point (the outer `else if` above), so this always
        // fires; falling through to the plain
        // hasExternalImportForPackages/anchorsA check below would reach the
        // same AMBIGUOUS outcome anyway, but WITHOUT the searchBounded flag
        // a caller needs to tell "not connected" apart from "search cut
        // short".
        findings.push(buildFinding(pattern.slug, "ambiguous", ownAnchors, null, userTouchedFiles, true));
        continue;
      }
    }

    if (hasExternalImportForPackages(graph, pattern.packages) || anchorsA.length > 0) {
      // Whatever partial anchors currently exist for THIS pattern (possibly
      // none at all, e.g. this pattern's provider package imported but
      // structurally unused — see the spike doc's H3 false-negative case)
      // support this ambiguous finding. `ownAnchors` (this pattern's 3
      // anchorKinds, already filtered) — never the whole cross-pattern pool.
      findings.push(buildFinding(pattern.slug, "ambiguous", ownAnchors, null, userTouchedFiles));
    }
  }

  // Deterministic output ordering across patterns, sorted by slug.
  return findings.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
}

// -----------------------------------------------------------------------
// collectUserTouchedFiles
// -----------------------------------------------------------------------

// Same batching rationale as skill-detect.ts's own DIFF_BATCH_SIZE: diff
// content for this many commits is fetched (and held) at once, via a single
// batched `git show` process (git.ts's getCommitsAddedLines), instead of one
// process per commit — subprocess spawn count is the dominant cost at
// huge-repo scale, not git's own diff work. Kept as this module's own local
// constant rather than importing skill-detect.ts's (which isn't exported)
// — same value, same rationale, but no cross-module coupling for what is,
// deliberately, a duplicated tuning constant rather than a shared contract.
const DIFF_BATCH_SIZE = 200;

/**
 * File-level (never function-level — see docs/proof-graph-spike.md's
 * Exclusions, "No per-function blame") set of paths the given commits added
 * lines to, reusing getCommitsAddedLines (git.ts) in the exact same batched
 * style as skill-detect.ts's detectSkills. Merge commits are skipped (no
 * numstat/diff to attribute per-file changes to, same as detectSkills' own
 * `c.isMerge` filter) and isExcludedPath (churn-exclusions.ts) drops
 * vendored/lockfile/build-output paths — a vendored file's presence would be
 * a false "the user touched this" signal, not a real one, exactly the same
 * rationale detectSkills applies to skill matching. NO git blame anywhere:
 * this is "did an added-lines diff touch this file", not "who wrote which
 * line" — the same diff-based primitive scan already uses, just reduced to
 * a path set instead of pattern-matched against signatures.
 */
export async function collectUserTouchedFiles(
  repoPath: string,
  userCommits: RawCommit[],
  // Optional progress callback, invoked once per commit-diff batch with
  // (commits processed so far, total commits to process) — counts only,
  // never a sha/path (see src/proof-graph/progress.ts's content rule).
  // Purely additive: existing callers that don't pass this keep working
  // unchanged.
  onProgress?: (done: number, total: number) => void
): Promise<Set<string>> {
  const touched = new Set<string>();
  const nonMergeCommits = userCommits.filter((c) => !c.isMerge);

  for (let i = 0; i < nonMergeCommits.length; i += DIFF_BATCH_SIZE) {
    const batch = nonMergeCommits.slice(i, i + DIFF_BATCH_SIZE);
    const addedLinesBySha = await getCommitsAddedLines(
      repoPath,
      batch.map((c) => c.sha)
    );
    for (const commit of batch) {
      const files = addedLinesBySha.get(commit.sha) ?? [];
      for (const file of files) {
        if (isExcludedPath(file.path)) continue;
        // A touched-but-not-added-to file (e.g. a pure deletion diff hunk)
        // surfaces here with an empty addedLines string — not a file the
        // user "added lines to", so it's excluded from the returned set.
        if (file.addedLines.length === 0) continue;
        touched.add(file.path);
      }
    }
    onProgress?.(Math.min(i + DIFF_BATCH_SIZE, nonMergeCommits.length), nonMergeCommits.length);
  }

  return touched;
}

// -----------------------------------------------------------------------
// collectUserTouchedFileDetails / summarizeTouchedCommits — H7
// (docs/proof-graph-spike.md's "Draft bundle signal"): ADDITIVE helpers
// only, in support of scan.ts wiring a CLAIMED structural finding's
// commit_count/first_seen/last_seen into the bundle. collectUserTouchedFiles
// above is left byte-for-byte unchanged and keeps serving every existing
// caller (explain-command.ts, test/proof-graph/detection.test.ts) exactly as
// before — this is a separate, richer sibling, not a modification.
// -----------------------------------------------------------------------

/** One user commit that added lines to a given path — just enough to derive
 * commit_count/first_seen/last_seen later, never more (no message, no other
 * per-commit field). */
export interface FileTouchEntry {
  sha: string;
  authorDate: Date;
}

/**
 * Richer sibling of collectUserTouchedFiles: the EXACT same walk (batched
 * getCommitsAddedLines, same isMerge/isExcludedPath/empty-addedLines
 * filtering — any change to one of these two functions' filtering rules
 * must be mirrored in the other, since they're expected to agree on "which
 * paths did the user touch"), but instead of collapsing straight to a flat
 * Set<string>, keeps each touched path's own list of touching commits (sha +
 * author date).
 *
 * Why a new function rather than extending collectUserTouchedFiles's return
 * type: collectUserTouchedFiles is used today by explain-command.ts (H4) and
 * a range of existing tests, all of which only ever want the plain Set —
 * changing its signature or return shape would touch code and tests this
 * milestone (H7) doesn't own. Keeping it untouched and adding this sibling
 * is the least invasive option that still lets scan.ts get everything it
 * needs (the plain touched-files Set for attribution, via
 * `new Set(details.keys())`, AND, per claimed finding, that finding's own
 * commit_count/first_seen/last_seen via summarizeTouchedCommits below) from
 * a SINGLE diff walk over userCommits, instead of one walk per concern.
 */
export async function collectUserTouchedFileDetails(
  repoPath: string,
  userCommits: RawCommit[],
  // Same content/rationale as collectUserTouchedFiles' own onProgress —
  // counts only, never a sha/path.
  onProgress?: (done: number, total: number) => void
): Promise<Map<string, FileTouchEntry[]>> {
  const touched = new Map<string, FileTouchEntry[]>();
  const nonMergeCommits = userCommits.filter((c) => !c.isMerge);

  for (let i = 0; i < nonMergeCommits.length; i += DIFF_BATCH_SIZE) {
    const batch = nonMergeCommits.slice(i, i + DIFF_BATCH_SIZE);
    const addedLinesBySha = await getCommitsAddedLines(
      repoPath,
      batch.map((c) => c.sha)
    );
    for (const commit of batch) {
      const files = addedLinesBySha.get(commit.sha) ?? [];
      for (const file of files) {
        if (isExcludedPath(file.path)) continue;
        if (file.addedLines.length === 0) continue;
        let entries = touched.get(file.path);
        if (!entries) {
          entries = [];
          touched.set(file.path, entries);
        }
        entries.push({ sha: commit.sha, authorDate: commit.authorDate });
      }
    }
    onProgress?.(Math.min(i + DIFF_BATCH_SIZE, nonMergeCommits.length), nonMergeCommits.length);
  }

  return touched;
}

/**
 * Reduces collectUserTouchedFileDetails' per-path output to the
 * {count, first, last} shape one structural finding's own
 * commit_count/first_seen/last_seen bundle entry needs (see H7's task in
 * GOALS-proof-graph-spike.md and docs/proof-graph-spike.md's "Draft bundle
 * signal"), over the caller-supplied set of anchor-bearing paths that
 * SUPPORT that one finding — never the whole repo's touched-file map.
 *
 * Deduplicates by commit sha (a single commit can add lines to more than one
 * of a finding's anchor-bearing files; it must only be counted once toward
 * commit_count, exactly the same dedup skill-detect.ts's detectSkills
 * applies per slug via its own `matchedCommits` Set-per-slug). Dates sorted
 * ascending before taking first/last — deterministic across runs, mirroring
 * detectSkills' own `sorted[0]`/`sorted[sorted.length - 1]` convention, so a
 * structural entry's dates are computed exactly the same way an import-tier
 * entry's are.
 *
 * Returns null if none of `paths` has any touching commit at all — the
 * caller (scan.ts) only ever calls this for a CLAIMED finding, where
 * `attributed: true` already guarantees at least one supporting anchor path
 * is in the same touched-file population this reduces, so null is not
 * expected to be reachable there; it exists as an honest signature rather
 * than an unchecked non-null assertion.
 */
export function summarizeTouchedCommits(
  details: Map<string, FileTouchEntry[]>,
  paths: Iterable<string>
): { count: number; first: Date; last: Date } | null {
  const dateBySha = new Map<string, Date>();
  for (const path of paths) {
    for (const entry of details.get(path) ?? []) {
      dateBySha.set(entry.sha, entry.authorDate);
    }
  }
  if (dateBySha.size === 0) return null;
  const dates = [...dateBySha.values()].sort((a, b) => a.getTime() - b.getTime());
  return { count: dateBySha.size, first: dates[0], last: dates[dates.length - 1] };
}
