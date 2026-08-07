// H3 of the proof-graph spike (see docs/proof-graph-spike.md): programmatic
// tmpdir git-repo fixtures for detection.test.ts's end-to-end pipeline test.
// Same posture as every other fixture in this repo (CLAUDE.md's testing
// conventions): a tiny git repo built in a tmpdir at test time, never a
// committed fixture directory with real history. Reuses test/support/
// fixtures.ts's createRepo/commit (which already disables git's background
// maintenance — see commit 36539f4 — and is the exact same primitive every
// other test in this repo builds fixture repos with).
//
// Each builder below returns only the repo's tmpdir path (a plain string),
// mirroring createRepo()'s own return type and the pattern
// test/proof-graph/infer.test.ts's "collectUserTouchedFiles" describe block
// already uses: the caller pushes the path onto its own `dirs` array and
// calls test/support/fixtures.ts's cleanup() in an afterEach, rather than
// each fixture managing its own disposal.
import { commit, createRepo } from "../support/fixtures.js";

// Two identities every case below is built against. Exported so
// detection.test.ts can assert against them directly (e.g. filtering
// getAllCommits' output by USER.email) instead of re-declaring the same
// strings.
export const USER = { name: "Dev User", email: "user@example.com" };
export const OTHER = { name: "Other Dev", email: "other@example.com" };

// Obviously-fake secret value (repo rule: "Never create files with secrets
// or example values that look real (use xxx-EXAMPLE-xxx)") — reused across
// every fixture below that needs a Stripe secret-key-shaped literal.
const FAKE_STRIPE_SECRET = "sk_test_xxx-EXAMPLE-xxx";

/**
 * ONE file (src/webhook.ts), committed by USER, containing the full
 * connected pattern (webhook signature verification -> DB read -> DB write,
 * all inside one function) — the shape inferStructuralSkills classifies as
 * DIRECT (same-function).
 */
export function fixtureDirectPattern(): string {
  const dir = createRepo();
  commit(dir, {
    message: "add stripe webhook handler",
    authorName: USER.name,
    authorEmail: USER.email,
    files: {
      "src/webhook.ts": [
        'import Stripe from "stripe";',
        'import { PrismaClient } from "@prisma/client";',
        "",
        `const stripe = new Stripe("${FAKE_STRIPE_SECRET}");`,
        "const prisma = new PrismaClient();",
        "",
        "export async function handleWebhook(req, res) {",
        '  const event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], secret);',
        "  const existing = await prisma.payment.findUnique({ where: { id: event.id } });",
        '  if (existing) return res.status(200).send("already processed");',
        "  await prisma.payment.create({ data: { id: event.id } });",
        '  res.status(200).send("ok");',
        "}",
        "",
      ].join("\n"),
    },
  });
  return dir;
}

/**
 * THREE files, all committed by USER, connected only through RELATIVE
 * imports: src/handler.ts (webhook signature verification) imports
 * src/service.ts, which imports src/repo.ts (a Prisma upsert — which is
 * BOTH the db-write and the idempotency-guard anchor, per anchors.ts's
 * "upsert is idempotent by construction" rule; that dual count is
 * intentional, not a fixture bug). Import-chain distance from
 * src/handler.ts to src/repo.ts is 2 hops (handler -> service -> repo),
 * within inferStructuralSkills' <=3 edge bound — the shape classifies as
 * INFERRED.
 */
export function fixtureLayeredPattern(): string {
  const dir = createRepo();
  commit(dir, {
    message: "add layered webhook handler (handler -> service -> repo)",
    authorName: USER.name,
    authorEmail: USER.email,
    files: {
      "src/handler.ts": [
        'import Stripe from "stripe";',
        'import { persistEvent } from "./service.js";',
        "",
        `const stripe = new Stripe("${FAKE_STRIPE_SECRET}");`,
        "",
        "export async function handleWebhook(req) {",
        '  const event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], secret);',
        "  await persistEvent(event);",
        "}",
        "",
      ].join("\n"),
      "src/service.ts": [
        'import { upsertPayment } from "./repo.js";',
        "",
        "export async function persistEvent(event) {",
        "  await upsertPayment(event);",
        "}",
        "",
      ].join("\n"),
      "src/repo.ts": [
        'import { PrismaClient } from "@prisma/client";',
        "",
        "const prisma = new PrismaClient();",
        "",
        "export async function upsertPayment(event) {",
        "  await prisma.payment.upsert({ where: { id: event.id }, create: { id: event.id }, update: {} });",
        "}",
        "",
      ].join("\n"),
    },
  });
  return dir;
}

/**
 * USER commits a file that ONLY imports "stripe" — no webhook-verification
 * call, no DB write, no idempotency guard reachable anywhere. The deliberate
 * false-negative case (docs/proof-graph-spike.md's H3 entry): the structural
 * tier classifies this AMBIGUOUS and never claims it, while Tier 1's plain
 * import-based skill-detect.ts still reports "payments/stripe" from the same
 * import line — both tiers are expected to coexist, see detection.test.ts's
 * own comment on this case.
 */
export function fixtureStripeUnused(): string {
  const dir = createRepo();
  commit(dir, {
    message: "add unused stripe client",
    authorName: USER.name,
    authorEmail: USER.email,
    files: {
      "src/stripe-client.ts": [
        'import Stripe from "stripe";',
        "",
        `export const stripe = new Stripe("${FAKE_STRIPE_SECRET}");`,
        "",
      ].join("\n"),
    },
  });
  return dir;
}

/**
 * The exact same connected pattern as fixtureDirectPattern's src/webhook.ts,
 * but committed by OTHER — not USER. USER separately commits only an
 * unrelated file (src/util.ts, no anchors at all). The structural pattern is
 * still present and classifies DIRECT (findAnchors/inferStructuralSkills
 * operate on the HEAD snapshot, independent of who authored what), but
 * attribution (file-level intersection with USER's own touched files, see
 * infer.ts's collectUserTouchedFiles) fails: attributed=false, claimed=false
 * for USER.
 */
export function fixtureOtherAuthor(): string {
  const dir = createRepo();
  commit(dir, {
    message: "add stripe webhook handler",
    authorName: OTHER.name,
    authorEmail: OTHER.email,
    files: {
      "src/webhook.ts": [
        'import Stripe from "stripe";',
        'import { PrismaClient } from "@prisma/client";',
        "",
        `const stripe = new Stripe("${FAKE_STRIPE_SECRET}");`,
        "const prisma = new PrismaClient();",
        "",
        "export async function handleWebhook(req, res) {",
        '  const event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], secret);',
        "  const existing = await prisma.payment.findUnique({ where: { id: event.id } });",
        '  if (existing) return res.status(200).send("already processed");',
        "  await prisma.payment.create({ data: { id: event.id } });",
        '  res.status(200).send("ok");',
        "}",
        "",
      ].join("\n"),
    },
  });
  commit(dir, {
    message: "add unrelated util",
    authorName: USER.name,
    authorEmail: USER.email,
    files: {
      "src/util.ts": ["export function noop() {", "  return null;", "}", ""].join("\n"),
    },
  });
  return dir;
}

/**
 * USER commits a file where "stripe"/"constructEvent"/"prisma" appear ONLY
 * inside comments and a no-substitution template-literal string (a
 * docs-generator-style file rendering an example code snippet) — never as a
 * real `import` declaration or a real call. The TypeScript compiler API
 * parses comments as trivia (never AST nodes) and a template literal's own
 * text as a single string value (never re-parsed as code), so this produces
 * neither a real ParsedImport nor any ParsedCall — findAnchors must return
 * [] and inferStructuralSkills must return [] (no stripe presence anywhere
 * in the real syntax tree, not even the weaker "external import" signal).
 */
export function fixtureCommentsOnly(): string {
  const dir = createRepo();
  commit(dir, {
    message: "add webhook docs generator",
    authorName: USER.name,
    authorEmail: USER.email,
    files: {
      "src/docs-generator.ts": [
        "// Example snippet for our docs site (never executed, never imported):",
        "//",
        '// import Stripe from "stripe";',
        '// import { PrismaClient } from "@prisma/client";',
        "//",
        "// const event = stripe.webhooks.constructEvent(body, sig, secret);",
        "// const existing = await prisma.payment.findUnique({ where: { id: event.id } });",
        "// await prisma.payment.create({ data: { id: event.id } });",
        "",
        "export function renderExampleSnippet() {",
        "  const snippet = `stripe.webhooks.constructEvent(body, sig, secret)`;",
        "  return snippet;",
        "}",
        "",
      ].join("\n"),
    },
  });
  return dir;
}

// -----------------------------------------------------------------------
// H6 phase 2b — end-to-end fixtures for the 5 new patterns anchors.ts/
// infer.ts's H6 phase 2a work added: PayPal, Mercado Pago, Lemon Squeezy,
// Paddle (all "webhook-flow" pattern kind, same shape family as the Stripe
// fixtures above) and RevenueCat/IAP (its own "iap-flow" shape). Same
// posture/reuse rationale as every builder above: tiny tmpdir git repos,
// USER/OTHER identities, one or two commits, 1-3 files per repo.
//
// A shared "Stripe noise" file (stripeNoiseFileContent below) is added to
// each new provider's "imported but structurally unused" fixture — see that
// helper's own comment for why: it's what actually exercises the H6 phase 2a
// ownAnchors fix (a *different* provider's own webhook-verification anchor
// present in the SAME repo must never leak into this provider's AMBIGUOUS
// finding), not just a restatement of fixtureStripeUnused's simpler "nothing
// else in the repo at all" case.
// -----------------------------------------------------------------------

/**
 * The exact same connected pattern as fixtureDirectPattern's src/webhook.ts,
 * committed under a different path/function name so it can be added
 * alongside another provider's own file in the SAME repo/commit as
 * cross-provider "noise" — see the "imported but structurally unused"
 * fixtures below for each of the 5 new patterns, all of which use this to
 * prove a *different* provider's webhook-verification anchor doesn't leak
 * into the unused provider's AMBIGUOUS finding (the H6 phase 2a ownAnchors
 * fix).
 */
function stripeNoiseFileContent(): string {
  return [
    'import Stripe from "stripe";',
    'import { PrismaClient } from "@prisma/client";',
    "",
    `const stripe = new Stripe("${FAKE_STRIPE_SECRET}");`,
    "const prisma = new PrismaClient();",
    "",
    "export async function handleStripeNoiseWebhook(req, res) {",
    '  const event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], secret);',
    "  const existing = await prisma.payment.findUnique({ where: { id: event.id } });",
    '  if (existing) return res.status(200).send("already processed");',
    "  await prisma.payment.create({ data: { id: event.id } });",
    '  res.status(200).send("ok");',
    "}",
    "",
  ].join("\n");
}

// -----------------------------------------------------------------------
// PayPal (payments/paypal-webhook-flow)
// -----------------------------------------------------------------------

/**
 * ONE file, USER-committed: paypalClient.verifyWebhookSignature(...) (root
 * resolved directly to the "@paypal/checkout-server-sdk" import, per
 * WEBHOOK_PROVIDERS' paypal descriptor) -> Prisma upsert (both the db-write
 * AND, by construction, the idempotency-guard anchor), all inside one
 * function -> DIRECT (same-function).
 */
export function fixturePaypalDirect(): string {
  const dir = createRepo();
  commit(dir, {
    message: "add paypal webhook handler",
    authorName: USER.name,
    authorEmail: USER.email,
    files: {
      "src/webhook.ts": [
        'import paypalClient from "@paypal/checkout-server-sdk";',
        'import { PrismaClient } from "@prisma/client";',
        "",
        "const prisma = new PrismaClient();",
        "",
        "export async function handlePaypalWebhook(req, res) {",
        "  const verification = await paypalClient.verifyWebhookSignature({",
        '    transmissionId: req.headers["paypal-transmission-id"],',
        "    webhookEvent: req.body,",
        "  });",
        "  await prisma.payment.upsert({",
        "    where: { id: verification.id },",
        "    create: { id: verification.id },",
        "    update: {},",
        "  });",
        '  res.status(200).send("ok");',
        "}",
        "",
      ].join("\n"),
    },
  });
  return dir;
}

/**
 * THREE files connected only by relative imports: src/handler.ts (PayPal
 * verify call) -> src/service.ts -> src/repo.ts (Prisma upsert). Same 2-hop
 * shape as fixtureLayeredPattern -> INFERRED.
 */
export function fixturePaypalLayered(): string {
  const dir = createRepo();
  commit(dir, {
    message: "add layered paypal webhook handler (handler -> service -> repo)",
    authorName: USER.name,
    authorEmail: USER.email,
    files: {
      "src/handler.ts": [
        'import paypalClient from "@paypal/checkout-server-sdk";',
        'import { persistEvent } from "./service.js";',
        "",
        "export async function handlePaypalWebhook(req) {",
        "  const verification = await paypalClient.verifyWebhookSignature({",
        '    transmissionId: req.headers["paypal-transmission-id"],',
        "    webhookEvent: req.body,",
        "  });",
        "  await persistEvent(verification);",
        "}",
        "",
      ].join("\n"),
      "src/service.ts": [
        'import { upsertPayment } from "./repo.js";',
        "",
        "export async function persistEvent(verification) {",
        "  await upsertPayment(verification);",
        "}",
        "",
      ].join("\n"),
      "src/repo.ts": [
        'import { PrismaClient } from "@prisma/client";',
        "",
        "const prisma = new PrismaClient();",
        "",
        "export async function upsertPayment(verification) {",
        "  await prisma.payment.upsert({ where: { id: verification.id }, create: { id: verification.id }, update: {} });",
        "}",
        "",
      ].join("\n"),
    },
  });
  return dir;
}

/**
 * USER commits a file that ONLY imports "@paypal/checkout-server-sdk" — no
 * verifyWebhookSignature call anywhere — alongside an UNRELATED, fully
 * connected Stripe pattern (stripeNoiseFileContent) in the same commit. The
 * PayPal pattern classifies AMBIGUOUS (package imported, never wired in);
 * the Stripe pattern classifies DIRECT. Proves the H6 phase 2a ownAnchors
 * fix: the PayPal AMBIGUOUS finding's anchors must never include Stripe's
 * own webhook-verification anchor, even though both are present in the same
 * repo (see detection.test.ts's assertion on this fixture).
 */
export function fixturePaypalUnused(): string {
  const dir = createRepo();
  commit(dir, {
    message: "add unused paypal client alongside an unrelated stripe handler",
    authorName: USER.name,
    authorEmail: USER.email,
    files: {
      "src/paypal-client.ts": ['import paypalClient from "@paypal/checkout-server-sdk";', "", "export const client = paypalClient;", ""].join(
        "\n"
      ),
      "src/stripe-webhook.ts": stripeNoiseFileContent(),
    },
  });
  return dir;
}

/**
 * The exact same connected PayPal pattern as fixturePaypalDirect's
 * src/webhook.ts, but committed by OTHER — not USER. USER separately commits
 * only an unrelated file. Classifies DIRECT overall, but unattributed and
 * unclaimed for USER — same shape as fixtureOtherAuthor.
 */
export function fixturePaypalOtherAuthor(): string {
  const dir = createRepo();
  commit(dir, {
    message: "add paypal webhook handler",
    authorName: OTHER.name,
    authorEmail: OTHER.email,
    files: {
      "src/webhook.ts": [
        'import paypalClient from "@paypal/checkout-server-sdk";',
        'import { PrismaClient } from "@prisma/client";',
        "",
        "const prisma = new PrismaClient();",
        "",
        "export async function handlePaypalWebhook(req, res) {",
        "  const verification = await paypalClient.verifyWebhookSignature({",
        '    transmissionId: req.headers["paypal-transmission-id"],',
        "    webhookEvent: req.body,",
        "  });",
        "  await prisma.payment.upsert({",
        "    where: { id: verification.id },",
        "    create: { id: verification.id },",
        "    update: {},",
        "  });",
        '  res.status(200).send("ok");',
        "}",
        "",
      ].join("\n"),
    },
  });
  commit(dir, {
    message: "add unrelated util",
    authorName: USER.name,
    authorEmail: USER.email,
    files: {
      "src/util.ts": ["export function noop() {", "  return null;", "}", ""].join("\n"),
    },
  });
  return dir;
}

// -----------------------------------------------------------------------
// Mercado Pago (payments/mercadopago-flow) — the one pattern with an
// optionalAnchorKinds cap on idempotency-guard (see infer.ts's
// STRUCTURAL_PATTERNS entry and its own comment). Needs 5 fixtures, not 4:
// the cap case, the cap-LIFTED case (an upsert makes idempotency-guard
// present again), plus the usual layered/unused/other-author trio.
// -----------------------------------------------------------------------

/**
 * ONE file, USER-committed: `new Preference(client).create(...)` (resolved
 * to Mercado Pago's `creationChainSuffixes` rule) co-located, in the SAME
 * function, with a plain (non-upsert) Prisma `.create(...)` write — no
 * idempotency signal anywhere in the repo (no upsert, no explicit
 * idempotencyKey, no prior DB read in this function). Despite being
 * same-function co-located, infer.ts's optionalAnchorKinds cap means this
 * classifies "inferred", NOT "direct" — see
 * StructuralPattern.optionalAnchorKinds' own comment in infer.ts.
 */
export function fixtureMercadoPagoDirectNoIdempotency(): string {
  const dir = createRepo();
  commit(dir, {
    message: "add mercadopago webhook handler (no idempotency guard anywhere)",
    authorName: USER.name,
    authorEmail: USER.email,
    files: {
      "src/webhook.ts": [
        'import { MercadoPagoConfig, Preference } from "mercadopago";',
        'import { PrismaClient } from "@prisma/client";',
        "",
        'const client = new MercadoPagoConfig({ accessToken: "xxx-EXAMPLE-xxx" });',
        "const prisma = new PrismaClient();",
        "",
        "export async function handleMercadoPagoWebhook(req, res) {",
        "  const preference = new Preference(client);",
        "  const result = await preference.create({ body: { items: req.body.items } });",
        "  await prisma.payment.create({ data: { id: result.id } });",
        '  res.status(200).send("ok");',
        "}",
        "",
      ].join("\n"),
    },
  });
  return dir;
}

/**
 * Same shape as fixtureMercadoPagoDirectNoIdempotency, but the Prisma write
 * is an upsert — idempotent by construction (see anchors.ts's rule 1), which
 * makes idempotency-guard globally present again. Proves the cap LIFTS: this
 * classifies "direct" (same-function), not "inferred".
 */
export function fixtureMercadoPagoDirectWithUpsert(): string {
  const dir = createRepo();
  commit(dir, {
    message: "add mercadopago webhook handler (upsert lifts the idempotency cap)",
    authorName: USER.name,
    authorEmail: USER.email,
    files: {
      "src/webhook.ts": [
        'import { MercadoPagoConfig, Preference } from "mercadopago";',
        'import { PrismaClient } from "@prisma/client";',
        "",
        'const client = new MercadoPagoConfig({ accessToken: "xxx-EXAMPLE-xxx" });',
        "const prisma = new PrismaClient();",
        "",
        "export async function handleMercadoPagoWebhook(req, res) {",
        "  const preference = new Preference(client);",
        "  const result = await preference.create({ body: { items: req.body.items } });",
        "  await prisma.payment.upsert({ where: { id: result.id }, create: { id: result.id }, update: {} });",
        '  res.status(200).send("ok");',
        "}",
        "",
      ].join("\n"),
    },
  });
  return dir;
}

/**
 * THREE files connected only by relative imports: src/handler.ts (creation
 * call) -> src/service.ts -> src/repo.ts (Prisma upsert — both the db-write
 * and idempotency-guard anchor, so the optional-kind cap never engages
 * here). Same 2-hop shape as fixtureLayeredPattern -> INFERRED.
 */
export function fixtureMercadoPagoLayered(): string {
  const dir = createRepo();
  commit(dir, {
    message: "add layered mercadopago webhook handler (handler -> service -> repo)",
    authorName: USER.name,
    authorEmail: USER.email,
    files: {
      "src/handler.ts": [
        'import { MercadoPagoConfig, Preference } from "mercadopago";',
        'import { persistPreference } from "./service.js";',
        "",
        'const client = new MercadoPagoConfig({ accessToken: "xxx-EXAMPLE-xxx" });',
        "",
        "export async function handleMercadoPagoWebhook(req) {",
        "  const preference = new Preference(client);",
        "  const result = await preference.create({ body: { items: req.body.items } });",
        "  await persistPreference(result);",
        "}",
        "",
      ].join("\n"),
      "src/service.ts": [
        'import { upsertPreference } from "./repo.js";',
        "",
        "export async function persistPreference(result) {",
        "  await upsertPreference(result);",
        "}",
        "",
      ].join("\n"),
      "src/repo.ts": [
        'import { PrismaClient } from "@prisma/client";',
        "",
        "const prisma = new PrismaClient();",
        "",
        "export async function upsertPreference(result) {",
        "  await prisma.payment.upsert({ where: { id: result.id }, create: { id: result.id }, update: {} });",
        "}",
        "",
      ].join("\n"),
    },
  });
  return dir;
}

/**
 * USER commits a file that ONLY imports "mercadopago" (constructs the
 * config client, never calls `.create(...)` on a Preference/Payment) —
 * alongside an unrelated, fully connected Stripe pattern in the same commit.
 * Same "prove the ownAnchors fix" shape as fixturePaypalUnused.
 */
export function fixtureMercadoPagoUnused(): string {
  const dir = createRepo();
  commit(dir, {
    message: "add unused mercadopago client alongside an unrelated stripe handler",
    authorName: USER.name,
    authorEmail: USER.email,
    files: {
      "src/mercadopago-client.ts": [
        'import { MercadoPagoConfig } from "mercadopago";',
        "",
        'export const client = new MercadoPagoConfig({ accessToken: "xxx-EXAMPLE-xxx" });',
        "",
      ].join("\n"),
      "src/stripe-webhook.ts": stripeNoiseFileContent(),
    },
  });
  return dir;
}

/**
 * The exact same connected Mercado Pago pattern (upsert variant, so the
 * optional-kind cap doesn't complicate this attribution-only case) as
 * fixtureMercadoPagoDirectWithUpsert's src/webhook.ts, but committed by
 * OTHER — not USER. Classifies DIRECT overall, but unattributed and
 * unclaimed for USER.
 */
export function fixtureMercadoPagoOtherAuthor(): string {
  const dir = createRepo();
  commit(dir, {
    message: "add mercadopago webhook handler",
    authorName: OTHER.name,
    authorEmail: OTHER.email,
    files: {
      "src/webhook.ts": [
        'import { MercadoPagoConfig, Preference } from "mercadopago";',
        'import { PrismaClient } from "@prisma/client";',
        "",
        'const client = new MercadoPagoConfig({ accessToken: "xxx-EXAMPLE-xxx" });',
        "const prisma = new PrismaClient();",
        "",
        "export async function handleMercadoPagoWebhook(req, res) {",
        "  const preference = new Preference(client);",
        "  const result = await preference.create({ body: { items: req.body.items } });",
        "  await prisma.payment.upsert({ where: { id: result.id }, create: { id: result.id }, update: {} });",
        '  res.status(200).send("ok");',
        "}",
        "",
      ].join("\n"),
    },
  });
  commit(dir, {
    message: "add unrelated util",
    authorName: USER.name,
    authorEmail: USER.email,
    files: {
      "src/util.ts": ["export function noop() {", "  return null;", "}", ""].join("\n"),
    },
  });
  return dir;
}

// -----------------------------------------------------------------------
// Lemon Squeezy (payments/lemonsqueezy-webhook-flow) — fixtureDirect below
// deliberately uses the manual-HMAC shape (createHmac + timingSafeEqual +
// the "x-signature" literal, NO package import at all), per
// WebhookProviderDescriptor.manualHmacLiteral's own comment: it's the
// distinctive rule this provider needs (Lemon Squeezy's SDK has no
// dedicated verify-signature helper). The other 3 fixtures use the plain
// package-import + literal file-level-fallback shape instead, which is
// simpler to compose across multiple files/an "unused" case.
// -----------------------------------------------------------------------

/**
 * ONE file, USER-committed: hand-rolled HMAC verification (createHmac +
 * timingSafeEqual calls, co-located with the "x-signature" literal — no
 * "@lemonsqueezy/lemonsqueezy.js" import anywhere, per the manual-HMAC
 * special case) -> Prisma upsert, all inside one function -> DIRECT
 * (same-function).
 */
export function fixtureLemonSqueezyManualHmacDirect(): string {
  const dir = createRepo();
  commit(dir, {
    message: "add lemon squeezy webhook handler (manual HMAC verification)",
    authorName: USER.name,
    authorEmail: USER.email,
    files: {
      "src/webhook.ts": [
        'import { createHmac, timingSafeEqual } from "node:crypto";',
        'import { PrismaClient } from "@prisma/client";',
        "",
        "const prisma = new PrismaClient();",
        "",
        "export async function handleLemonSqueezyWebhook(req, res) {",
        '  const digest = createHmac("sha256", "xxx-EXAMPLE-xxx").update(req.rawBody).digest("hex");',
        '  const signature = req.headers["x-signature"];',
        "  const valid = timingSafeEqual(Buffer.from(digest), Buffer.from(signature));",
        '  if (!valid) return res.status(400).send("invalid signature");',
        "  await prisma.payment.upsert({",
        "    where: { id: req.body.data.id },",
        "    create: { id: req.body.data.id },",
        "    update: {},",
        "  });",
        '  res.status(200).send("ok");',
        "}",
        "",
      ].join("\n"),
    },
  });
  return dir;
}

/**
 * THREE files connected only by relative imports: src/handler.ts (package
 * import + "x-signature" literal — the weaker file-level fallback, not the
 * manual-HMAC rule) -> src/service.ts -> src/repo.ts (Prisma upsert). Same
 * 2-hop shape as fixtureLayeredPattern -> INFERRED.
 */
export function fixtureLemonSqueezyLayered(): string {
  const dir = createRepo();
  commit(dir, {
    message: "add layered lemon squeezy webhook handler (handler -> service -> repo)",
    authorName: USER.name,
    authorEmail: USER.email,
    files: {
      "src/handler.ts": [
        'import { lemonSqueezySetup } from "@lemonsqueezy/lemonsqueezy.js";',
        'import { persistEvent } from "./service.js";',
        "",
        "export async function handleLemonSqueezyWebhook(req) {",
        '  const signature = req.headers["x-signature"];',
        "  await persistEvent(req.body, signature, lemonSqueezySetup);",
        "}",
        "",
      ].join("\n"),
      "src/service.ts": [
        'import { upsertPayment } from "./repo.js";',
        "",
        "export async function persistEvent(event, signature) {",
        "  await upsertPayment(event, signature);",
        "}",
        "",
      ].join("\n"),
      "src/repo.ts": [
        'import { PrismaClient } from "@prisma/client";',
        "",
        "const prisma = new PrismaClient();",
        "",
        "export async function upsertPayment(event) {",
        "  await prisma.payment.upsert({ where: { id: event.id }, create: { id: event.id }, update: {} });",
        "}",
        "",
      ].join("\n"),
    },
  });
  return dir;
}

/**
 * USER commits a file that ONLY imports "@lemonsqueezy/lemonsqueezy.js" —
 * no manual-HMAC shape, no signature literal anywhere — alongside an
 * unrelated, fully connected Stripe pattern in the same commit. Same "prove
 * the ownAnchors fix" shape as fixturePaypalUnused.
 */
export function fixtureLemonSqueezyUnused(): string {
  const dir = createRepo();
  commit(dir, {
    message: "add unused lemon squeezy import alongside an unrelated stripe handler",
    authorName: USER.name,
    authorEmail: USER.email,
    files: {
      "src/lemonsqueezy-client.ts": [
        'import { lemonSqueezySetup } from "@lemonsqueezy/lemonsqueezy.js";',
        "",
        "export const setup = lemonSqueezySetup;",
        "",
      ].join("\n"),
      "src/stripe-webhook.ts": stripeNoiseFileContent(),
    },
  });
  return dir;
}

/**
 * The exact same connected Lemon Squeezy pattern (manual-HMAC variant) as
 * fixtureLemonSqueezyManualHmacDirect's src/webhook.ts, but committed by
 * OTHER — not USER. Classifies DIRECT overall, but unattributed and
 * unclaimed for USER.
 */
export function fixtureLemonSqueezyOtherAuthor(): string {
  const dir = createRepo();
  commit(dir, {
    message: "add lemon squeezy webhook handler (manual HMAC verification)",
    authorName: OTHER.name,
    authorEmail: OTHER.email,
    files: {
      "src/webhook.ts": [
        'import { createHmac, timingSafeEqual } from "node:crypto";',
        'import { PrismaClient } from "@prisma/client";',
        "",
        "const prisma = new PrismaClient();",
        "",
        "export async function handleLemonSqueezyWebhook(req, res) {",
        '  const digest = createHmac("sha256", "xxx-EXAMPLE-xxx").update(req.rawBody).digest("hex");',
        '  const signature = req.headers["x-signature"];',
        "  const valid = timingSafeEqual(Buffer.from(digest), Buffer.from(signature));",
        '  if (!valid) return res.status(400).send("invalid signature");',
        "  await prisma.payment.upsert({",
        "    where: { id: req.body.data.id },",
        "    create: { id: req.body.data.id },",
        "    update: {},",
        "  });",
        '  res.status(200).send("ok");',
        "}",
        "",
      ].join("\n"),
    },
  });
  commit(dir, {
    message: "add unrelated util",
    authorName: USER.name,
    authorEmail: USER.email,
    files: {
      "src/util.ts": ["export function noop() {", "  return null;", "}", ""].join("\n"),
    },
  });
  return dir;
}

// -----------------------------------------------------------------------
// Paddle (payments/paddle-webhook-flow)
// -----------------------------------------------------------------------

/**
 * ONE file, USER-committed: `paddle.webhooks.unmarshal(...)` (root resolved
 * through a same-file `new Paddle(...)` binding, per resolveReceiver's rule
 * 2, to the "@paddle/paddle-node-sdk" import) -> Prisma upsert, all inside
 * one function -> DIRECT (same-function).
 */
export function fixturePaddleDirect(): string {
  const dir = createRepo();
  commit(dir, {
    message: "add paddle webhook handler",
    authorName: USER.name,
    authorEmail: USER.email,
    files: {
      "src/webhook.ts": [
        'import { Paddle } from "@paddle/paddle-node-sdk";',
        'import { PrismaClient } from "@prisma/client";',
        "",
        'const paddle = new Paddle("xxx-EXAMPLE-xxx");',
        "const prisma = new PrismaClient();",
        "",
        "export async function handlePaddleWebhook(req, res) {",
        '  const event = paddle.webhooks.unmarshal(req.rawBody, "xxx-EXAMPLE-xxx", req.headers["paddle-signature"]);',
        "  await prisma.payment.upsert({",
        "    where: { id: event.data.id },",
        "    create: { id: event.data.id },",
        "    update: {},",
        "  });",
        '  res.status(200).send("ok");',
        "}",
        "",
      ].join("\n"),
    },
  });
  return dir;
}

/**
 * THREE files connected only by relative imports: src/handler.ts (Paddle
 * unmarshal call) -> src/service.ts -> src/repo.ts (Prisma upsert). Same
 * 2-hop shape as fixtureLayeredPattern -> INFERRED.
 */
export function fixturePaddleLayered(): string {
  const dir = createRepo();
  commit(dir, {
    message: "add layered paddle webhook handler (handler -> service -> repo)",
    authorName: USER.name,
    authorEmail: USER.email,
    files: {
      "src/handler.ts": [
        'import { Paddle } from "@paddle/paddle-node-sdk";',
        'import { persistEvent } from "./service.js";',
        "",
        'const paddle = new Paddle("xxx-EXAMPLE-xxx");',
        "",
        "export async function handlePaddleWebhook(req) {",
        '  const event = paddle.webhooks.unmarshal(req.rawBody, "xxx-EXAMPLE-xxx", req.headers["paddle-signature"]);',
        "  await persistEvent(event);",
        "}",
        "",
      ].join("\n"),
      "src/service.ts": [
        'import { upsertPayment } from "./repo.js";',
        "",
        "export async function persistEvent(event) {",
        "  await upsertPayment(event);",
        "}",
        "",
      ].join("\n"),
      "src/repo.ts": [
        'import { PrismaClient } from "@prisma/client";',
        "",
        "const prisma = new PrismaClient();",
        "",
        "export async function upsertPayment(event) {",
        "  await prisma.payment.upsert({ where: { id: event.data.id }, create: { id: event.data.id }, update: {} });",
        "}",
        "",
      ].join("\n"),
    },
  });
  return dir;
}

/**
 * USER commits a file that ONLY constructs a Paddle client (`new
 * Paddle(...)`) — never followed by a `.webhooks.unmarshal(...)` call, the
 * same documented "construction alone produces no hit" gap
 * WebhookProviderDescriptor.creationChainSuffixes' own comment describes for
 * Mercado Pago — alongside an unrelated, fully connected Stripe pattern in
 * the same commit. Same "prove the ownAnchors fix" shape as
 * fixturePaypalUnused.
 */
export function fixturePaddleUnused(): string {
  const dir = createRepo();
  commit(dir, {
    message: "add unused paddle client alongside an unrelated stripe handler",
    authorName: USER.name,
    authorEmail: USER.email,
    files: {
      "src/paddle-client.ts": [
        'import { Paddle } from "@paddle/paddle-node-sdk";',
        "",
        'export const paddle = new Paddle("xxx-EXAMPLE-xxx");',
        "",
      ].join("\n"),
      "src/stripe-webhook.ts": stripeNoiseFileContent(),
    },
  });
  return dir;
}

/**
 * The exact same connected Paddle pattern as fixturePaddleDirect's
 * src/webhook.ts, but committed by OTHER — not USER. Classifies DIRECT
 * overall, but unattributed and unclaimed for USER.
 */
export function fixturePaddleOtherAuthor(): string {
  const dir = createRepo();
  commit(dir, {
    message: "add paddle webhook handler",
    authorName: OTHER.name,
    authorEmail: OTHER.email,
    files: {
      "src/webhook.ts": [
        'import { Paddle } from "@paddle/paddle-node-sdk";',
        'import { PrismaClient } from "@prisma/client";',
        "",
        'const paddle = new Paddle("xxx-EXAMPLE-xxx");',
        "const prisma = new PrismaClient();",
        "",
        "export async function handlePaddleWebhook(req, res) {",
        '  const event = paddle.webhooks.unmarshal(req.rawBody, "xxx-EXAMPLE-xxx", req.headers["paddle-signature"]);',
        "  await prisma.payment.upsert({",
        "    where: { id: event.data.id },",
        "    create: { id: event.data.id },",
        "    update: {},",
        "  });",
        '  res.status(200).send("ok");',
        "}",
        "",
      ].join("\n"),
    },
  });
  commit(dir, {
    message: "add unrelated util",
    authorName: USER.name,
    authorEmail: USER.email,
    files: {
      "src/util.ts": ["export function noop() {", "  return null;", "}", ""].join("\n"),
    },
  });
  return dir;
}

// -----------------------------------------------------------------------
// RevenueCat / IAP (payments/iap-subscription-flow) — its own 3-anchor
// shape (configure / purchase / entitlement-gate), no webhook node at all.
// The fixtures below use a CALL-shaped entitlement check
// (`customerInfo.entitlements.get(...)`) rather than the more idiomatic
// bare `customerInfo.entitlements.active['pro']` access — both are
// recognized by iapEntitlementGateHits (see its own comment in anchors.ts),
// this is just a fixture-authoring choice, not a gap.
// -----------------------------------------------------------------------

/**
 * ONE file, USER-committed: Purchases.configure(...) -> Purchases
 * .purchasePackage(...) -> a CALL-shaped entitlement gate, all inside one
 * function -> DIRECT (same-function).
 */
export function fixtureIapDirect(): string {
  const dir = createRepo();
  commit(dir, {
    message: "add in-app-purchase subscription flow",
    authorName: USER.name,
    authorEmail: USER.email,
    files: {
      "src/purchases.ts": [
        'import Purchases from "react-native-purchases";',
        "",
        "export async function setupAndPurchase(offering) {",
        '  Purchases.configure({ apiKey: "xxx-EXAMPLE-xxx" });',
        "  const { customerInfo } = await Purchases.purchasePackage(offering.availablePackages[0]);",
        "  // NOTE: using a CALL-shaped entitlement check here; the more idiomatic",
        "  // bare access (`customerInfo.entitlements.active['pro']`) is recognized",
        "  // too — see iapEntitlementGateHits' own comment in anchors.ts.",
        '  const isPro = customerInfo.entitlements.get("pro");',
        '  if (!isPro) throw new Error("not entitled");',
        "  return customerInfo;",
        "}",
        "",
      ].join("\n"),
    },
  });
  return dir;
}

/**
 * THREE files connected only by relative imports: src/setup.ts (configure)
 * -> src/purchase.ts (purchasePackage) -> src/gate.ts (the CALL-shaped
 * entitlement gate). Same 2-hop shape as fixtureLayeredPattern -> INFERRED.
 */
export function fixtureIapLayered(): string {
  const dir = createRepo();
  commit(dir, {
    message: "add layered in-app-purchase flow (setup -> purchase -> gate)",
    authorName: USER.name,
    authorEmail: USER.email,
    files: {
      "src/setup.ts": [
        'import Purchases from "react-native-purchases";',
        'import { doPurchase } from "./purchase.js";',
        "",
        "export async function setupAndBuy(offering) {",
        '  Purchases.configure({ apiKey: "xxx-EXAMPLE-xxx" });',
        "  await doPurchase(offering);",
        "}",
        "",
      ].join("\n"),
      "src/purchase.ts": [
        'import Purchases from "react-native-purchases";',
        'import { checkEntitlement } from "./gate.js";',
        "",
        "export async function doPurchase(offering) {",
        "  const { customerInfo } = await Purchases.purchasePackage(offering.availablePackages[0]);",
        "  await checkEntitlement(customerInfo);",
        "}",
        "",
      ].join("\n"),
      "src/gate.ts": [
        "// See fixtureIapDirect's own comment: a CALL-shaped entitlement check,",
        "// just a fixture-authoring choice — see iapEntitlementGateHits' own",
        "// comment in anchors.ts for what shapes it recognizes.",
        "export async function checkEntitlement(customerInfo) {",
        '  const isPro = customerInfo.entitlements.get("pro");',
        '  if (!isPro) throw new Error("not entitled");',
        "  return isPro;",
        "}",
        "",
      ].join("\n"),
    },
  });
  return dir;
}

/**
 * USER commits a file that ONLY imports "react-native-purchases" — no
 * configure/purchase/entitlement call anywhere — alongside an unrelated,
 * fully connected Stripe pattern in the same commit. Same "prove the
 * ownAnchors fix" shape as fixturePaypalUnused (here, none of Stripe's
 * webhook-verification/db-write/idempotency-guard anchors are even part of
 * "iap-flow"'s own anchorKinds at all, so under the pre-fix behavior — which
 * carried the WHOLE cross-pattern anchor pool — every one of them would have
 * leaked into this finding).
 */
export function fixtureIapUnused(): string {
  const dir = createRepo();
  commit(dir, {
    message: "add unused react-native-purchases import alongside an unrelated stripe handler",
    authorName: USER.name,
    authorEmail: USER.email,
    files: {
      "src/purchases-client.ts": ['import Purchases from "react-native-purchases";', "", "export const purchases = Purchases;", ""].join(
        "\n"
      ),
      "src/stripe-webhook.ts": stripeNoiseFileContent(),
    },
  });
  return dir;
}

/**
 * The exact same connected IAP pattern as fixtureIapDirect's
 * src/purchases.ts, but committed by OTHER — not USER. Classifies DIRECT
 * overall, but unattributed and unclaimed for USER.
 */
export function fixtureIapOtherAuthor(): string {
  const dir = createRepo();
  commit(dir, {
    message: "add in-app-purchase subscription flow",
    authorName: OTHER.name,
    authorEmail: OTHER.email,
    files: {
      "src/purchases.ts": [
        'import Purchases from "react-native-purchases";',
        "",
        "export async function setupAndPurchase(offering) {",
        '  Purchases.configure({ apiKey: "xxx-EXAMPLE-xxx" });',
        "  const { customerInfo } = await Purchases.purchasePackage(offering.availablePackages[0]);",
        '  const isPro = customerInfo.entitlements.get("pro");',
        '  if (!isPro) throw new Error("not entitled");',
        "  return customerInfo;",
        "}",
        "",
      ].join("\n"),
    },
  });
  commit(dir, {
    message: "add unrelated util",
    authorName: USER.name,
    authorEmail: USER.email,
    files: {
      "src/util.ts": ["export function noop() {", "  return null;", "}", ""].join("\n"),
    },
  });
  return dir;
}

// -----------------------------------------------------------------------
// Auth flows (issue #5) — three patterns, each with the 4 standard cases
// (connected same-file DIRECT / cross-file INFERRED / import-without-use
// AMBIGUOUS / non-attributed), plus the negative fixtures the issue's "#28
// discipline" calls for at the bottom of this section.
//
// Every fixture below uses SUPABASE AUTH or PLAIN JWT rather than NextAuth,
// deliberately: NextAuth exposes no code-exchange call site at all (it does
// the exchange inside its own route handler — see AUTH_LIBRARIES' own
// comment in anchors.ts), so it cannot complete the oauth-flow triad, and
// its `auth()` helper resolves through a LOCAL re-export that receiver
// resolution can't place. Supabase is the one library in the table with a
// call site for every auth anchor kind, which makes it the only honest
// choice for a fixture asserting a full triad.
//
// The Supabase client binding shape used throughout — `const supabase =
// createClient(...)` — resolves via resolveReceiver's RULE 2: `supabase` is a
// same-file "call"-kind binding whose own chain root (`createClient`) is
// directly an import of "@supabase/supabase-js". The spliced chain is
// therefore ["auth", ...], which is exactly what AUTH_LIBRARIES' Supabase
// suffixes match against.
// -----------------------------------------------------------------------

const FAKE_SUPABASE_URL = "https://xxx-EXAMPLE-xxx.supabase.co";
const FAKE_SUPABASE_KEY = "xxx-EXAMPLE-xxx";
const FAKE_JWT_SECRET = "xxx-EXAMPLE-xxx";

function supabaseClientLines(): string[] {
  return [
    'import { createClient } from "@supabase/supabase-js";',
    "",
    `const supabase = createClient("${FAKE_SUPABASE_URL}", "${FAKE_SUPABASE_KEY}");`,
  ];
}

// -----------------------------------------------------------------------
// auth/session-flow — credential-verification / session-issuance / route-guard
// -----------------------------------------------------------------------

/**
 * ONE file, USER-committed, all three anchors inside one function ->
 * DIRECT (same-function):
 *   - `supabase.auth.signInWithPassword(...)` -> session-issuance
 *   - `supabase.auth.getUser()` -> credential-verification (real
 *     verification: getUser re-validates the token against the auth server
 *     rather than trusting its claims — the issue's honesty rule)
 *   - `res.status(401)` -> route-guard (the 401 is the whole signal; see
 *     ParsedCall.numberArgs and authGuardHits' own comments)
 */
export function fixtureAuthSessionDirect(): string {
  const dir = createRepo();
  commit(dir, {
    message: "add supabase session auth handler",
    authorName: USER.name,
    authorEmail: USER.email,
    files: {
      "src/session.ts": [
        ...supabaseClientLines(),
        "",
        "export async function signInAndGuard(req, res) {",
        "  await supabase.auth.signInWithPassword({ email: req.body.email, password: req.body.password });",
        "  const { data } = await supabase.auth.getUser();",
        '  if (!data.user) return res.status(401).send("unauthorized");',
        '  return res.status(200).send("ok");',
        "}",
        "",
      ].join("\n"),
    },
  });
  return dir;
}

/**
 * THREE files connected only by relative imports: src/handler.ts
 * (credential-verification) -> src/issue.ts (session-issuance) ->
 * src/guard.ts (route-guard). Max pairwise import distance is 2 hops, within
 * the <=3 bound -> INFERRED.
 */
export function fixtureAuthSessionLayered(): string {
  const dir = createRepo();
  commit(dir, {
    message: "add layered session auth (handler -> issue -> guard)",
    authorName: USER.name,
    authorEmail: USER.email,
    files: {
      "src/handler.ts": [
        ...supabaseClientLines(),
        'import { issueSession } from "./issue.js";',
        "",
        "export async function requireUser(req) {",
        "  const { data } = await supabase.auth.getUser();",
        "  return issueSession(data.user);",
        "}",
        "",
      ].join("\n"),
      "src/issue.ts": [
        ...supabaseClientLines(),
        'import { denyAccess } from "./guard.js";',
        "",
        "export async function issueSession(user) {",
        "  if (!user) return denyAccess;",
        "  return supabase.auth.setSession({ access_token: user.token, refresh_token: user.refresh });",
        "}",
        "",
      ].join("\n"),
      "src/guard.ts": ["export function denyAccess(res) {", '  return res.status(403).send("forbidden");', "}", ""].join("\n"),
    },
  });
  return dir;
}

/**
 * USER commits a file that ONLY imports "@supabase/supabase-js" — no auth
 * call of any kind — alongside an unrelated, fully connected Stripe pattern
 * in the same commit. auth/session-flow classifies AMBIGUOUS (package
 * present, never wired); the Stripe pattern classifies DIRECT. Same
 * "ownAnchors must not leak across patterns" proof as fixturePaypalUnused —
 * and a stronger one here, since none of Stripe's anchor KINDS are even
 * members of any auth pattern's anchorKinds.
 *
 * Note the Stripe noise file's status calls are `res.status(200)`, never
 * 401/403, so it contributes no route-guard/guard-response anchors of its
 * own — the auth findings' anchor sets stay clean for a reason the fixture
 * controls, not by luck.
 */
export function fixtureAuthSessionUnused(): string {
  const dir = createRepo();
  commit(dir, {
    message: "add unused supabase auth client alongside an unrelated stripe handler",
    authorName: USER.name,
    authorEmail: USER.email,
    files: {
      "src/auth-client.ts": [...supabaseClientLines(), "", "export const client = supabase;", ""].join("\n"),
      "src/stripe-webhook.ts": stripeNoiseFileContent(),
    },
  });
  return dir;
}

/**
 * The exact same connected session pattern as fixtureAuthSessionDirect, but
 * committed by OTHER — not USER. Classifies DIRECT overall, unattributed and
 * unclaimed for USER.
 */
export function fixtureAuthSessionOtherAuthor(): string {
  const dir = createRepo();
  commit(dir, {
    message: "add supabase session auth handler",
    authorName: OTHER.name,
    authorEmail: OTHER.email,
    files: {
      "src/session.ts": [
        ...supabaseClientLines(),
        "",
        "export async function signInAndGuard(req, res) {",
        "  await supabase.auth.signInWithPassword({ email: req.body.email, password: req.body.password });",
        "  const { data } = await supabase.auth.getUser();",
        '  if (!data.user) return res.status(401).send("unauthorized");',
        '  return res.status(200).send("ok");',
        "}",
        "",
      ].join("\n"),
    },
  });
  commit(dir, {
    message: "add unrelated util",
    authorName: USER.name,
    authorEmail: USER.email,
    files: {
      "src/util.ts": ["export function noop() {", "  return null;", "}", ""].join("\n"),
    },
  });
  return dir;
}

// -----------------------------------------------------------------------
// auth/oauth-flow — authorize-redirect / code-exchange / session-issuance
// -----------------------------------------------------------------------

/**
 * ONE file, USER-committed, all three anchors in one function -> DIRECT
 * (same-function). The authorize-redirect + code-exchange PAIR is what the
 * issue says separates "wired OAuth" from "pasted a login button", so both
 * appear here as real calls.
 */
export function fixtureAuthOauthDirect(): string {
  const dir = createRepo();
  commit(dir, {
    message: "add supabase oauth login flow",
    authorName: USER.name,
    authorEmail: USER.email,
    files: {
      "src/oauth.ts": [
        ...supabaseClientLines(),
        "",
        "export async function loginWithGithub(req, res) {",
        '  await supabase.auth.signInWithOAuth({ provider: "github" });',
        "  const { data } = await supabase.auth.exchangeCodeForSession(req.query.code);",
        "  await supabase.auth.setSession(data.session);",
        '  return res.redirect("/dashboard");',
        "}",
        "",
      ].join("\n"),
    },
  });
  return dir;
}

/**
 * THREE files connected only by relative imports: src/login.ts
 * (authorize-redirect) -> src/callback.ts (code-exchange) -> src/session.ts
 * (session-issuance). 2 hops -> INFERRED.
 */
export function fixtureAuthOauthLayered(): string {
  const dir = createRepo();
  commit(dir, {
    message: "add layered oauth flow (login -> callback -> session)",
    authorName: USER.name,
    authorEmail: USER.email,
    files: {
      "src/login.ts": [
        ...supabaseClientLines(),
        'import { handleCallback } from "./callback.js";',
        "",
        "export async function startLogin() {",
        '  await supabase.auth.signInWithOAuth({ provider: "github" });',
        "  return handleCallback;",
        "}",
        "",
      ].join("\n"),
      "src/callback.ts": [
        ...supabaseClientLines(),
        'import { persistSession } from "./session.js";',
        "",
        "export async function handleCallback(code) {",
        "  const { data } = await supabase.auth.exchangeCodeForSession(code);",
        "  return persistSession(data.session);",
        "}",
        "",
      ].join("\n"),
      "src/session.ts": [
        ...supabaseClientLines(),
        "",
        "export async function persistSession(session) {",
        "  return supabase.auth.setSession(session);",
        "}",
        "",
      ].join("\n"),
    },
  });
  return dir;
}

/**
 * USER commits a file that imports Supabase and renders a login BUTTON —
 * no signInWithOAuth, no exchange, no session call. The issue's "pasted a
 * login button" case: the package is present so auth/oauth-flow classifies
 * AMBIGUOUS and never claims.
 */
export function fixtureAuthOauthUnused(): string {
  const dir = createRepo();
  commit(dir, {
    message: "add oauth login button alongside an unrelated stripe handler",
    authorName: USER.name,
    authorEmail: USER.email,
    files: {
      "src/LoginButton.tsx": [
        ...supabaseClientLines(),
        "",
        "export function LoginButton() {",
        '  return <button className="login">Sign in with GitHub</button>;',
        "}",
        "",
      ].join("\n"),
      "src/stripe-webhook.ts": stripeNoiseFileContent(),
    },
  });
  return dir;
}

/**
 * The exact same connected OAuth pattern as fixtureAuthOauthDirect, but
 * committed by OTHER — not USER. DIRECT overall, unattributed for USER.
 */
export function fixtureAuthOauthOtherAuthor(): string {
  const dir = createRepo();
  commit(dir, {
    message: "add supabase oauth login flow",
    authorName: OTHER.name,
    authorEmail: OTHER.email,
    files: {
      "src/oauth.ts": [
        ...supabaseClientLines(),
        "",
        "export async function loginWithGithub(req, res) {",
        '  await supabase.auth.signInWithOAuth({ provider: "github" });',
        "  const { data } = await supabase.auth.exchangeCodeForSession(req.query.code);",
        "  await supabase.auth.setSession(data.session);",
        '  return res.redirect("/dashboard");',
        "}",
        "",
      ].join("\n"),
    },
  });
  commit(dir, {
    message: "add unrelated util",
    authorName: USER.name,
    authorEmail: USER.email,
    files: {
      "src/util.ts": ["export function noop() {", "  return null;", "}", ""].join("\n"),
    },
  });
  return dir;
}

// -----------------------------------------------------------------------
// auth/jwt-refresh-flow — token-verification / refresh-rotation /
// guard-response. This is the one auth pattern with an optionalAnchorKinds
// cap (on refresh-rotation), so it needs 5 fixtures rather than 4: the
// cap-engaged case and the cap-lifted case, plus the usual layered/unused/
// other-author trio. Same reason fixtureMercadoPago* needs 5.
//
// NOTE the refresh marker is read as `req.body["refresh_token"]`, an ELEMENT
// ACCESS with a string literal — not `req.body.refresh_token`, a property
// access. Only the former puts "refresh_token" into ParsedFile.literals,
// which is what refreshRotationHits requires. This mirrors the existing
// `req.headers["stripe-signature"]` convention exactly, and is a real
// constraint of the rule, not a fixture stylistic choice.
// -----------------------------------------------------------------------

/**
 * ONE file, USER-committed, full triad in one function -> DIRECT
 * (same-function):
 *   - `jwt.verify(...)` -> token-verification (NOT jwt.decode — the
 *     canonical instance of the issue's honesty rule)
 *   - `jwt.sign(...)` co-located with that verify, in a file carrying the
 *     "refresh_token" marker literal -> refresh-rotation
 *   - `res.status(401)` -> guard-response
 */
export function fixtureAuthJwtRefreshDirect(): string {
  const dir = createRepo();
  commit(dir, {
    message: "add jwt refresh endpoint",
    authorName: USER.name,
    authorEmail: USER.email,
    files: {
      "src/refresh.ts": [
        'import jwt from "jsonwebtoken";',
        "",
        "export function refreshAccessToken(req, res) {",
        `  const payload = jwt.verify(req.body["refresh_token"], "${FAKE_JWT_SECRET}");`,
        '  if (!payload) return res.status(401).send("invalid refresh token");',
        `  const token = jwt.sign({ sub: payload.sub }, "${FAKE_JWT_SECRET}");`,
        "  return res.status(200).json({ token });",
        "}",
        "",
      ].join("\n"),
    },
  });
  return dir;
}

/**
 * The cap-LIFTED case: the same triad as fixtureAuthJwtRefreshDirect PLUS an
 * explicit invalidation of the old refresh token
 * (`prisma.session.deleteMany(...)`, whose last chain segment is in
 * INVALIDATION_SEGMENTS, in a file carrying the refresh marker literal).
 * refresh-invalidation is therefore present, the optionalAnchorKinds cap
 * does not engage, and this reaches DIRECT.
 *
 * Note `deleteMany` is NOT one of PRISMA_WRITE_VERBS, so this contributes no
 * db-write anchor and no payments pattern is disturbed.
 */
export function fixtureAuthJwtRefreshWithInvalidation(): string {
  const dir = createRepo();
  commit(dir, {
    message: "add jwt refresh endpoint that revokes the old token",
    authorName: USER.name,
    authorEmail: USER.email,
    files: {
      "src/refresh.ts": [
        'import jwt from "jsonwebtoken";',
        'import { PrismaClient } from "@prisma/client";',
        "",
        "const prisma = new PrismaClient();",
        "",
        "export async function refreshAccessToken(req, res) {",
        `  const payload = jwt.verify(req.body["refresh_token"], "${FAKE_JWT_SECRET}");`,
        '  if (!payload) return res.status(401).send("invalid refresh token");',
        `  const token = jwt.sign({ sub: payload.sub }, "${FAKE_JWT_SECRET}");`,
        '  await prisma.session.deleteMany({ where: { token: req.body["refresh_token"] } });',
        "  return res.status(200).json({ token });",
        "}",
        "",
      ].join("\n"),
    },
  });
  return dir;
}

/**
 * Verification and guard only — NO token issuance anywhere, so
 * refresh-rotation (a REQUIRED member of this triad) is absent and the
 * pattern cannot classify at all. It falls through to the shared AMBIGUOUS
 * gate on package presence and never claims.
 *
 * This fixture is the regression guard for the over-claim that an earlier
 * draft of this milestone shipped: with refresh-rotation treated as OPTIONAL,
 * this exact shape — verify a token, deny with 401 — produced a CLAIMED
 * jwt-refresh-flow finding on code that refreshes nothing. See
 * refreshRotationHits' own comment in anchors.ts.
 */
export function fixtureAuthJwtRefreshNoRotation(): string {
  const dir = createRepo();
  commit(dir, {
    message: "add jwt verification endpoint with no rotation anywhere",
    authorName: USER.name,
    authorEmail: USER.email,
    files: {
      "src/verify.ts": [
        'import jwt from "jsonwebtoken";',
        "",
        "export function requireValidToken(req, res, next) {",
        `  const payload = jwt.verify(req.headers["authorization"], "${FAKE_JWT_SECRET}");`,
        '  if (!payload) return res.status(401).send("unauthorized");',
        "  return next();",
        "}",
        "",
      ].join("\n"),
    },
  });
  return dir;
}

/**
 * THREE files connected by relative imports. token-verification AND
 * refresh-rotation necessarily share a file here — refreshRotationHits
 * requires a verify call in the SAME enclosing scope — so the cross-file
 * split is (verify + rotate) in src/service.ts vs. guard-response in
 * src/guard.ts, 1 import hop apart. Same-function and same-file triple
 * searches both fail; the cross-file search succeeds -> INFERRED.
 */
export function fixtureAuthJwtRefreshLayered(): string {
  const dir = createRepo();
  commit(dir, {
    message: "add layered jwt refresh (handler -> service -> guard)",
    authorName: USER.name,
    authorEmail: USER.email,
    files: {
      "src/handler.ts": [
        'import { rotateToken } from "./service.js";',
        "",
        "export function handleRefresh(req, res) {",
        "  return rotateToken(req, res);",
        "}",
        "",
      ].join("\n"),
      "src/service.ts": [
        'import jwt from "jsonwebtoken";',
        'import { denyAccess } from "./guard.js";',
        "",
        "export function rotateToken(req, res) {",
        `  const payload = jwt.verify(req.body["refresh_token"], "${FAKE_JWT_SECRET}");`,
        "  if (!payload) return denyAccess(res);",
        `  return jwt.sign({ sub: payload.sub }, "${FAKE_JWT_SECRET}");`,
        "}",
        "",
      ].join("\n"),
      "src/guard.ts": ["export function denyAccess(res) {", '  return res.status(401).send("unauthorized");', "}", ""].join("\n"),
    },
  });
  return dir;
}

/**
 * USER commits a file that ONLY imports "jsonwebtoken" — no verify, no
 * sign — alongside an unrelated, fully connected Stripe pattern. AMBIGUOUS,
 * never claimed.
 */
export function fixtureAuthJwtRefreshUnused(): string {
  const dir = createRepo();
  commit(dir, {
    message: "add unused jsonwebtoken import alongside an unrelated stripe handler",
    authorName: USER.name,
    authorEmail: USER.email,
    files: {
      "src/jwt-client.ts": ['import jwt from "jsonwebtoken";', "", "export const signer = jwt;", ""].join("\n"),
      "src/stripe-webhook.ts": stripeNoiseFileContent(),
    },
  });
  return dir;
}

/**
 * The exact same connected refresh pattern as fixtureAuthJwtRefreshDirect,
 * but committed by OTHER — not USER. DIRECT overall, unattributed for USER.
 */
export function fixtureAuthJwtRefreshOtherAuthor(): string {
  const dir = createRepo();
  commit(dir, {
    message: "add jwt refresh endpoint",
    authorName: OTHER.name,
    authorEmail: OTHER.email,
    files: {
      "src/refresh.ts": [
        'import jwt from "jsonwebtoken";',
        "",
        "export function refreshAccessToken(req, res) {",
        `  const payload = jwt.verify(req.body["refresh_token"], "${FAKE_JWT_SECRET}");`,
        '  if (!payload) return res.status(401).send("invalid refresh token");',
        `  const token = jwt.sign({ sub: payload.sub }, "${FAKE_JWT_SECRET}");`,
        "  return res.status(200).json({ token });",
        "}",
        "",
      ].join("\n"),
    },
  });
  commit(dir, {
    message: "add unrelated util",
    authorName: USER.name,
    authorEmail: USER.email,
    files: {
      "src/util.ts": ["export function noop() {", "  return null;", "}", ""].join("\n"),
    },
  });
  return dir;
}

// -----------------------------------------------------------------------
// NEGATIVE fixtures — the issue's "#28 discipline": one per signal, each
// asserting an ABSENCE. These are what make "built real auth" a claim worth
// defending.
// -----------------------------------------------------------------------

/**
 * THE canonical negative case, named in the issue verbatim: a repo using
 * `jwt.decode` ONLY. `decode` parses a token's claims without checking its
 * signature, so it must never produce a token-verification anchor —
 * AUTH_LIBRARIES lists it under `decodeOnlyChainSuffixes` precisely to make
 * that intent assertable rather than implicit in an absence.
 *
 * A NOTE ON THE ISSUE'S WORDING (worth settling upstream): the issue asks
 * for "zero auth/jwt-refresh-flow findings". Under the existing machinery
 * that is not literally reachable — importing a tracked package always
 * yields an AMBIGUOUS finding via inferStructuralSkills' step 3, exactly as
 * fixtureStripeUnused already does for payments. The defensible assertion,
 * and the one detection.test.ts makes, is: zero token-verification anchors
 * and zero CLAIMED findings. Ambiguous never claims, which is the property
 * this negative fixture actually exists to protect.
 */
export function fixtureAuthJwtDecodeOnly(): string {
  const dir = createRepo();
  commit(dir, {
    message: "add jwt claims reader (decode only, no verification)",
    authorName: USER.name,
    authorEmail: USER.email,
    files: {
      "src/claims.ts": [
        'import jwt from "jsonwebtoken";',
        "",
        "export function readClaims(req, res) {",
        '  const payload = jwt.decode(req.headers["authorization"]);',
        '  if (!payload) return res.status(401).send("no claims");',
        "  return res.status(200).json(payload);",
        "}",
        "",
      ].join("\n"),
    },
  });
  return dir;
}

/**
 * The issue's other named negative: "Rendering a login form does not" count
 * as verification. No auth package import anywhere, no verification call —
 * just a form. Produces NO auth finding at all (inferStructuralSkills' step
 * 4: no package presence, no primary anchor), not even an ambiguous one.
 */
export function fixtureAuthLoginFormOnly(): string {
  const dir = createRepo();
  commit(dir, {
    message: "add login form component",
    authorName: USER.name,
    authorEmail: USER.email,
    files: {
      "src/LoginForm.tsx": [
        "export function LoginForm() {",
        "  return (",
        '    <form method="post" action="/login">',
        '      <input name="email" />',
        '      <input name="password" type="password" />',
        "      <button>Sign in</button>",
        "    </form>",
        "  );",
        "}",
        "",
      ].join("\n"),
    },
  });
  return dir;
}

/**
 * CROSS-LIBRARY CONTAMINATION regression record (jpbelmo's review question on
 * PR #54).
 *
 * Reproduced the pre-fix bug: three unrelated auth libraries in one import
 * chain could satisfy a triad no single library completes — both
 * auth/oauth-flow and auth/session-flow CLAIMED. Same-library scoping in
 * inferStructuralSkills fixed it; detection.test.ts asserts the fix.
 *
 * Three files, three DIFFERENT auth libraries, wired into one import chain
 * (login -> callback -> middleware), where NO SINGLE LIBRARY completes any
 * triad on its own:
 *
 *   src/login.ts       next-auth/react        signIn(...)
 *                        -> authorize-redirect + session-issuance
 *   src/callback.ts    @supabase/supabase-js  exchangeCodeForSession(...)
 *                        -> code-exchange
 *   src/middleware.ts  jsonwebtoken           jwt.verify(...) + res.status(401)
 *                        -> credential-verification + token-verification,
 *                           plus the (library-agnostic) guard anchors
 *
 * Per library, every triad is INCOMPLETE:
 *   - NextAuth  has authorize-redirect + session-issuance but no code-exchange
 *               -> oauth-flow incomplete; and no credential-verification
 *               -> session-flow incomplete.
 *   - Supabase  has code-exchange only -> both incomplete.
 *   - plain JWT has credential-verification (and the guards) but no
 *               session-issuance -> session-flow incomplete.
 *
 * Before libraryId scoping, auth hits carried no library identity (unlike
 * webhook hits' providerSlug), kind-only filtering, and path/function triple
 * search — so anchors from three systems could connect and CLAIM. After the
 * fix, neither slug may claim here.
 *
 * Deliberately contains no Stripe/Prisma, so no payments pattern fires and
 * the assertion stays about auth alone.
 */
export function fixtureAuthMixedLibraries(): string {
  const dir = createRepo();
  commit(dir, {
    message: "add mixed-stack auth: nextauth login, supabase callback, jwt middleware",
    authorName: USER.name,
    authorEmail: USER.email,
    files: {
      "src/login.ts": [
        'import { signIn } from "next-auth/react";',
        'import { handleCallback } from "./callback.js";',
        "",
        "export async function startLogin() {",
        '  await signIn("github");',
        "  return handleCallback;",
        "}",
        "",
      ].join("\n"),
      "src/callback.ts": [
        ...supabaseClientLines(),
        'import { requireValidToken } from "./middleware.js";',
        "",
        "export async function handleCallback(code) {",
        "  const { data } = await supabase.auth.exchangeCodeForSession(code);",
        "  return requireValidToken(data);",
        "}",
        "",
      ].join("\n"),
      "src/middleware.ts": [
        'import jwt from "jsonwebtoken";',
        "",
        "export function requireValidToken(req, res) {",
        `  const payload = jwt.verify(req.headers["authorization"], "${FAKE_JWT_SECRET}");`,
        '  if (!payload) return res.status(401).send("unauthorized");',
        "  return payload;",
        "}",
        "",
      ].join("\n"),
    },
  });
  return dir;
}

/**
 * Guard-shaped code with NO auth library anywhere: a plain rate-limit
 * middleware that returns 401. authGuardHits is deliberately ungated on any
 * auth import (same posture as db-write), so this DOES produce route-guard
 * and guard-response anchors — and must still produce NO auth finding of any
 * kind, because every auth pattern's PRIMARY anchor is a verification kind
 * requiring one of AUTH_LIBRARIES' packages.
 *
 * This is the direct test of the claim authGuardHits' own comment makes: the
 * guard anchors can never manufacture a finding by themselves.
 */
export function fixtureAuthGuardWithoutAuthLibrary(): string {
  const dir = createRepo();
  commit(dir, {
    message: "add rate-limit middleware that 401s without any auth library",
    authorName: USER.name,
    authorEmail: USER.email,
    files: {
      "src/rate-limit.ts": [
        "export function rateLimit(req, res, next) {",
        '  if (req.tooMany) return res.status(401).send("slow down");',
        "  return next();",
        "}",
        "",
      ].join("\n"),
    },
  });
  return dir;
}

/**
 * The POSITIVE case for same-library scoping, and the commonest real-world
 * shape: one library completes a flow on its own while a SECOND,
 * partially-overlapping library also lives in the repo.
 *
 * src/session.ts — Supabase completes auth/session-flow entirely in one
 * function: getUser (credential-verification) + signInWithPassword
 * (session-issuance) + res.status(401) (route-guard).
 *
 * src/social.ts — NextAuth is present but only PARTIAL: signIn contributes
 * session-issuance and authorize-redirect, never a credential-verification.
 * Deliberately NOT import-linked to session.ts; its mere presence in the
 * repo is what makes libraryIds.length > 1 and engages scoping.
 *
 * Scoping must therefore pick Supabase — coverage 3 (it or a
 * library-agnostic anchor supplies all three of session-flow's kinds)
 * against NextAuth's 2 — and auth/session-flow must still claim DIRECT.
 * This is the case fixtureAuthMixedLibraries cannot prove: that the fix
 * suppresses only the cross-library assembly, not real flows that happen to
 * share a repo with another auth library.
 */
export function fixtureAuthScopedFlowWithOverlappingLibrary(): string {
  const dir = createRepo();
  commit(dir, {
    message: "add supabase session flow alongside a partial nextauth social login",
    authorName: USER.name,
    authorEmail: USER.email,
    files: {
      "src/session.ts": [
        ...supabaseClientLines(),
        "",
        "export async function signInAndGuard(req, res) {",
        "  await supabase.auth.signInWithPassword({ email: req.body.email, password: req.body.password });",
        "  const { data } = await supabase.auth.getUser();",
        '  if (!data.user) return res.status(401).send("unauthorized");',
        '  return res.status(200).send("ok");',
        "}",
        "",
      ].join("\n"),
      "src/social.ts": [
        'import { signIn } from "next-auth/react";',
        "",
        "export async function socialLogin() {",
        '  return signIn("github");',
        "}",
        "",
      ].join("\n"),
    },
  });
  return dir;
}

/**
 * ALIASED named import: `import { signIn as login }`. Pins
 * importedNameForLocalName's preference for the EXPORTED name — the
 * descriptor table names API functions, so matching must not depend on
 * whatever local alias a file happened to choose.
 *
 * Without that preference this file would produce no NextAuth anchor at
 * all, since the local name "login" appears in no descriptor.
 */
export function fixtureAuthAliasedImport(): string {
  const dir = createRepo();
  commit(dir, {
    message: "add nextauth social login imported under an alias",
    authorName: USER.name,
    authorEmail: USER.email,
    files: {
      "src/social.ts": [
        'import { signIn as login } from "next-auth/react";',
        "",
        "export async function socialLogin(res) {",
        '  await login("github");',
        '  return res.status(401).send("not signed in");',
        "}",
        "",
      ].join("\n"),
    },
  });
  return dir;
}
