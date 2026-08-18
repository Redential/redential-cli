// H4 of the proof-graph spike (see docs/proof-graph-spike.md): the local-only
// `redential explain <skill>` command. It surfaces the structural tier's
// classification and evidence for one HEAD snapshot, for local inspection —
// nothing more.
//
// ZERO NETWORK: this file (and everything it imports — the whole
// proof-graph/* pipeline plus git.js's local read helpers) never touches
// http/https/fetch. `login` and `submit` are the CLI's only network-capable
// commands (see test/privacy/zero-network.test.ts) and this file is not one
// of them.
//
// SCREEN vs BUNDLE BOUNDARY (read this before changing what gets printed):
// everything this command prints — file paths, enclosing function names,
// line numbers, `reason` strings — is LOCAL, on-screen-only diagnostic
// output. Printing it to the user's own terminal is correct and intentional
// (it never leaves the machine that way). It is NOT, and must never become,
// part of `scan`'s bundle output or anything `submit` uploads — see
// docs/proof-graph-spike.md's "Invariants" (the structural signal stays out
// of the bundle for the whole spike) and StructuralFinding's own comment in
// src/proof-graph/infer.ts (no toJSON, never JSON.stringify'd into a bundle).
// This command is a read-only diagnostic window into the in-memory graph,
// not a new data path out of the machine.
//
// NO --json / NO machine-readable output / NO file writes, ON PURPOSE: a
// `--json` flag (or any other structured/serializable output mode) would be
// a standing invitation for some other tool in a pipeline to capture and
// persist a serialization of the graph — exactly what
// docs/proof-graph-spike.md's "In-memory only" invariant forbids. Keeping
// the only output surface "plain text a human reads once in a terminal"
// keeps that invariant true by construction rather than by convention. The
// only local file this command reads is taxonomy.json (for a slug's label),
// via skill-detect.ts's loadTaxonomyEntries — no write/mkdir/append call
// appears anywhere in this file.
import { readHeadSnapshot } from "./proof-graph/snapshot.js";
import { TscParserAdapter, type ParsedFile } from "./proof-graph/parser-adapter.js";
import { buildGraph } from "./proof-graph/graph.js";
import { findAnchors, type AnchorHit, type AnchorKind } from "./proof-graph/anchors.js";
import {
  collectUserTouchedFiles,
  inferStructuralSkills,
  STRUCTURAL_PATTERNS,
  type StructuralFinding,
  type StructuralPattern,
} from "./proof-graph/infer.js";
import { createProgressReporter } from "./proof-graph/progress.js";
import { getAllCommits, getConfiguredUserEmail, type RawCommit } from "./git.js";
import { loadTaxonomySlugs, loadTaxonomyEntries } from "./skill-detect.js";
import { parseSince, describeSince } from "./since.js";
import { ScanError } from "./errors.js";

export interface ExplainCommandOptions {
  repoPath: string;
  skill: string;
  // Repeatable --author <email>; [] means "use the repo's own git config
  // user.email as the default" — see the non-interactive rationale below.
  author: string[];
  // Raw --since spec ("2years", "18months", "2024-01-01" — see
  // src/since.ts), same plumbing scan's own --since uses. Undefined walks
  // full history. ATTRIBUTION SEMANTICS: --since can only NARROW the
  // author's touched-file set — it turns attributed=true into false by
  // excluding commits, never the reverse. It's an explicit user-requested
  // narrowing of the evidence window, not a new inference: more history
  // never removes attribution, and this option never adds any. See the
  // attribution log line below, which names the window whenever it's
  // active so the narrowing stays visible in the printed evidence.
  since?: string;
  log?: (message: string) => void;
  // True when stdout is an interactive terminal — cli.ts passes
  // `process.stdout.isTTY`. Gates whether live progress is shown at all
  // (src/proof-graph/progress.ts's own TTY-gate rationale: a piped stdout
  // stays completely silent on stderr too). Tests set this explicitly
  // instead of relying on a real TTY; undefined defers to
  // createProgressReporter's own `process.stdout.isTTY` default.
  isTTY?: boolean;
  // Where progress bytes are written — ALWAYS stderr, NEVER the `log`
  // callback above (which backs stdout, and must stay byte-identical
  // whether or not progress is shown). Defaults to `process.stderr.write`;
  // tests inject a collector. Only used when progress ends up enabled.
  progressWrite?: (message: string) => void;
}

// loadTaxonomyEntries (skill-detect.ts) is the single SEA-aware taxonomy.json
// reader shared across the codebase (see src/embedded-assets.ts) — reused
// here instead of a second hand-rolled readFileSync, so this file never needs
// its own SEA/filesystem branch.
function taxonomyLabel(slug: string): string {
  return loadTaxonomyEntries().find((s) => s.slug === slug)?.label ?? slug;
}

const CLASSIFICATION_MEANING: Record<StructuralFinding["confidence"], string> = {
  direct: "all three anchors sit in the same function or the same file — the strongest, most direct signal.",
  inferred:
    "the three anchors are wired together across files, connected by resolved relative imports within 3 hops — a real but less direct signal.",
  ambiguous:
    "the pattern is NOT fully connected (or only partially present) — this is a tentative signal only, and the skill is NOT claimed.",
};

// H6 phase 2c: grouping order used to be a single hardcoded module-level
// constant (webhook-verification -> db-write -> idempotency-guard), because
// the spike only ever explained one pattern. Now that STRUCTURAL_PATTERNS
// (infer.ts) has 6 entries with 2 different anchor-kind shapes (the 5
// webhook-flow patterns' ["webhook-verification","db-write",
// "idempotency-guard"] vs. iap-flow's own ["iap-configure","iap-purchase",
// "iap-entitlement-gate"]), the grouping order is DATA-DRIVEN from the
// matched StructuralPattern's own `anchorKinds` field directly (see that
// field's own doc comment in infer.ts: it's already the fixed, meaningful,
// "the order the flow actually happens in" order every recognizer/search
// function is built around) rather than a second, parallel constant that
// could drift out of sync with it. No standalone ANCHOR_KIND_ORDER constant
// remains — every call site below takes the resolved `pattern` and reads
// `pattern.anchorKinds` directly.

function describeAnchor(hit: AnchorHit): string {
  return `    ${hit.path}:${hit.line} in ${hit.enclosingFunction ?? "<module top level>"} — ${hit.reason}`;
}

/**
 * Undirected file-adjacency built from the graph's own RESOLVED relative
 * import edges — the exact same signal src/proof-graph/infer.ts's (private)
 * buildFileAdjacency uses for its edgeDistance computation, duplicated here
 * (not imported — infer.ts deliberately keeps it module-private) so this
 * command can render the actual chain of files an INFERRED finding is
 * connected through, using only the graph's public query surface
 * (files()/importEdgesOf()).
 */
function buildFileAdjacency(graph: ReturnType<typeof buildGraph>): Map<string, Set<string>> {
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

/** Shortest path (as a list of file paths, `from` first) between two files
 * in the given adjacency, or null if unreachable. Plain BFS with parent
 * tracking — reconstructs the actual chain, not just its length. */
function shortestFilePath(adjacency: Map<string, Set<string>>, from: string, to: string): string[] | null {
  if (from === to) return [from];
  const parents = new Map<string, string>();
  const visited = new Set<string>([from]);
  const queue: string[] = [from];
  let head = 0;
  while (head < queue.length) {
    const current = queue[head++];
    if (current === to) break;
    for (const neighbor of adjacency.get(current) ?? []) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        parents.set(neighbor, current);
        queue.push(neighbor);
      }
    }
  }
  if (!visited.has(to)) return null;
  const path: string[] = [to];
  let cur = to;
  while (cur !== from) {
    cur = parents.get(cur)!;
    path.push(cur);
  }
  return path.reverse();
}

/**
 * Renders how the finding's supporting anchor files connect, as a simple
 * "a.ts -> b.ts -> c.ts" chain for a cross-file (INFERRED) finding, or a
 * single-file description for same-function/same-file (DIRECT). null
 * `connection` (AMBIGUOUS) is handled by the caller, not here.
 */
function renderConnection(graph: ReturnType<typeof buildGraph>, finding: StructuralFinding, pattern: StructuralPattern): string {
  const connection = finding.connection;
  if (!connection) return "none (pattern not fully connected — see the AMBIGUOUS explanation below)";

  const distinctFiles = [...new Set(finding.anchors.map((a) => a.path))];
  if (connection.kind === "same-function") {
    return `${distinctFiles[0]} (same-function — all anchors inside one function, 0 file hops)`;
  }
  if (connection.kind === "same-file") {
    return `${distinctFiles[0]} (same-file — all anchors in one file, different functions, 0 file hops)`;
  }

  // cross-file (INFERRED): reconstruct the actual chain from the graph's
  // resolved import edges, rooted at the PATTERN'S OWN primary anchor's file
  // when present (anchorKinds[0] — webhook-verification for every
  // webhook-flow pattern, iap-configure for iap-flow; see
  // StructuralPattern.anchorKinds' own "PRIMARY anchor by convention"
  // comment in infer.ts) and reaching the farthest other anchor file —
  // matching the finding's own edgeDistance (the MAX pairwise distance
  // among the supporting anchors, see infer.ts's findInferredTriple).
  const adjacency = buildFileAdjacency(graph);
  const primaryAnchor = finding.anchors.find((a) => a.kind === pattern.anchorKinds[0]);
  const source = primaryAnchor?.path ?? distinctFiles[0];
  const others = distinctFiles.filter((f) => f !== source);

  let farthest: { file: string; path: string[] } | null = null;
  for (const other of others) {
    const path = shortestFilePath(adjacency, source, other);
    if (path && (!farthest || path.length > farthest.path.length)) farthest = { file: other, path };
  }
  const chain = farthest ? farthest.path : distinctFiles;
  return `${chain.join(" -> ")} (cross-file, ${connection.edgeDistance} file hop${connection.edgeDistance === 1 ? "" : "s"})`;
}

// H6 phase 2c: generalized over `pattern` — used to hardcode "stripe" and
// the webhook/db-write/idempotency shape by name (the spike's original
// single-pattern posture); now reads the matched StructuralPattern's own
// `packages`/`anchorKinds` fields so the same function covers every entry
// in STRUCTURAL_PATTERNS without a per-provider branch.
function describeAmbiguousReason(finding: StructuralFinding, pattern: StructuralPattern): string {
  if (finding.anchors.length === 0) {
    return `an import from one of this pattern's own packages (${pattern.packages.join(", ")}) is present somewhere in this repository, but no anchors (${pattern.anchorKinds.join(", ")}) were found at all — nothing structurally connects it to this pattern's shape.`;
  }
  const kindsPresent = new Set(finding.anchors.map((a) => a.kind));
  const missing = pattern.anchorKinds.filter((kind) => !kindsPresent.has(kind));
  if (missing.length > 0) {
    return `missing anchor kind(s): ${missing.join(", ")} — the full ${pattern.anchorKinds.join(" -> ")} shape isn't present.`;
  }
  return "all anchor kinds are present, but not connected closely enough — no same-function/same-file match, and no cross-file import path within 3 hops.";
}

/**
 * H6 phase 2c — Mercado Pago's optional-anchor cap (see
 * StructuralPattern.optionalAnchorKinds' own comment in infer.ts) isn't
 * exposed as its own StructuralFinding field: infer.ts deliberately keeps
 * `connection` reporting the ACTUAL topology found and only caps
 * `confidence`, so the cap has to be DERIVED here from those two public
 * fields rather than read off a dedicated flag.
 *
 * The derivation is exact, not a heuristic: inferStructuralSkills' step 1b
 * (see that function's own doc comment in infer.ts) is the ONLY code path
 * in the whole module that can ever produce a finding with confidence
 * "inferred" together with a same-function/same-file `connection.kind` —
 * every OTHER "inferred" finding comes from the cross-file search
 * (findInferredTriple/findInferredPair), which can only ever report
 * `connection.kind === "cross-file"` (see StructuralFinding.connection's
 * own doc comment: edgeDistance is always 0 for both DIRECT topologies and
 * 1-3 for cross-file — a same-function/same-file topology is DIRECT-shaped
 * connectivity by definition). So "inferred confidence + same-function/
 * same-file topology" is unambiguous evidence the pair-search cap fired for
 * a pattern that HAS an optionalAnchorKinds entry — not a coincidence of
 * two independently-chosen fields.
 *
 * Known, accepted limit of this derivation: it cannot tell a capped finding
 * whose pair search happened to land on a CROSS-FILE connection apart from
 * a genuine (uncapped) cross-file INFERRED finding — both report
 * `confidence: "inferred"` and `connection.kind: "cross-file"`, and nothing
 * in the public StructuralFinding shape distinguishes them. This is not a
 * gap in practice: the confidence label ("inferred") is honest either way,
 * only the WHY note below would be missing for that one sub-case, and
 * Mercado Pago's fixtures (test/proof-graph/fixtures.ts) exercise the
 * same-function cap case, which this derivation always catches correctly.
 */
function cappedOptionalAnchorKind(pattern: StructuralPattern, finding: StructuralFinding): AnchorKind | null {
  if (!pattern.optionalAnchorKinds || pattern.optionalAnchorKinds.length === 0) return null;
  if (finding.confidence !== "inferred") return null;
  if (!finding.connection) return null;
  if (finding.connection.kind !== "same-function" && finding.connection.kind !== "same-file") return null;
  // Today there is only ever one optional-kind entry per pattern (Mercado
  // Pago's idempotency-guard) — see optionalAnchorKinds' own comment in
  // infer.ts on why this stays a table (and this reads its first entry),
  // not an if/else, for a future pattern with its own optional kind.
  return pattern.optionalAnchorKinds[0].kind;
}

/**
 * Resolves which author email(s) `explain` filters commits by — deliberately
 * NON-interactive, unlike `scan`'s prompted author selection: `scan`'s
 * interactive picker exists because a bundle is about to be built and
 * uploaded, so getting the "this is really me" confirmation right matters.
 * `explain` never builds or sends anything — it's a read-only local
 * diagnostic a user (or a test, or a script) should be able to run
 * unattended. Default: the repo's own `git config user.email` if set (the
 * same fast-default signal build-bundle.ts offers interactively); explicit
 * `--author` (repeatable) always overrides it.
 */
function resolveAuthorEmails(repoPath: string, explicitAuthors: string[]): string[] {
  if (explicitAuthors.length > 0) return [...new Set(explicitAuthors)];
  const gitEmail = getConfiguredUserEmail(repoPath);
  return gitEmail ? [gitEmail] : [];
}

export async function executeExplainCommand(opts: ExplainCommandOptions): Promise<void> {
  const log = opts.log ?? console.log;

  // Closed-vocabulary validation FIRST, before any git/parsing work — an
  // unknown slug is a usage error, not a detection result.
  const taxonomySlugs = loadTaxonomySlugs();
  if (!taxonomySlugs.has(opts.skill)) {
    throw new ScanError(
      `Unknown skill slug "${opts.skill}" — taxonomy.json is the CLI's only source of valid skill slugs, and this one isn't in it. See taxonomy.json for the full closed list.`
    );
  }
  // H6 phase 2c: the single-slug gate ("only STRUCTURAL_SKILL_SLUG is
  // explainable" — the phase-1 reviewer note this replaces) is now "slug
  // must be one of STRUCTURAL_PATTERNS' own slugs" — the pattern table
  // (infer.ts) is the source of truth for which slugs are explainable, not
  // a hardcoded name. `pattern` is threaded through the rest of this
  // function (anchor grouping order, connection rendering, the AMBIGUOUS
  // WHY text, and the Mercado Pago cap note all read it).
  const pattern = STRUCTURAL_PATTERNS.find((p) => p.slug === opts.skill);
  if (!pattern) {
    const explainableSlugs = [...STRUCTURAL_PATTERNS].map((p) => p.slug).sort();
    throw new ScanError(
      `"${opts.skill}" is a valid taxonomy.json slug, but only these ${explainableSlugs.length} structural patterns are explainable in this spike (known limit — see docs/proof-graph-spike.md's "Multi-provider expansion (H6)" section): ${explainableSlugs.join(", ")}. Plain import-matching slugs like this one aren't covered by \`redential explain\` yet.`
    );
  }

  const authorEmails = resolveAuthorEmails(opts.repoPath, opts.author);
  const authorEmailSet = new Set(authorEmails);
  const authorLabel =
    authorEmails.length > 0 ? authorEmails.join(", ") : "(none — no --author given and no git config user.email set)";

  // Same src/since.ts spec/parsing scan's own --since uses (see
  // ExplainCommandOptions.since's own attribution-semantics doc comment).
  const sinceDate = opts.since !== undefined ? parseSince(opts.since, new Date()) : undefined;
  const sinceLabel = opts.since !== undefined ? describeSince(opts.since) : undefined;

  // Live stderr progress only (never stdout — see this file's own
  // SCREEN vs BUNDLE boundary comment and progress.ts's header): a real run
  // on a big repo can take tens of seconds with otherwise zero output,
  // which reads as hung. Purely presentational; carries no detection logic
  // and touches nothing this function wouldn't already compute.
  const reporter = createProgressReporter({ enabled: opts.isTTY, write: opts.progressWrite });

  // Same pipeline sequence as test/proof-graph/detection.test.ts's
  // runPipeline: HEAD snapshot -> parse -> graph -> anchors -> the selected
  // author's own commits -> touched-files set -> classify. No error here is
  // caught by this module — an outside-a-git-repo failure (or any other git
  // read failure) propagates exactly the way scan-command.ts lets
  // buildBundleInteractively's failures propagate, so cli.ts's single
  // ScanError/uncaught-error handling stays the one place that decides how
  // it's reported. The whole pipeline is wrapped in try/finally purely so a
  // mid-phase throw still clears the in-progress stderr line (reporter.done())
  // before propagating — without this, a dangling progress line (e.g.
  // "Reading history 1234/5000 (24%)") stays on the terminal and cli.ts's
  // subsequent `Error: ...` line gets appended right after it instead of
  // starting on a clean line. reporter.done() is safe to call twice (once
  // here, once more below on the success path) — it's a no-op the second
  // time (see progress.ts's own "done() is a silent no-op when no phase()
  // was ever called" case, exercised by test/proof-graph/progress.test.ts:
  // the first done() already resets the reporter to that exact no-phase
  // state, so a second call hits the identical no-op branch).
  let graph: ReturnType<typeof buildGraph>;
  let findings: StructuralFinding[];
  let userCommits: RawCommit[];
  let userTouchedFiles: Set<string>;
  try {
    reporter.phase("Scanning HEAD");
    const snapshot = await readHeadSnapshot(opts.repoPath, {
      onProgress: (done, total) => reporter.tick(done, total),
    });

    reporter.phase("Parsing files");
    const adapter = new TscParserAdapter();
    const parsed: ParsedFile[] = [];
    for (let i = 0; i < snapshot.length; i++) {
      parsed.push(adapter.parse(snapshot[i].path, snapshot[i].content));
      reporter.tick(i + 1, snapshot.length);
    }

    reporter.phase("Building graph");
    graph = buildGraph(parsed);

    reporter.phase("Finding anchors");
    const anchors = findAnchors(graph);

    reporter.phase("Reading history");
    // authorEmails here is a git-level OPTIMIZATION only (see git.ts's
    // GetAllCommitsOptions.authorEmails doc comment) — the exact-equality JS
    // filter right below stays the actual correctness boundary, unchanged.
    const allCommits = await getAllCommits(opts.repoPath, {
      since: sinceDate,
      authorEmails: authorEmails.length > 0 ? authorEmails : undefined,
    });
    userCommits = allCommits.filter((c) => authorEmailSet.has(c.email));
    userTouchedFiles = await collectUserTouchedFiles(opts.repoPath, userCommits, (done, total) =>
      reporter.tick(done, total)
    );

    reporter.phase("Analyzing structure");
    findings = inferStructuralSkills(graph, anchors, userTouchedFiles);
  } finally {
    reporter.done();
  }
  reporter.done();

  // STRUCTURAL_PATTERNS now has 6 entries, so inferStructuralSkills returns
  // up to 6 findings (sorted by slug, see that function's own doc comment)
  // — this command only ever explains the ONE the caller asked for.
  const finding = findings.find((f) => f.slug === opts.skill);
  if (!finding) {
    throw new ScanError(
      `"${opts.skill}" was not detected in this repository — no structural signal found at all for this pattern (no anchors, no import from any of its own packages (${pattern.packages.join(", ")}) anywhere in the current HEAD snapshot).`
    );
  }

  log(`Skill: ${finding.slug} — ${taxonomyLabel(finding.slug)}`);
  log(`Classification: ${finding.confidence.toUpperCase()} — ${CLASSIFICATION_MEANING[finding.confidence]}`);
  log("");

  log("Anchors:");
  if (finding.anchors.length === 0) {
    // Only reachable for an AMBIGUOUS finding whose only signal is an
    // unused provider-package import (see infer.ts's inferStructuralSkills:
    // hasExternalImportForPackages with zero anchors) — the false-negative
    // case docs/proof-graph-spike.md's H3 entry documents.
    log(`  (none — no ${pattern.anchorKinds.join("/")} anchors found)`);
  }
  for (const kind of pattern.anchorKinds) {
    const hits = finding.anchors.filter((a) => a.kind === kind);
    if (hits.length === 0) continue;
    log(`  ${kind}:`);
    for (const hit of hits) log(describeAnchor(hit));
  }
  log("");

  log(`Connection: ${renderConnection(graph, finding, pattern)}`);
  const cappedKind = cappedOptionalAnchorKind(pattern, finding);
  if (cappedKind) {
    log(
      `  Note: confidence is capped at INFERRED, not DIRECT — the "${cappedKind}" anchor is missing everywhere in this repository. This pattern still classifies without it (see StructuralPattern.optionalAnchorKinds in src/proof-graph/infer.ts), but the resulting confidence is capped instead of reaching DIRECT. Connection above still reports the ACTUAL same-function/same-file topology found.`
    );
  }
  log("");

  const supportingFiles = [...new Set(finding.anchors.map((a) => a.path))];
  // Names the --since window right alongside the author set whenever it's
  // active, so a narrowed evidence window is visible in the output itself
  // rather than only inferable from how the command was invoked — see
  // ExplainCommandOptions.since's attribution-semantics doc comment.
  log(`Attribution (author: ${authorLabel}${sinceLabel ? `, window: ${sinceLabel}` : ""}):`);
  if (userCommits.length === 0) {
    log(`  no commits found for ${authorLabel}`);
  } else {
    const intersecting = supportingFiles.filter((f) => userTouchedFiles.has(f));
    if (intersecting.length > 0) {
      log(`  YES — your own added-lines diff touched: ${intersecting.join(", ")}`);
    } else if (supportingFiles.length > 0) {
      log(`  NO — none of the supporting anchor file(s) (${supportingFiles.join(", ")}) intersect files you've touched`);
    } else {
      log('  NO — this finding has no supporting anchor files at all (only the file-wide provider-package import signal)');
    }
  }
  log("");

  log(`Claimed: ${finding.claimed ? "yes" : "no"}`);
  if (finding.confidence === "ambiguous") {
    log("");
    log(
      `NOT CLAIMED: this is an AMBIGUOUS finding — it is never claimed, regardless of attribution, and it can never enter a scan/submit bundle (docs/proof-graph-spike.md's "Draft bundle signal" section: AMBIGUOUS never travels in the bundle under any field). Why: ${describeAmbiguousReason(finding, pattern)}`
    );
  }
  // searchBounded (src/proof-graph/infer.ts's findInferredTriple): the
  // cross-file search hit its deterministic work budget before finishing,
  // rather than genuinely failing to find a connected pattern — a distinct
  // reason for AMBIGUOUS the user should see plainly, in the same friendly,
  // no-jargon register as the rest of this command's output.
  if (finding.searchBounded) {
    log("");
    log(
      "Note: the search space for this repository exceeded the deterministic work budget, so the classification degraded to AMBIGUOUS (the pattern may exist but was not fully searched)."
    );
  }
}
