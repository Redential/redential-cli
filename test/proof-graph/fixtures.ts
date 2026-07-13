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
