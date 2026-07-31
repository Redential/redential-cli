// H3 of the proof-graph spike (see docs/proof-graph-spike.md): the real
// end-to-end pipeline (HEAD snapshot -> parse -> graph -> anchors -> author
// attribution -> classification) exercised against small, programmatically
// built git repos (test/proof-graph/fixtures.ts) — never hand-built
// ParsedFile/ProofGraph/AnchorHit values (that integration level is already
// covered by anchors.test.ts and infer.test.ts). Same zero-network,
// deterministic posture as every other module in this spike: every git read
// here is local (readHeadSnapshot, getAllCommits), nothing is written
// anywhere, and the same input always classifies the same way.
import { afterEach, describe, expect, it } from "vitest";
import { readHeadSnapshot } from "../../src/proof-graph/snapshot.js";
import { TscParserAdapter } from "../../src/proof-graph/parser-adapter.js";
import { buildGraph } from "../../src/proof-graph/graph.js";
import { findAnchors } from "../../src/proof-graph/anchors.js";
import { collectUserTouchedFiles, inferStructuralSkills, STRUCTURAL_SKILL_SLUG } from "../../src/proof-graph/infer.js";
import { getAllCommits } from "../../src/git.js";
import { detectSkills } from "../../src/skill-detect.js";
import { cleanup } from "../support/fixtures.js";
import {
  USER,
  fixtureCommentsOnly,
  fixtureDirectPattern,
  fixtureIapDirect,
  fixtureIapLayered,
  fixtureIapOtherAuthor,
  fixtureIapUnused,
  fixtureLayeredPattern,
  fixtureLemonSqueezyLayered,
  fixtureLemonSqueezyManualHmacDirect,
  fixtureLemonSqueezyOtherAuthor,
  fixtureLemonSqueezyUnused,
  fixtureMercadoPagoDirectNoIdempotency,
  fixtureMercadoPagoDirectWithUpsert,
  fixtureMercadoPagoLayered,
  fixtureMercadoPagoOtherAuthor,
  fixtureMercadoPagoUnused,
  fixtureOtherAuthor,
  fixturePaddleLayered,
  fixturePaddleDirect,
  fixturePaddleOtherAuthor,
  fixturePaddleUnused,
  fixturePaypalDirect,
  fixturePaypalLayered,
  fixturePaypalOtherAuthor,
  fixturePaypalUnused,
  fixtureStripeUnused,
  fixtureAuthSessionDirect,
  fixtureAuthSessionLayered,
  fixtureAuthSessionUnused,
  fixtureAuthSessionOtherAuthor,
  fixtureAuthOauthDirect,
  fixtureAuthOauthLayered,
  fixtureAuthOauthUnused,
  fixtureAuthOauthOtherAuthor,
  fixtureAuthJwtRefreshDirect,
  fixtureAuthJwtRefreshWithInvalidation,
  fixtureAuthJwtRefreshNoRotation,
  fixtureAuthJwtRefreshLayered,
  fixtureAuthJwtRefreshUnused,
  fixtureAuthJwtRefreshOtherAuthor,
  fixtureAuthJwtDecodeOnly,
  fixtureAuthLoginFormOnly,
  fixtureAuthGuardWithoutAuthLibrary,
  fixtureAuthMixedLibraries,
  fixtureAuthScopedFlowWithOverlappingLibrary,
  fixtureAuthAliasedImport,
} from "./fixtures.js";

const adapter = new TscParserAdapter();

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) cleanup(dirs.pop()!);
});

/**
 * Runs the real pipeline the spike's structural tier is built from, minus
 * the bundle step (out of scope for the whole spike — see
 * docs/proof-graph-spike.md's "Approved decisions" #2): HEAD snapshot ->
 * parse each file with the real TscParserAdapter -> build the in-memory
 * graph -> recognize anchors -> obtain the selected author's own commits via
 * the SAME git.ts primitive + author-email filter scan.ts uses for its own
 * `userCommits` (see src/scan.ts: `getAllCommits` then
 * `allCommits.filter((c) => authorSet.has(c.email))`) -> reduce those
 * commits to a touched-files set -> classify.
 */
async function runPipeline(repoPath: string, authorEmail: string) {
  const snapshot = await readHeadSnapshot(repoPath);
  const parsed = snapshot.map((f) => adapter.parse(f.path, f.content));
  const graph = buildGraph(parsed);
  const anchors = findAnchors(graph);

  const allCommits = await getAllCommits(repoPath);
  const userCommits = allCommits.filter((c) => c.email === authorEmail);
  const userTouchedFiles = await collectUserTouchedFiles(repoPath, userCommits);

  const findings = inferStructuralSkills(graph, anchors, userTouchedFiles);
  return { anchors, findings, userCommits };
}

describe("proof-graph H3 end-to-end fixtures (docs/proof-graph-spike.md)", () => {
  it("one file, webhook verification + DB read/write in the same function -> DIRECT (same-function), attributed, claimed", async () => {
    const dir = fixtureDirectPattern();
    dirs.push(dir);

    const { anchors, findings } = await runPipeline(dir, USER.email);

    expect(anchors.length).toBeGreaterThan(0);
    expect(findings).toHaveLength(1);
    const finding = findings[0];
    expect(finding.slug).toBe(STRUCTURAL_SKILL_SLUG);
    expect(finding.confidence).toBe("direct");
    expect(finding.attributed).toBe(true);
    expect(finding.claimed).toBe(true);
    // Asserting the actual connection kind the pipeline yields, not a
    // loosened "truthy" check — all three anchors sit in the same function
    // (handleWebhook), so this must be "same-function", not the weaker
    // "same-file".
    expect(finding.connection).toEqual({ kind: "same-function", edgeDistance: 0 });
  });

  it("three files connected only by relative imports (handler -> service -> repo) -> INFERRED, claimed, edgeDistance <= 3, anchors span >= 2 files", async () => {
    const dir = fixtureLayeredPattern();
    dirs.push(dir);

    const { findings } = await runPipeline(dir, USER.email);

    expect(findings).toHaveLength(1);
    const finding = findings[0];
    expect(finding.confidence).toBe("inferred");
    expect(finding.claimed).toBe(true);
    expect(finding.connection).not.toBeNull();
    expect(finding.connection!.kind).toBe("cross-file");
    expect(finding.connection!.edgeDistance).toBeGreaterThan(0);
    expect(finding.connection!.edgeDistance).toBeLessThanOrEqual(3);
    const distinctAnchorFiles = new Set(finding.anchors.map((a) => a.path));
    expect(distinctAnchorFiles.size).toBeGreaterThanOrEqual(2);
  });

  it("stripe imported but structurally unused -> ambiguous, structural skill NOT claimed (deliberate false negative)", async () => {
    const dir = fixtureStripeUnused();
    dirs.push(dir);

    const { findings, userCommits } = await runPipeline(dir, USER.email);

    expect(findings).toHaveLength(1);
    const finding = findings[0];
    expect(finding.confidence).toBe("ambiguous");
    expect(finding.claimed).toBe(false);

    // The two tiers deliberately coexist (see docs/proof-graph-spike.md's H3
    // entry): Tier 1 (src/skill-detect.ts's plain import matching) still
    // reports "payments/stripe" from the same bare `import Stripe from
    // "stripe"` line, even though the structural tier refuses to claim
    // payment-webhook-flow for the exact same commit/file. Neither result
    // contradicts the other — Tier 1 answers "was stripe imported," the
    // structural tier answers "was it wired into a webhook flow."
    const detected = await detectSkills(userCommits, dir);
    expect(detected.map((s) => s.slug)).toContain("payments/stripe");
  });

  it("pattern committed by a different author -> DIRECT overall, but unattributed and unclaimed for the selected user", async () => {
    const dir = fixtureOtherAuthor();
    dirs.push(dir);

    const { findings } = await runPipeline(dir, USER.email);

    expect(findings).toHaveLength(1);
    const finding = findings[0];
    expect(finding.confidence).toBe("direct");
    expect(finding.attributed).toBe(false);
    expect(finding.claimed).toBe(false);
  });

  it("stripe/prisma/constructEvent appear only in comments and string literals -> no anchors, no finding at all", async () => {
    const dir = fixtureCommentsOnly();
    dirs.push(dir);

    const { anchors, findings } = await runPipeline(dir, USER.email);

    expect(anchors).toEqual([]);
    expect(findings).toEqual([]);
  });
});

// -----------------------------------------------------------------------
// H6 phase 2b: end-to-end fixtures + detection tests for the 5 new patterns
// anchors.ts/infer.ts's H6 phase 2a work added (see GOALS-proof-graph-spike
// .md's H6 task). Same runPipeline helper, same fixture-shape conventions as
// the Stripe describe block above.
// -----------------------------------------------------------------------

describe("proof-graph H6 phase 2b — PayPal (payments/paypal-webhook-flow)", () => {
  const SLUG = "payments/paypal-webhook-flow";

  it("one file, verifyWebhookSignature + Prisma upsert in the same function -> DIRECT (same-function), attributed, claimed", async () => {
    const dir = fixturePaypalDirect();
    dirs.push(dir);

    const { findings } = await runPipeline(dir, USER.email);

    expect(findings).toHaveLength(1);
    const finding = findings[0];
    expect(finding.slug).toBe(SLUG);
    expect(finding.confidence).toBe("direct");
    expect(finding.attributed).toBe(true);
    expect(finding.claimed).toBe(true);
    expect(finding.connection).toEqual({ kind: "same-function", edgeDistance: 0 });
  });

  it("three files connected only by relative imports (handler -> service -> repo) -> INFERRED, claimed, edgeDistance <= 3", async () => {
    const dir = fixturePaypalLayered();
    dirs.push(dir);

    const { findings } = await runPipeline(dir, USER.email);

    expect(findings).toHaveLength(1);
    const finding = findings[0];
    expect(finding.slug).toBe(SLUG);
    expect(finding.confidence).toBe("inferred");
    expect(finding.claimed).toBe(true);
    expect(finding.connection).not.toBeNull();
    expect(finding.connection!.kind).toBe("cross-file");
    expect(finding.connection!.edgeDistance).toBeGreaterThan(0);
    expect(finding.connection!.edgeDistance).toBeLessThanOrEqual(3);
  });

  it("paypal imported but structurally unused -> ambiguous, NOT claimed", async () => {
    const dir = fixturePaypalUnused();
    dirs.push(dir);

    const { findings } = await runPipeline(dir, USER.email);

    const finding = findings.find((f) => f.slug === SLUG);
    expect(finding).toBeDefined();
    expect(finding!.confidence).toBe("ambiguous");
    expect(finding!.claimed).toBe(false);
    // H6 phase 2a ownAnchors fix: an unrelated, fully connected Stripe
    // pattern is present in the SAME repo (see fixturePaypalUnused's own
    // comment) — its webhook-verification anchor must never leak into this
    // PayPal finding's anchors.
    expect(finding!.anchors.every((a) => a.kind !== "webhook-verification")).toBe(true);

    // The Stripe pattern in the same repo is expected to still classify on
    // its own, independent finding.
    const stripeFinding = findings.find((f) => f.slug === "payments/payment-webhook-flow");
    expect(stripeFinding).toBeDefined();
    expect(stripeFinding!.confidence).toBe("direct");
  });

  it("pattern committed by a different author -> DIRECT overall, but unattributed and unclaimed for the selected user", async () => {
    const dir = fixturePaypalOtherAuthor();
    dirs.push(dir);

    const { findings } = await runPipeline(dir, USER.email);

    expect(findings).toHaveLength(1);
    const finding = findings[0];
    expect(finding.slug).toBe(SLUG);
    expect(finding.confidence).toBe("direct");
    expect(finding.attributed).toBe(false);
    expect(finding.claimed).toBe(false);
  });
});

describe("proof-graph H6 phase 2b — Mercado Pago (payments/mercadopago-flow)", () => {
  const SLUG = "payments/mercadopago-flow";

  it("creation call + Prisma write co-located, but NO idempotency-guard anywhere -> optionalAnchorKinds cap: confidence 'inferred' even though same-function", async () => {
    const dir = fixtureMercadoPagoDirectNoIdempotency();
    dirs.push(dir);

    const { anchors, findings } = await runPipeline(dir, USER.email);

    expect(anchors.some((a) => a.kind === "idempotency-guard")).toBe(false);
    expect(findings).toHaveLength(1);
    const finding = findings[0];
    expect(finding.slug).toBe(SLUG);
    // The documented cap (infer.ts's StructuralPattern.optionalAnchorKinds):
    // the pair search found a same-function connection (which for a normal
    // 3-kind pattern would be DIRECT), but confidence is capped at
    // "inferred" because idempotency-guard is globally absent.
    expect(finding.confidence).toBe("inferred");
    expect(finding.connection).toEqual({ kind: "same-function", edgeDistance: 0 });
    expect(finding.attributed).toBe(true);
    expect(finding.claimed).toBe(true);
  });

  it("same shape, but the write is an upsert -> idempotency-guard present again -> cap LIFTS: DIRECT (same-function)", async () => {
    const dir = fixtureMercadoPagoDirectWithUpsert();
    dirs.push(dir);

    const { anchors, findings } = await runPipeline(dir, USER.email);

    expect(anchors.some((a) => a.kind === "idempotency-guard")).toBe(true);
    expect(findings).toHaveLength(1);
    const finding = findings[0];
    expect(finding.slug).toBe(SLUG);
    expect(finding.confidence).toBe("direct");
    expect(finding.connection).toEqual({ kind: "same-function", edgeDistance: 0 });
    expect(finding.attributed).toBe(true);
    expect(finding.claimed).toBe(true);
  });

  it("three files connected only by relative imports (handler -> service -> repo) -> INFERRED, claimed, edgeDistance <= 3", async () => {
    const dir = fixtureMercadoPagoLayered();
    dirs.push(dir);

    const { findings } = await runPipeline(dir, USER.email);

    expect(findings).toHaveLength(1);
    const finding = findings[0];
    expect(finding.slug).toBe(SLUG);
    expect(finding.confidence).toBe("inferred");
    expect(finding.claimed).toBe(true);
    expect(finding.connection).not.toBeNull();
    expect(finding.connection!.kind).toBe("cross-file");
    expect(finding.connection!.edgeDistance).toBeGreaterThan(0);
    expect(finding.connection!.edgeDistance).toBeLessThanOrEqual(3);
  });

  it("mercadopago imported but structurally unused -> ambiguous, NOT claimed", async () => {
    const dir = fixtureMercadoPagoUnused();
    dirs.push(dir);

    const { findings } = await runPipeline(dir, USER.email);

    const finding = findings.find((f) => f.slug === SLUG);
    expect(finding).toBeDefined();
    expect(finding!.confidence).toBe("ambiguous");
    expect(finding!.claimed).toBe(false);
    expect(finding!.anchors.every((a) => a.kind !== "webhook-verification")).toBe(true);

    const stripeFinding = findings.find((f) => f.slug === "payments/payment-webhook-flow");
    expect(stripeFinding).toBeDefined();
    expect(stripeFinding!.confidence).toBe("direct");
  });

  it("pattern committed by a different author -> DIRECT overall, but unattributed and unclaimed for the selected user", async () => {
    const dir = fixtureMercadoPagoOtherAuthor();
    dirs.push(dir);

    const { findings } = await runPipeline(dir, USER.email);

    expect(findings).toHaveLength(1);
    const finding = findings[0];
    expect(finding.slug).toBe(SLUG);
    expect(finding.confidence).toBe("direct");
    expect(finding.attributed).toBe(false);
    expect(finding.claimed).toBe(false);
  });
});

describe("proof-graph H6 phase 2b — Lemon Squeezy (payments/lemonsqueezy-webhook-flow)", () => {
  const SLUG = "payments/lemonsqueezy-webhook-flow";

  it("one file, manual-HMAC verification (createHmac+timingSafeEqual, no package import) + Prisma upsert in the same function -> DIRECT (same-function), attributed, claimed", async () => {
    const dir = fixtureLemonSqueezyManualHmacDirect();
    dirs.push(dir);

    const { findings } = await runPipeline(dir, USER.email);

    expect(findings).toHaveLength(1);
    const finding = findings[0];
    expect(finding.slug).toBe(SLUG);
    expect(finding.confidence).toBe("direct");
    expect(finding.attributed).toBe(true);
    expect(finding.claimed).toBe(true);
    expect(finding.connection).toEqual({ kind: "same-function", edgeDistance: 0 });
  });

  it("three files connected only by relative imports (handler -> service -> repo) -> INFERRED, claimed, edgeDistance <= 3", async () => {
    const dir = fixtureLemonSqueezyLayered();
    dirs.push(dir);

    const { findings } = await runPipeline(dir, USER.email);

    expect(findings).toHaveLength(1);
    const finding = findings[0];
    expect(finding.slug).toBe(SLUG);
    expect(finding.confidence).toBe("inferred");
    expect(finding.claimed).toBe(true);
    expect(finding.connection).not.toBeNull();
    expect(finding.connection!.kind).toBe("cross-file");
    expect(finding.connection!.edgeDistance).toBeGreaterThan(0);
    expect(finding.connection!.edgeDistance).toBeLessThanOrEqual(3);
  });

  it("lemon squeezy imported but structurally unused -> ambiguous, NOT claimed", async () => {
    const dir = fixtureLemonSqueezyUnused();
    dirs.push(dir);

    const { findings } = await runPipeline(dir, USER.email);

    const finding = findings.find((f) => f.slug === SLUG);
    expect(finding).toBeDefined();
    expect(finding!.confidence).toBe("ambiguous");
    expect(finding!.claimed).toBe(false);
    expect(finding!.anchors.every((a) => a.kind !== "webhook-verification")).toBe(true);

    const stripeFinding = findings.find((f) => f.slug === "payments/payment-webhook-flow");
    expect(stripeFinding).toBeDefined();
    expect(stripeFinding!.confidence).toBe("direct");
  });

  it("pattern committed by a different author -> DIRECT overall, but unattributed and unclaimed for the selected user", async () => {
    const dir = fixtureLemonSqueezyOtherAuthor();
    dirs.push(dir);

    const { findings } = await runPipeline(dir, USER.email);

    expect(findings).toHaveLength(1);
    const finding = findings[0];
    expect(finding.slug).toBe(SLUG);
    expect(finding.confidence).toBe("direct");
    expect(finding.attributed).toBe(false);
    expect(finding.claimed).toBe(false);
  });
});

describe("proof-graph H6 phase 2b — Paddle (payments/paddle-webhook-flow)", () => {
  const SLUG = "payments/paddle-webhook-flow";

  it("one file, webhooks.unmarshal + Prisma upsert in the same function -> DIRECT (same-function), attributed, claimed", async () => {
    const dir = fixturePaddleDirect();
    dirs.push(dir);

    const { findings } = await runPipeline(dir, USER.email);

    expect(findings).toHaveLength(1);
    const finding = findings[0];
    expect(finding.slug).toBe(SLUG);
    expect(finding.confidence).toBe("direct");
    expect(finding.attributed).toBe(true);
    expect(finding.claimed).toBe(true);
    expect(finding.connection).toEqual({ kind: "same-function", edgeDistance: 0 });
  });

  it("three files connected only by relative imports (handler -> service -> repo) -> INFERRED, claimed, edgeDistance <= 3", async () => {
    const dir = fixturePaddleLayered();
    dirs.push(dir);

    const { findings } = await runPipeline(dir, USER.email);

    expect(findings).toHaveLength(1);
    const finding = findings[0];
    expect(finding.slug).toBe(SLUG);
    expect(finding.confidence).toBe("inferred");
    expect(finding.claimed).toBe(true);
    expect(finding.connection).not.toBeNull();
    expect(finding.connection!.kind).toBe("cross-file");
    expect(finding.connection!.edgeDistance).toBeGreaterThan(0);
    expect(finding.connection!.edgeDistance).toBeLessThanOrEqual(3);
  });

  it("paddle imported but structurally unused -> ambiguous, NOT claimed", async () => {
    const dir = fixturePaddleUnused();
    dirs.push(dir);

    const { findings } = await runPipeline(dir, USER.email);

    const finding = findings.find((f) => f.slug === SLUG);
    expect(finding).toBeDefined();
    expect(finding!.confidence).toBe("ambiguous");
    expect(finding!.claimed).toBe(false);
    expect(finding!.anchors.every((a) => a.kind !== "webhook-verification")).toBe(true);

    const stripeFinding = findings.find((f) => f.slug === "payments/payment-webhook-flow");
    expect(stripeFinding).toBeDefined();
    expect(stripeFinding!.confidence).toBe("direct");
  });

  it("pattern committed by a different author -> DIRECT overall, but unattributed and unclaimed for the selected user", async () => {
    const dir = fixturePaddleOtherAuthor();
    dirs.push(dir);

    const { findings } = await runPipeline(dir, USER.email);

    expect(findings).toHaveLength(1);
    const finding = findings[0];
    expect(finding.slug).toBe(SLUG);
    expect(finding.confidence).toBe("direct");
    expect(finding.attributed).toBe(false);
    expect(finding.claimed).toBe(false);
  });
});

describe("proof-graph H6 phase 2b — RevenueCat/IAP (payments/iap-subscription-flow)", () => {
  const SLUG = "payments/iap-subscription-flow";

  it("one file, configure + purchasePackage + a CALL-shaped entitlement gate in the same function -> DIRECT (same-function), attributed, claimed", async () => {
    const dir = fixtureIapDirect();
    dirs.push(dir);

    const { findings } = await runPipeline(dir, USER.email);

    expect(findings).toHaveLength(1);
    const finding = findings[0];
    expect(finding.slug).toBe(SLUG);
    expect(finding.confidence).toBe("direct");
    expect(finding.attributed).toBe(true);
    expect(finding.claimed).toBe(true);
    expect(finding.connection).toEqual({ kind: "same-function", edgeDistance: 0 });
  });

  it("three files connected only by relative imports (setup -> purchase -> gate) -> INFERRED, claimed, edgeDistance <= 3", async () => {
    const dir = fixtureIapLayered();
    dirs.push(dir);

    const { findings } = await runPipeline(dir, USER.email);

    expect(findings).toHaveLength(1);
    const finding = findings[0];
    expect(finding.slug).toBe(SLUG);
    expect(finding.confidence).toBe("inferred");
    expect(finding.claimed).toBe(true);
    expect(finding.connection).not.toBeNull();
    expect(finding.connection!.kind).toBe("cross-file");
    expect(finding.connection!.edgeDistance).toBeGreaterThan(0);
    expect(finding.connection!.edgeDistance).toBeLessThanOrEqual(3);
  });

  it("react-native-purchases imported but structurally unused -> ambiguous, NOT claimed", async () => {
    const dir = fixtureIapUnused();
    dirs.push(dir);

    const { findings } = await runPipeline(dir, USER.email);

    const finding = findings.find((f) => f.slug === SLUG);
    expect(finding).toBeDefined();
    expect(finding!.confidence).toBe("ambiguous");
    expect(finding!.claimed).toBe(false);
    // "iap-flow"'s own anchorKinds (iap-configure/iap-purchase/
    // iap-entitlement-gate) never overlap with Stripe's own kinds
    // (webhook-verification/db-write/idempotency-guard) at all — so, unlike
    // the webhook-flow patterns above (which legitimately share db-write/
    // idempotency-guard), this finding's anchors must be empty.
    expect(finding!.anchors).toEqual([]);

    const stripeFinding = findings.find((f) => f.slug === "payments/payment-webhook-flow");
    expect(stripeFinding).toBeDefined();
    expect(stripeFinding!.confidence).toBe("direct");
  });

  it("pattern committed by a different author -> DIRECT overall, but unattributed and unclaimed for the selected user", async () => {
    const dir = fixtureIapOtherAuthor();
    dirs.push(dir);

    const { findings } = await runPipeline(dir, USER.email);

    expect(findings).toHaveLength(1);
    const finding = findings[0];
    expect(finding.slug).toBe(SLUG);
    expect(finding.confidence).toBe("direct");
    expect(finding.attributed).toBe(false);
    expect(finding.claimed).toBe(false);
  });
});

// -----------------------------------------------------------------------
// Auth flows (issue #5)
// -----------------------------------------------------------------------

const SESSION_SLUG = "auth/session-flow";
const OAUTH_SLUG = "auth/oauth-flow";
const JWT_REFRESH_SLUG = "auth/jwt-refresh-flow";

const findBySlug = (findings: { slug: string }[], slug: string) => findings.find((f) => f.slug === slug);

describe("auth/session-flow end-to-end fixtures (issue #5)", () => {
  it("credential-verification + session-issuance + route-guard in one function -> DIRECT (same-function), claimed", async () => {
    const dir = fixtureAuthSessionDirect();
    dirs.push(dir);

    const { findings } = await runPipeline(dir, USER.email);

    const finding = findBySlug(findings, SESSION_SLUG);
    expect(finding).toBeDefined();
    expect(finding!.confidence).toBe("direct");
    expect(finding!.attributed).toBe(true);
    expect(finding!.claimed).toBe(true);
    expect(finding!.connection).toEqual({ kind: "same-function", edgeDistance: 0 });
  });

  it("three files connected by relative imports (handler -> issue -> guard) -> INFERRED, claimed", async () => {
    const dir = fixtureAuthSessionLayered();
    dirs.push(dir);

    const { findings } = await runPipeline(dir, USER.email);

    const finding = findBySlug(findings, SESSION_SLUG);
    expect(finding).toBeDefined();
    expect(finding!.confidence).toBe("inferred");
    expect(finding!.claimed).toBe(true);
    expect(finding!.connection!.kind).toBe("cross-file");
    expect(finding!.connection!.edgeDistance).toBeLessThanOrEqual(3);
    expect(new Set(finding!.anchors.map((a) => a.path)).size).toBeGreaterThanOrEqual(2);
  });

  it("supabase imported but no auth call wired -> AMBIGUOUS, never claimed, and carries no other pattern's anchors", async () => {
    const dir = fixtureAuthSessionUnused();
    dirs.push(dir);

    const { findings } = await runPipeline(dir, USER.email);

    const finding = findBySlug(findings, SESSION_SLUG);
    expect(finding).toBeDefined();
    expect(finding!.confidence).toBe("ambiguous");
    expect(finding!.claimed).toBe(false);
    // The ownAnchors guarantee: the co-located Stripe pattern's anchors must
    // never leak into this finding, even though both live in one repo.
    expect(finding!.anchors.every((a) => !a.path.includes("stripe"))).toBe(true);
    // ...while the unrelated Stripe pattern still classifies on its own.
    expect(findBySlug(findings, "payments/payment-webhook-flow")!.confidence).toBe("direct");
  });

  it("pattern committed by a different author -> DIRECT overall, unattributed and unclaimed", async () => {
    const dir = fixtureAuthSessionOtherAuthor();
    dirs.push(dir);

    const { findings } = await runPipeline(dir, USER.email);

    const finding = findBySlug(findings, SESSION_SLUG);
    expect(finding!.confidence).toBe("direct");
    expect(finding!.attributed).toBe(false);
    expect(finding!.claimed).toBe(false);
  });
});

describe("auth/oauth-flow end-to-end fixtures (issue #5)", () => {
  it("authorize-redirect + code-exchange + session-issuance in one function -> DIRECT (same-function), claimed", async () => {
    const dir = fixtureAuthOauthDirect();
    dirs.push(dir);

    const { findings } = await runPipeline(dir, USER.email);

    const finding = findBySlug(findings, OAUTH_SLUG);
    expect(finding).toBeDefined();
    expect(finding!.confidence).toBe("direct");
    expect(finding!.claimed).toBe(true);
    expect(finding!.connection).toEqual({ kind: "same-function", edgeDistance: 0 });
  });

  it("three files connected by relative imports (login -> callback -> session) -> INFERRED, claimed", async () => {
    const dir = fixtureAuthOauthLayered();
    dirs.push(dir);

    const { findings } = await runPipeline(dir, USER.email);

    const finding = findBySlug(findings, OAUTH_SLUG);
    expect(finding!.confidence).toBe("inferred");
    expect(finding!.claimed).toBe(true);
    expect(finding!.connection!.kind).toBe("cross-file");
  });

  it("a login BUTTON with no authorize/exchange/session call -> AMBIGUOUS, never claimed", async () => {
    const dir = fixtureAuthOauthUnused();
    dirs.push(dir);

    const { findings } = await runPipeline(dir, USER.email);

    const finding = findBySlug(findings, OAUTH_SLUG);
    expect(finding!.confidence).toBe("ambiguous");
    expect(finding!.claimed).toBe(false);
  });

  it("pattern committed by a different author -> DIRECT overall, unattributed and unclaimed", async () => {
    const dir = fixtureAuthOauthOtherAuthor();
    dirs.push(dir);

    const { findings } = await runPipeline(dir, USER.email);

    const finding = findBySlug(findings, OAUTH_SLUG);
    expect(finding!.confidence).toBe("direct");
    expect(finding!.attributed).toBe(false);
    expect(finding!.claimed).toBe(false);
  });
});

describe("auth/jwt-refresh-flow end-to-end fixtures (issue #5)", () => {
  it("verify + rotate + guard, no invalidation -> full triad found but capped at 'inferred', claimed", async () => {
    const dir = fixtureAuthJwtRefreshDirect();
    dirs.push(dir);

    const { anchors, findings } = await runPipeline(dir, USER.email);

    expect(anchors.some((a) => a.kind === "refresh-rotation")).toBe(true);
    expect(anchors.some((a) => a.kind === "refresh-invalidation")).toBe(false);
    const finding = findBySlug(findings, JWT_REFRESH_SLUG);
    expect(finding!.confidence).toBe("inferred");
    expect(finding!.claimed).toBe(true);
    // The cap touches confidence ONLY — the real topology is still reported.
    expect(finding!.connection).toEqual({ kind: "same-function", edgeDistance: 0 });
  });

  it("verify + rotate + guard + invalidation of the old token -> cap lifts, DIRECT, claimed", async () => {
    const dir = fixtureAuthJwtRefreshWithInvalidation();
    dirs.push(dir);

    const { anchors, findings } = await runPipeline(dir, USER.email);

    expect(anchors.some((a) => a.kind === "refresh-invalidation")).toBe(true);
    const finding = findBySlug(findings, JWT_REFRESH_SLUG);
    expect(finding!.confidence).toBe("direct");
    expect(finding!.claimed).toBe(true);
  });

  it("cross-file (verify+rotate) vs guard -> INFERRED, claimed (also capped, same value)", async () => {
    const dir = fixtureAuthJwtRefreshLayered();
    dirs.push(dir);

    const { findings } = await runPipeline(dir, USER.email);

    const finding = findBySlug(findings, JWT_REFRESH_SLUG);
    expect(finding!.confidence).toBe("inferred");
    expect(finding!.connection!.kind).toBe("cross-file");
  });

  it("jsonwebtoken imported but never called -> AMBIGUOUS, never claimed", async () => {
    const dir = fixtureAuthJwtRefreshUnused();
    dirs.push(dir);

    const { findings } = await runPipeline(dir, USER.email);

    const finding = findBySlug(findings, JWT_REFRESH_SLUG);
    expect(finding!.confidence).toBe("ambiguous");
    expect(finding!.claimed).toBe(false);
  });

  it("pattern committed by a different author -> unattributed and unclaimed", async () => {
    const dir = fixtureAuthJwtRefreshOtherAuthor();
    dirs.push(dir);

    const { findings } = await runPipeline(dir, USER.email);

    const finding = findBySlug(findings, JWT_REFRESH_SLUG);
    expect(finding!.attributed).toBe(false);
    expect(finding!.claimed).toBe(false);
  });

  // ---------------------------------------------------------------------
  // REGRESSION GUARDS for the over-claim an earlier draft of this milestone
  // shipped. That draft read issue #5 as making refresh-rotation the OPTIONAL
  // member of this triad, by analogy with Mercado Pago's idempotency-guard.
  // The analogy does not hold: an idempotency guard STRENGTHENS a payment
  // webhook flow, whereas rotation IS the refresh flow. With rotation
  // optional, the pattern classified from token-verification +
  // guard-response alone — so "verify a token, deny with 401", one of the
  // most common shapes in any web codebase, produced a CLAIMED
  // jwt-refresh-flow finding on code that refreshes nothing.
  //
  // Both tests below assert that shape now yields NO claim.
  // ---------------------------------------------------------------------

  it("verification + guard with NO rotation anywhere -> cannot classify, ambiguous, never claimed", async () => {
    const dir = fixtureAuthJwtRefreshNoRotation();
    dirs.push(dir);

    const { anchors, findings } = await runPipeline(dir, USER.email);

    expect(anchors.some((a) => a.kind === "refresh-rotation")).toBe(false);
    const finding = findBySlug(findings, JWT_REFRESH_SLUG);
    expect(finding!.confidence).toBe("ambiguous");
    expect(finding!.claimed).toBe(false);
  });

  it("a plain Supabase password login does NOT claim auth/jwt-refresh-flow", async () => {
    const dir = fixtureAuthSessionDirect();
    dirs.push(dir);

    const { anchors, findings } = await runPipeline(dir, USER.email);

    // getUser() is a real token-verification anchor and res.status(401) a
    // real guard-response anchor — both genuinely present, both in one
    // function. What is absent is any rotation at all.
    expect(anchors.some((a) => a.kind === "token-verification")).toBe(true);
    expect(anchors.some((a) => a.kind === "guard-response")).toBe(true);
    expect(anchors.some((a) => a.kind === "refresh-rotation")).toBe(false);

    // So the pattern must not claim. (It still surfaces as ambiguous, on
    // package presence — ambiguous never claims, which is the whole point.)
    const finding = findBySlug(findings, JWT_REFRESH_SLUG);
    expect(finding!.claimed).toBe(false);

    // ...while the session flow this code actually IS still claims correctly.
    expect(findBySlug(findings, SESSION_SLUG)!.claimed).toBe(true);
  });
});

describe("auth flows — negative fixtures (#28 discipline, issue #5)", () => {
  it("jwt.decode only -> NO token-verification anchor, and no claimed finding", async () => {
    const dir = fixtureAuthJwtDecodeOnly();
    dirs.push(dir);

    const { anchors, findings } = await runPipeline(dir, USER.email);

    // The honesty rule, asserted directly: decode is not verification.
    expect(anchors.some((a) => a.kind === "token-verification")).toBe(false);
    expect(anchors.some((a) => a.kind === "credential-verification")).toBe(false);
    // See fixtureAuthJwtDecodeOnly's own comment on why this is "no CLAIMED
    // finding" rather than the issue's literal "zero findings".
    expect(findings.every((f) => !f.claimed)).toBe(true);
  });

  it("a rendered login form with no auth import -> no auth finding at all", async () => {
    const dir = fixtureAuthLoginFormOnly();
    dirs.push(dir);

    const { findings } = await runPipeline(dir, USER.email);

    expect(findBySlug(findings, SESSION_SLUG)).toBeUndefined();
    expect(findBySlug(findings, OAUTH_SLUG)).toBeUndefined();
    expect(findBySlug(findings, JWT_REFRESH_SLUG)).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // REGRESSION GUARD for jpbelmo's review question on PR #54: can an auth
  // triad be satisfied ACROSS libraries, claiming a flow no single library
  // completes? It could. This fixture reproduced it end-to-end — both
  // auth/oauth-flow and auth/session-flow claimed — before same-library
  // scoping landed in inferStructuralSkills.
  //
  // Worth recording why "cap it at inferred" was NOT the fix: buildFinding
  // sets `claimed = confidence !== "ambiguous" && attributed`, so an
  // inferred finding still claims. Lowering confidence would have relabelled
  // the false claim, not removed it.
  // -----------------------------------------------------------------------
  it("three unrelated auth libraries do NOT combine into a claimed flow", async () => {
    const dir = fixtureAuthMixedLibraries();
    dirs.push(dir);

    const { anchors, findings } = await runPipeline(dir, USER.email);

    // Each library contributes only its own part, and the reason strings are
    // the only place library identity survives at all.
    const reasons = anchors.map((a) => a.reason).join("\n");
    expect(reasons).toContain("NextAuth/Auth.js");
    expect(reasons).toContain("Supabase Auth");
    expect(reasons).toContain("plain JWT");

    // No single library completes either triad (see the fixture's own
    // comment for the per-library breakdown), so neither may claim.
    expect(findBySlug(findings, OAUTH_SLUG)!.claimed).toBe(false);
    expect(findBySlug(findings, SESSION_SLUG)!.claimed).toBe(false);

    // Anchors are still FOUND — this is a classification fix, not a
    // recognition one. Each library's own contribution is present and
    // correctly attributed to it; they simply no longer combine.
    const byLibrary = (id: string) => anchors.filter((a) => a.libraryId === id);
    expect(byLibrary("NextAuth/Auth.js").length).toBeGreaterThan(0);
    expect(byLibrary("Supabase Auth").length).toBeGreaterThan(0);

    // Guard anchors carry no library and stay shared across scopes, so a
    // real single-library flow can still find its own guard.
    expect(anchors.some((a) => a.kind === "guard-response" && a.libraryId === undefined)).toBe(true);
  });

  it("a real single-library flow STILL claims when a second, partial library shares the repo", async () => {
    const dir = fixtureAuthScopedFlowWithOverlappingLibrary();
    dirs.push(dir);

    const { anchors, findings } = await runPipeline(dir, USER.email);

    // Both libraries are present, so scoping is engaged (not a no-op path).
    expect(anchors.some((a) => a.libraryId === "Supabase Auth")).toBe(true);
    expect(anchors.some((a) => a.libraryId === "NextAuth/Auth.js")).toBe(true);

    // Supabase covers all three of session-flow's kinds (route-guard via the
    // library-agnostic anchor); NextAuth covers two. coverage() must pick
    // Supabase, and the flow must still claim at full strength.
    const session = findBySlug(findings, SESSION_SLUG);
    expect(session!.confidence).toBe("direct");
    expect(session!.claimed).toBe(true);
    expect(session!.connection).toEqual({ kind: "same-function", edgeDistance: 0 });

    // ...and every supporting anchor is Supabase's or library-agnostic —
    // NextAuth's partial contribution never leaks into the claim.
    expect(session!.anchors.every((a) => a.libraryId === undefined || a.libraryId === "Supabase Auth")).toBe(true);
  });

  it("an ALIASED named import still matches on the exported name", async () => {
    const dir = fixtureAuthAliasedImport();
    dirs.push(dir);

    const { anchors } = await runPipeline(dir, USER.email);

    // `import { signIn as login }` — the local name appears in no
    // descriptor, so this only fires if the exported name is preferred.
    const nextAuth = anchors.filter((a) => a.libraryId === "NextAuth/Auth.js");
    expect(nextAuth.length).toBeGreaterThan(0);
    expect(nextAuth.some((a) => a.kind === "authorize-redirect")).toBe(true);
    expect(nextAuth.some((a) => a.kind === "session-issuance")).toBe(true);
    expect(nextAuth.every((a) => a.reason.includes("signIn"))).toBe(true);
  });

  it("guard-shaped 401 with NO auth library -> guard anchors exist but manufacture no finding", async () => {
    const dir = fixtureAuthGuardWithoutAuthLibrary();
    dirs.push(dir);

    const { anchors, findings } = await runPipeline(dir, USER.email);

    // Guard recognition is ungated on auth imports, same posture as db-write.
    expect(anchors.some((a) => a.kind === "route-guard")).toBe(true);
    expect(anchors.some((a) => a.kind === "guard-response")).toBe(true);
    // ...and still cannot produce a finding on its own.
    expect(findBySlug(findings, SESSION_SLUG)).toBeUndefined();
    expect(findBySlug(findings, JWT_REFRESH_SLUG)).toBeUndefined();
  });
});
