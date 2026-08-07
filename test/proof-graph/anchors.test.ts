import { describe, expect, it } from "vitest";
import { TscParserAdapter } from "../../src/proof-graph/parser-adapter.js";
import { buildGraph } from "../../src/proof-graph/graph.js";
import { findAnchors } from "../../src/proof-graph/anchors.js";
import type { AnchorHit, AnchorKind } from "../../src/proof-graph/anchors.js";

const adapter = new TscParserAdapter();

// Integration through the real adapter + real graph, per the milestone's
// test plan — never hand-built ParsedFile/ProofGraph values. Each test
// parses one or more synthetic sources and runs the actual
// snapshot -> parse -> graph -> findAnchors pipeline (minus the snapshot
// step itself, which is already covered by snapshot.test.ts).
function anchorsOf(files: Record<string, string>): AnchorHit[] {
  const parsed = Object.entries(files).map(([path, source]) => adapter.parse(path, source));
  const graph = buildGraph(parsed);
  return findAnchors(graph);
}

function only(hits: AnchorHit[], kind: AnchorKind): AnchorHit[] {
  return hits.filter((h) => h.kind === kind);
}

describe("findAnchors — webhook-verification", () => {
  it("resolves stripe.webhooks.constructEvent through a 'new' binding (rule 2)", () => {
    const hits = anchorsOf({
      "a.ts": [
        'import Stripe from "stripe";',
        "function handleWebhook(req) {",
        '  const stripe = new Stripe("sk_test");',
        "  return stripe.webhooks.constructEvent(req.body, sig, secret);",
        "}",
      ].join("\n"),
    });

    const webhook = only(hits, "webhook-verification");
    expect(webhook).toHaveLength(1);
    expect(webhook[0]).toMatchObject({
      path: "a.ts",
      enclosingFunction: "handleWebhook",
      kind: "webhook-verification",
    });
    expect(webhook[0].reason).toContain("receiver resolved to import \"stripe\"");
  });

  it("resolves stripe.webhooks.constructEventAsync the same way", () => {
    const hits = anchorsOf({
      "a.ts": [
        'import Stripe from "stripe";',
        "async function handleWebhook(req) {",
        '  const stripe = new Stripe("sk_test");',
        "  return stripe.webhooks.constructEventAsync(req.body, sig, secret);",
        "}",
      ].join("\n"),
    });

    expect(only(hits, "webhook-verification")).toHaveLength(1);
  });

  it("resolves through exactly one alias hop (rule 3), per the milestone's own example", () => {
    // The literal example from the milestone: `const w = stripe.webhooks;
    // w.constructEvent(...)` — here `stripe` is DIRECTLY the import's local
    // name (rule 1), so resolving `w` needs only one alias hop.
    const hits = anchorsOf({
      "a.ts": [
        'import stripe from "stripe";',
        "const w = stripe.webhooks;",
        "function handleWebhook(req) {",
        "  return w.constructEvent(req.body, sig, secret);",
        "}",
      ].join("\n"),
    });

    const webhook = only(hits, "webhook-verification");
    expect(webhook).toHaveLength(1);
    expect(webhook[0].enclosingFunction).toBe("handleWebhook");
  });

  it("near-miss: resolves nothing when a 'new' binding and an alias hop are stacked (deeper than one hop)", () => {
    // `stripe` here is itself a same-file binding (via `new Stripe(...)`),
    // not a direct import — so `w`'s alias hop can't resolve through it.
    // Documented depth limit, not a bug (see resolveReceiver's own
    // comment).
    const hits = anchorsOf({
      "a.ts": [
        'import Stripe from "stripe";',
        'const stripe = new Stripe("sk_test");',
        "const w = stripe.webhooks;",
        "function handleWebhook(req) {",
        "  return w.constructEvent(req.body, sig, secret);",
        "}",
      ].join("\n"),
    });

    expect(only(hits, "webhook-verification")).toEqual([]);
  });

  it("near-miss: constructEvent on a root that resolves to a NON-stripe import", () => {
    const hits = anchorsOf({
      "a.ts": [
        'import Foo from "not-stripe";',
        "function handleWebhook(req) {",
        '  const stripe = new Foo("k");',
        "  return stripe.webhooks.constructEvent(req.body, sig, secret);",
        "}",
      ].join("\n"),
    });

    expect(only(hits, "webhook-verification")).toEqual([]);
  });

  it("fallback: literal 'stripe-signature' present AND file imports stripe, with no constructEvent call at all", () => {
    const hits = anchorsOf({
      "a.ts": [
        'import Stripe from "stripe";',
        "function readHeader(req) {",
        "  return req.headers['stripe-signature'];",
        "}",
      ].join("\n"),
    });

    const webhook = only(hits, "webhook-verification");
    expect(webhook).toHaveLength(1);
    expect(webhook[0].reason).toContain("weaker");
  });

  it("near-miss: 'stripe-signature' literal present but the file does NOT import stripe", () => {
    const hits = anchorsOf({
      "a.ts": "function readHeader(req) {\n  return req.headers['stripe-signature'];\n}\n",
    });

    expect(only(hits, "webhook-verification")).toEqual([]);
  });

  it("near-miss: 'stripe-signature' text only inside a comment produces no literal at all, hence no hit", () => {
    const hits = anchorsOf({
      "a.ts": [
        'import Stripe from "stripe";',
        "// reads req.headers['stripe-signature'] eventually",
        "function readHeader(req) {\n  return 1;\n}",
      ].join("\n"),
    });

    expect(only(hits, "webhook-verification")).toEqual([]);
  });
});

describe("findAnchors — db-write", () => {
  it("prisma: .create(...) on a resolved root is a db-write", () => {
    const hits = anchorsOf({
      "a.ts": [
        'import { PrismaClient } from "@prisma/client";',
        "const prisma = new PrismaClient();",
        "function handler() {",
        "  return prisma.user.create({ data: {} });",
        "}",
      ].join("\n"),
    });

    const writes = only(hits, "db-write");
    expect(writes).toHaveLength(1);
    expect(writes[0].reason).toContain('receiver resolved to import "@prisma/client"');
  });

  it("prisma: a read (findUnique) is NOT a db-write", () => {
    const hits = anchorsOf({
      "a.ts": [
        'import { PrismaClient } from "@prisma/client";',
        "const prisma = new PrismaClient();",
        "function handler() {",
        "  return prisma.user.findUnique({ where: {} });",
        "}",
      ].join("\n"),
    });

    expect(only(hits, "db-write")).toEqual([]);
  });

  it("pg: pool.query(...) with an INSERT string argument is a db-write", () => {
    const hits = anchorsOf({
      "a.ts": [
        'import { Pool } from "pg";',
        "const pool = new Pool();",
        "function handler() {",
        '  return pool.query("INSERT INTO users (id) VALUES ($1)", [1]);',
        "}",
      ].join("\n"),
    });

    expect(only(hits, "db-write")).toHaveLength(1);
  });

  it("near-miss: pg pool.query(...) with a SELECT string argument is NOT a db-write", () => {
    const hits = anchorsOf({
      "a.ts": [
        'import { Pool } from "pg";',
        "const pool = new Pool();",
        "function handler() {",
        '  return pool.query("SELECT * FROM users");',
        "}",
      ].join("\n"),
    });

    expect(only(hits, "db-write")).toEqual([]);
  });

  it("known limitation: an INSERT inside a template literal WITH substitutions is not captured", () => {
    // ParsedCall.stringArgs only captures a plain string literal or a
    // no-substitution template literal (parser-adapter.ts) — a template
    // WITH a substitution has no single static text, so this pg call's
    // stringArgs is [] and the write rule never sees "insert" at all.
    const hits = anchorsOf({
      "a.ts": [
        'import { Pool } from "pg";',
        "const pool = new Pool();",
        "function handler(id) {",
        "  return pool.query(`INSERT INTO users (id) VALUES (${id})`);",
        "}",
      ].join("\n"),
    });

    expect(only(hits, "db-write")).toEqual([]);
  });

  it("knex: .insert(...) chained off an invoked table selector is a db-write via the documented fallback", () => {
    const hits = anchorsOf({
      "a.ts": [
        'import knex from "knex";',
        "function handler() {",
        '  return knex("users").insert({ id: 1 });',
        "}",
      ].join("\n"),
    });

    const writes = only(hits, "db-write");
    expect(writes).toHaveLength(1);
    expect(writes[0].reason).toContain("file-level fallback");
  });

  it("supabase: .insert(...) chained off an invoked .from(...) is a db-write via the documented fallback", () => {
    const hits = anchorsOf({
      "a.ts": [
        'import { createClient } from "@supabase/supabase-js";',
        "const supabase = createClient(url, key);",
        "function handler() {",
        '  return supabase.from("orders").insert({ id: 1 });',
        "}",
      ].join("\n"),
    });

    const writes = only(hits, "db-write");
    expect(writes).toHaveLength(1);
    expect(writes[0].reason).toContain("file-level fallback");
  });

  it("near-miss: supabase-shaped chained call without the package import produces no fallback hit", () => {
    const hits = anchorsOf({
      "a.ts": [
        "const supabase = makeClient(url, key);",
        "function handler() {",
        '  return supabase.from("orders").insert({ id: 1 });',
        "}",
      ].join("\n"),
    });

    expect(only(hits, "db-write")).toEqual([]);
  });

  it("drizzle-orm: .insert(...) on a resolved root is a db-write", () => {
    const hits = anchorsOf({
      "a.ts": [
        'import { drizzle } from "drizzle-orm";',
        "const db = drizzle(conn);",
        "function handler() {",
        "  return db.insert(users).values({ id: 1 });",
        "}",
      ].join("\n"),
    });

    expect(only(hits, "db-write")).toHaveLength(1);
  });
});

describe("findAnchors — idempotency-guard", () => {
  it("rule (1): an upsert-shaped write is BOTH a db-write and an idempotency-guard hit", () => {
    const hits = anchorsOf({
      "a.ts": [
        'import { PrismaClient } from "@prisma/client";',
        "const prisma = new PrismaClient();",
        "function handler() {",
        "  return prisma.user.upsert({ where: {}, create: {}, update: {} });",
        "}",
      ].join("\n"),
    });

    expect(only(hits, "db-write")).toHaveLength(1);
    const guards = only(hits, "idempotency-guard");
    expect(guards).toHaveLength(1);
    expect(guards[0].line).toBe(only(hits, "db-write")[0].line);
    expect(guards[0].reason).toContain("upsert-shaped");
  });

  it("rule (1): a pg INSERT ... ON CONFLICT ... is upsert-shaped", () => {
    const hits = anchorsOf({
      "a.ts": [
        'import { Pool } from "pg";',
        "const pool = new Pool();",
        "function handler() {",
        '  return pool.query("INSERT INTO users (id) VALUES ($1) ON CONFLICT (id) DO UPDATE SET id = $1");',
        "}",
      ].join("\n"),
    });

    expect(only(hits, "db-write")).toHaveLength(1);
    expect(only(hits, "idempotency-guard")).toHaveLength(1);
  });

  it("rule (2): an explicit idempotencyKey argument property is a guard, independent of any DB resolution", () => {
    const hits = anchorsOf({
      "a.ts": [
        "function chargeCustomer(key) {",
        "  return stripeCharge({ idempotencyKey: key, amount: 100 });",
        "}",
      ].join("\n"),
    });

    const guards = only(hits, "idempotency-guard");
    expect(guards).toHaveLength(1);
    expect(guards[0].reason).toContain("idempotencyKey");
    expect(only(hits, "db-write")).toEqual([]); // stripeCharge isn't a tracked DB package at all
  });

  it("rule (3): a read call in the SAME function, at a lower line, guards a later write", () => {
    const hits = anchorsOf({
      "a.ts": [
        'import { PrismaClient } from "@prisma/client";',
        "const prisma = new PrismaClient();",
        "async function handler() {",
        "  const existing = await prisma.user.findUnique({ where: {} });",
        "  if (existing) return existing;",
        "  return prisma.user.create({ data: {} });",
        "}",
      ].join("\n"),
    });

    const guards = only(hits, "idempotency-guard");
    expect(guards).toHaveLength(1);
    expect(guards[0].reason).toContain("lookup-before-write");
    expect(guards[0].line).toBe(only(hits, "db-write")[0].line);
  });

  it("near-miss: a findUnique in a DIFFERENT function than the write does not guard it", () => {
    const hits = anchorsOf({
      "a.ts": [
        'import { PrismaClient } from "@prisma/client";',
        "const prisma = new PrismaClient();",
        "async function lookup() {",
        "  return prisma.user.findUnique({ where: {} });",
        "}",
        "async function handler() {",
        "  return prisma.user.create({ data: {} });",
        "}",
      ].join("\n"),
    });

    expect(only(hits, "idempotency-guard")).toEqual([]);
  });

  it("near-miss: a findUnique AFTER the write (higher line) does not guard it", () => {
    const hits = anchorsOf({
      "a.ts": [
        'import { PrismaClient } from "@prisma/client";',
        "const prisma = new PrismaClient();",
        "async function handler() {",
        "  const created = await prisma.user.create({ data: {} });",
        "  const check = await prisma.user.findUnique({ where: {} });",
        "  return created ?? check;",
        "}",
      ].join("\n"),
    });

    expect(only(hits, "idempotency-guard")).toEqual([]);
  });
});

describe("findAnchors — determinism and ordering", () => {
  it("returns an equal (deep) array for the same input graph built twice", () => {
    const files = {
      "a.ts": [
        'import Stripe from "stripe";',
        "function handleWebhook(req) {",
        '  const stripe = new Stripe("k");',
        "  return stripe.webhooks.constructEvent(req.body, sig, secret);",
        "}",
      ].join("\n"),
    };
    expect(anchorsOf(files)).toEqual(anchorsOf(files));
  });

  it("sorts hits by (path, line, kind)", () => {
    const hits = anchorsOf({
      "b.ts": [
        'import { PrismaClient } from "@prisma/client";',
        "const prisma = new PrismaClient();",
        "function handler() {",
        "  return prisma.user.upsert({ where: {}, create: {}, update: {} });",
        "}",
      ].join("\n"),
      "a.ts": [
        'import Stripe from "stripe";',
        "function handleWebhook(req) {",
        '  const stripe = new Stripe("k");',
        "  return stripe.webhooks.constructEvent(req.body, sig, secret);",
        "}",
      ].join("\n"),
    });

    // a.ts sorts before b.ts regardless of the object key insertion order
    // above (findAnchors iterates graph.files(), which is itself sorted —
    // see graph.ts's buildGraph), and within b.ts the upsert produces two
    // hits (db-write, idempotency-guard) at the SAME line — db-write sorts
    // before idempotency-guard alphabetically, per the (path, line, kind)
    // contract.
    expect(hits.map((h) => [h.path, h.kind])).toEqual([
      ["a.ts", "webhook-verification"],
      ["b.ts", "db-write"],
      ["b.ts", "idempotency-guard"],
    ]);
  });
});

// -----------------------------------------------------------------------
// H6 phase 2a — new webhook providers (PayPal, Mercado Pago, Lemon Squeezy,
// Paddle) + the IAP/RevenueCat recognizer. Same integration-through-real-
// pipeline style as every test above (anchorsOf/only), one positive + at
// least one near-miss per descriptor, per the milestone task.
// -----------------------------------------------------------------------

describe("findAnchors — webhook-verification — PayPal", () => {
  it("resolves client.verifyWebhookSignature(...) through a 'new' binding", () => {
    const hits = anchorsOf({
      "a.ts": [
        'import { PayPalHttpClient } from "@paypal/checkout-server-sdk";',
        "function handleWebhook(req) {",
        "  const client = new PayPalHttpClient(env);",
        "  return client.verifyWebhookSignature(req.body);",
        "}",
      ].join("\n"),
    });

    const webhook = only(hits, "webhook-verification");
    expect(webhook).toHaveLength(1);
    expect(webhook[0]).toMatchObject({ providerSlug: "payments/paypal-webhook-flow" });
    expect(webhook[0].reason).toContain('receiver resolved to import "@paypal/checkout-server-sdk"');
  });

  it("resolves the nested webhooksController.verifyWebhookSignature(...) shape (paypal-server-sdk)", () => {
    const hits = anchorsOf({
      "a.ts": [
        'import { Client } from "@paypal/paypal-server-sdk";',
        "function handleWebhook(req) {",
        "  const paypalClient = new Client(config);",
        "  return paypalClient.webhooksController.verifyWebhookSignature(req.body);",
        "}",
      ].join("\n"),
    });

    const webhook = only(hits, "webhook-verification");
    expect(webhook).toHaveLength(1);
    expect(webhook[0].providerSlug).toBe("payments/paypal-webhook-flow");
  });

  it("fallback: literal 'paypal-transmission-sig' present AND file imports a PayPal package", () => {
    const hits = anchorsOf({
      "a.ts": [
        'import { Client } from "@paypal/paypal-server-sdk";',
        "function readHeaders(req) {",
        "  return req.headers['paypal-transmission-sig'];",
        "}",
      ].join("\n"),
    });

    const webhook = only(hits, "webhook-verification");
    expect(webhook).toHaveLength(1);
    expect(webhook[0].providerSlug).toBe("payments/paypal-webhook-flow");
    expect(webhook[0].reason).toContain("weaker");
  });

  it("near-miss: verifyWebhookSignature(...) on a root resolving to a NON-PayPal import", () => {
    const hits = anchorsOf({
      "a.ts": [
        'import { OtherClient } from "not-paypal";',
        "function handleWebhook(req) {",
        "  const client = new OtherClient(env);",
        "  return client.verifyWebhookSignature(req.body);",
        "}",
      ].join("\n"),
    });

    expect(only(hits, "webhook-verification")).toEqual([]);
  });
});

describe("findAnchors — webhook-verification — Mercado Pago", () => {
  it("creation call (Preference.create, via a 'new Preference' binding) counts as the webhook anchor", () => {
    const hits = anchorsOf({
      "a.ts": [
        'import { MercadoPagoConfig, Preference } from "mercadopago";',
        "const mpClient = new MercadoPagoConfig({ accessToken: 'x' });",
        "const preference = new Preference(mpClient);",
        "function handler(body) {",
        "  return preference.create({ body });",
        "}",
      ].join("\n"),
    });

    const webhook = only(hits, "webhook-verification");
    expect(webhook).toHaveLength(1);
    expect(webhook[0].providerSlug).toBe("payments/mercadopago-flow");
    expect(webhook[0].reason).toContain("creation call counts as this provider's webhook anchor");
  });

  it("the equivalent payment.create(...) shape also counts as the webhook anchor", () => {
    const hits = anchorsOf({
      "a.ts": [
        'import { MercadoPagoConfig, Payment } from "mercadopago";',
        "const mpClient = new MercadoPagoConfig({ accessToken: 'x' });",
        "const payment = new Payment(mpClient);",
        "function handler(body) {",
        "  return payment.create({ body });",
        "}",
      ].join("\n"),
    });

    expect(only(hits, "webhook-verification")).toHaveLength(1);
  });

  it("fallback: literal 'x-signature' present AND file imports mercadopago, with no creation call at all", () => {
    const hits = anchorsOf({
      "a.ts": [
        'import { MercadoPagoConfig } from "mercadopago";',
        "function handleIpn(req) {",
        "  return req.headers['x-signature'];",
        "}",
      ].join("\n"),
    });

    const webhook = only(hits, "webhook-verification");
    expect(webhook).toHaveLength(1);
    expect(webhook[0].providerSlug).toBe("payments/mercadopago-flow");
    expect(webhook[0].reason).toContain("weaker");
  });

  it("near-miss: a resolved .create(...) call on a NON-mercadopago import produces no mercadopago hit", () => {
    const hits = anchorsOf({
      "a.ts": [
        'import { PrismaClient } from "@prisma/client";',
        "const prisma = new PrismaClient();",
        "function handler() {",
        "  return prisma.user.create({ data: {} });",
        "}",
      ].join("\n"),
    });

    expect(only(hits, "webhook-verification")).toEqual([]);
  });

  it("collision: a file with an 'x-signature' literal AND a mercadopago import produces ONLY the mercadopago hit, never a Lemon Squeezy one", () => {
    const hits = anchorsOf({
      "a.ts": [
        'import { MercadoPagoConfig } from "mercadopago";',
        "function handleIpn(req) {",
        "  return req.headers['x-signature'];",
        "}",
      ].join("\n"),
    });

    const webhook = only(hits, "webhook-verification");
    expect(webhook).toHaveLength(1);
    expect(webhook[0].providerSlug).toBe("payments/mercadopago-flow");
    // The Lemon Squeezy file-level fallback requires importing
    // "@lemonsqueezy/lemonsqueezy.js" (absent here) and the manual-HMAC
    // rule requires createHmac+timingSafeEqual calls (also absent here) —
    // see WebhookProviderDescriptor.manualHmacLiteral's own comment on why
    // this collision is documented, not fixed.
    expect(webhook.some((h) => h.providerSlug === "payments/lemonsqueezy-webhook-flow")).toBe(false);
  });
});

describe("findAnchors — webhook-verification — Lemon Squeezy", () => {
  it("fallback: literal 'x-signature' present AND file imports the Lemon Squeezy package", () => {
    const hits = anchorsOf({
      "a.ts": [
        'import { LemonSqueezy } from "@lemonsqueezy/lemonsqueezy.js";',
        "function handleWebhook(req) {",
        "  return req.headers['x-signature'];",
        "}",
      ].join("\n"),
    });

    const webhook = only(hits, "webhook-verification");
    expect(webhook).toHaveLength(1);
    expect(webhook[0].providerSlug).toBe("payments/lemonsqueezy-webhook-flow");
    expect(webhook[0].reason).toContain("weaker");
  });

  it("manual HMAC: createHmac + timingSafeEqual calls co-located with 'x-signature', with NO package import at all", () => {
    const hits = anchorsOf({
      "a.ts": [
        'import { createHmac, timingSafeEqual } from "node:crypto";',
        "function verify(req, secret) {",
        "  const hmac = createHmac('sha256', secret);",
        "  const digest = hmac.update(req.rawBody).digest('hex');",
        "  const signature = req.headers['x-signature'];",
        "  return timingSafeEqual(Buffer.from(digest), Buffer.from(signature));",
        "}",
      ].join("\n"),
    });

    const webhook = only(hits, "webhook-verification");
    expect(webhook).toHaveLength(1);
    expect(webhook[0].providerSlug).toBe("payments/lemonsqueezy-webhook-flow");
    expect(webhook[0].reason).toContain("manual HMAC verification");
  });

  it("near-miss: 'x-signature' literal present, no package import, and only createHmac (no timingSafeEqual) — no hit", () => {
    const hits = anchorsOf({
      "a.ts": [
        'import { createHmac } from "node:crypto";',
        "function verify(req, secret) {",
        "  const hmac = createHmac('sha256', secret);",
        "  return req.headers['x-signature'] === hmac.update(req.rawBody).digest('hex');",
        "}",
      ].join("\n"),
    });

    expect(only(hits, "webhook-verification")).toEqual([]);
  });
});

describe("findAnchors — webhook-verification — Paddle", () => {
  it("resolves paddle.unmarshal(...) through a 'new' binding (short suffix)", () => {
    const hits = anchorsOf({
      "a.ts": [
        'import { Paddle } from "@paddle/paddle-node-sdk";',
        "function handleWebhook(req) {",
        "  const paddle = new Paddle(apiKey);",
        "  return paddle.unmarshal(req.body, secret, sig);",
        "}",
      ].join("\n"),
    });

    const webhook = only(hits, "webhook-verification");
    expect(webhook).toHaveLength(1);
    expect(webhook[0].providerSlug).toBe("payments/paddle-webhook-flow");
  });

  it("resolves paddle.webhooks.unmarshal(...) through a direct import binding (long suffix)", () => {
    const hits = anchorsOf({
      "a.ts": [
        'import paddle from "@paddle/paddle-node-sdk";',
        "function handleWebhook(req) {",
        "  return paddle.webhooks.unmarshal(req.body, secret, sig);",
        "}",
      ].join("\n"),
    });

    expect(only(hits, "webhook-verification")).toHaveLength(1);
  });

  it("fallback: literal 'paddle-signature' present AND file imports the Paddle package", () => {
    const hits = anchorsOf({
      "a.ts": [
        'import { Paddle } from "@paddle/paddle-node-sdk";',
        "function readHeaders(req) {",
        "  return req.headers['paddle-signature'];",
        "}",
      ].join("\n"),
    });

    expect(only(hits, "webhook-verification")).toHaveLength(1);
  });

  it("near-miss: an unrelated method call on a resolved Paddle receiver produces no hit", () => {
    const hits = anchorsOf({
      "a.ts": [
        'import { Paddle } from "@paddle/paddle-node-sdk";',
        "function handler() {",
        "  const paddle = new Paddle(apiKey);",
        "  return paddle.someOtherMethod();",
        "}",
      ].join("\n"),
    });

    expect(only(hits, "webhook-verification")).toEqual([]);
  });
});

describe("findAnchors — IAP (RevenueCat)", () => {
  it("iap-configure: Purchases.configure(...) resolved through a direct default import", () => {
    const hits = anchorsOf({
      "a.ts": ['import Purchases from "react-native-purchases";', "function init() {", "  Purchases.configure({ apiKey: 'abc' });", "}"].join(
        "\n"
      ),
    });

    const configure = only(hits, "iap-configure");
    expect(configure).toHaveLength(1);
    expect(configure[0].reason).toContain('receiver resolved to import "react-native-purchases"');
  });

  it("iap-configure: also resolves through @revenuecat/purchases-js", () => {
    const hits = anchorsOf({
      "a.ts": [
        'import Purchases from "@revenuecat/purchases-js";',
        "function init() {",
        "  Purchases.configure({ apiKey: 'abc' });",
        "}",
      ].join("\n"),
    });

    expect(only(hits, "iap-configure")).toHaveLength(1);
  });

  it("iap-configure: weaker fallback matches the raw 'Purchases.configure(...)' chain suffix when the receiver isn't resolved", () => {
    const hits = anchorsOf({
      "a.ts": [
        'import Purchases from "react-native-purchases";',
        "const wrapped = { Purchases };",
        "function init() {",
        "  wrapped.Purchases.configure({ apiKey: 'abc' });",
        "}",
      ].join("\n"),
    });

    const configure = only(hits, "iap-configure");
    expect(configure).toHaveLength(1);
    expect(configure[0].reason).toContain("weaker");
  });

  it("near-miss: Purchases.configure(...) with no IAP package imported at all — no hit, even for the raw-chain shape", () => {
    const hits = anchorsOf({
      "a.ts": ["function init() {", "  Purchases.configure({ apiKey: 'abc' });", "}"].join("\n"),
    });

    expect(only(hits, "iap-configure")).toEqual([]);
  });

  it("iap-purchase: purchasePackage(...) resolved through a direct import", () => {
    const hits = anchorsOf({
      "a.ts": [
        'import Purchases from "react-native-purchases";',
        "async function buy(pkg) {",
        "  return Purchases.purchasePackage(pkg);",
        "}",
      ].join("\n"),
    });

    const purchase = only(hits, "iap-purchase");
    expect(purchase).toHaveLength(1);
    expect(purchase[0].reason).toContain('receiver resolved to import "react-native-purchases"');
  });

  it("iap-purchase: purchaseProduct(...) and purchaseStoreProduct(...) are also tracked purchase verbs", () => {
    const hits = anchorsOf({
      "a.ts": [
        'import Purchases from "react-native-purchases";',
        "async function buyProduct(id) {",
        "  return Purchases.purchaseProduct(id);",
        "}",
        "async function buyStoreProduct(id) {",
        "  return Purchases.purchaseStoreProduct(id);",
        "}",
      ].join("\n"),
    });

    expect(only(hits, "iap-purchase")).toHaveLength(2);
  });

  it("near-miss: purchasePackage(...) resolved to a NON-IAP package — no hit", () => {
    const hits = anchorsOf({
      "a.ts": [
        'import Purchases from "other-purchases-lib";',
        "async function buy(pkg) {",
        "  return Purchases.purchasePackage(pkg);",
        "}",
      ].join("\n"),
    });

    expect(only(hits, "iap-purchase")).toEqual([]);
  });

  it("iap-entitlement-gate: a call chain containing an 'entitlements' segment (hasOwnProperty shape)", () => {
    const hits = anchorsOf({
      "a.ts": [
        "function isPro(customerInfo) {",
        "  return customerInfo.entitlements.active.hasOwnProperty('pro');",
        "}",
      ].join("\n"),
    });

    const gate = only(hits, "iap-entitlement-gate");
    expect(gate).toHaveLength(1);
    expect(gate[0].reason).toContain('"entitlements" segment');
  });

  it("iap-entitlement-gate: a bare 'if (customerInfo.entitlements.active[...])' condition (no call at all) is now recognized", () => {
    const hits = anchorsOf({
      "a.ts": [
        "function isPro(customerInfo) {",
        "  if (customerInfo.entitlements.active['pro']) {",
        "    return true;",
        "  }",
        "  return false;",
        "}",
      ].join("\n"),
    });

    const gate = only(hits, "iap-entitlement-gate");
    expect(gate).toHaveLength(1);
    expect(gate[0]).toMatchObject({ enclosingFunction: "isPro", line: 2 });
    expect(gate[0].reason).toContain('"entitlements" segment');
    expect(gate[0].reason).toContain("not a call");
  });

  it("iap-entitlement-gate: assigning the bare access to a const first is also recognized", () => {
    const hits = anchorsOf({
      "a.ts": [
        "function isPro(customerInfo) {",
        "  const entitlement = customerInfo.entitlements.active['pro'];",
        "  return Boolean(entitlement);",
        "}",
      ].join("\n"),
    });

    const gate = only(hits, "iap-entitlement-gate");
    expect(gate).toHaveLength(1);
    expect(gate[0]).toMatchObject({ enclosingFunction: "isPro", line: 2 });
  });

  it("iap-entitlement-gate: a call on an entitlements chain still produces exactly one hit, not two", () => {
    const hits = anchorsOf({
      "a.ts": [
        "function isPro(customerInfo) {",
        "  return customerInfo.entitlements.active.hasOwnProperty('pro');",
        "}",
      ].join("\n"),
    });

    expect(only(hits, "iap-entitlement-gate")).toHaveLength(1);
  });
});
