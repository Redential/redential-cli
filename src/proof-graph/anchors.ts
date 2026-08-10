// H2 of the proof-graph spike (see docs/proof-graph-spike.md), part 1 of 2:
// anchor recognizers for the three nodes the spike's one target shape needs
// (webhook signature verification, DB write, idempotency guard). Part 2
// (connected-shape classification into DIRECT/INFERRED/AMBIGUOUS) consumes
// this file's `findAnchors` output and MUST NOT need any change to this
// module's exported contract — see the AnchorKind/AnchorHit/findAnchors
// signatures below, which are load-bearing for that sibling task.
//
// Same posture as parser-adapter.ts and graph.ts: deterministic, in-memory,
// zero network, no type-checker — every rule below is "does this syntactic
// shape unambiguously say so," never a guess or a heuristic score. A call
// this module can't confidently place is simply not a hit; there is no
// partial-confidence output anywhere in this file.
import type { ParsedCall, ParsedFile } from "./parser-adapter.js";
import type { ProofGraph } from "./graph.js";

// H6 phase 2a: additive union extension for RevenueCat/IAP's own 3-anchor
// shape (configure / purchase / entitlement-gate) — see the "IAP" section
// below findAnchors' webhook/db-write/idempotency recognizers. IAP has no
// "webhook verification" node at all (there's no webhook in an in-app
// purchase flow), so it needed its own anchor kinds rather than being
// squeezed into the webhook/db-write/idempotency shape.
// Auth-flows milestone (issue #5): three more 3-anchor shapes, none of which
// fit the webhook or IAP triads. Same additive posture as H6 phase 2a — a
// union extension plus a descriptor table plus recognizers, with ZERO change
// to infer.ts's triple/pair search functions (they never inspect
// AnchorHit.kind; see StructuralPattern.anchorKinds' own comment there).
//
// One structural difference from payments, deliberate: the payments slugs are
// PER-PROVIDER (Stripe/PayPal/Paddle each get their own), so
// webhook-verification hits must carry providerSlug and be filtered per
// pattern. The auth slugs are PER-FLOW, not per-library — NextAuth, Supabase
// Auth, and plain JWT all feed the SAME three flow slugs — so every anchor
// kind below is library-agnostic and SHARED across patterns, exactly like
// db-write already is. None of them ever sets providerSlug, and
// anchorsForPatternKind (infer.ts) needs no new filtering branch.
export type AnchorKind =
  | "webhook-verification"
  | "db-write"
  | "idempotency-guard"
  | "iap-configure"
  | "iap-purchase"
  | "iap-entitlement-gate"
  // auth/session-flow
  | "credential-verification"
  | "session-issuance"
  | "route-guard"
  // auth/oauth-flow
  | "authorize-redirect"
  | "code-exchange"
  // auth/jwt-refresh-flow
  | "token-verification"
  | "refresh-rotation"
  | "guard-response"
  // OPTIONAL strengthener for auth/jwt-refresh-flow — never part of its
  // required triad. See refreshInvalidationHits below and the pattern's
  // optionalAnchorKinds entry in infer.ts.
  | "refresh-invalidation";

export interface AnchorHit {
  kind: AnchorKind;
  path: string;
  enclosingFunction: string | null;
  line: number;
  // Short, stable English description of which rule fired and, where
  // relevant, how the receiver was resolved — meant for a future LOCAL-only
  // `redential explain` command (see docs/proof-graph-spike.md's H4). Never
  // serialized into a bundle, never leaves the machine, same as every other
  // structure in this spike.
  reason: string;
  // OPTIONAL, set ONLY on "webhook-verification" hits (H6 multi-provider
  // generalization): which WEBHOOK_PROVIDERS descriptor (below) produced
  // this hit, carried as the taxonomy slug that descriptor maps to — e.g.
  // "payments/payment-webhook-flow" for Stripe, "payments/mercadopago-flow"
  // for Mercado Pago, etc. (H6 phase 2a: WEBHOOK_PROVIDERS now has 5
  // entries, not just Stripe — see that table below). Added as an optional
  // field rather than a required one so every existing AnchorHit-shaped test
  // fixture and assertion (toMatchObject / field-by-field checks throughout
  // test/proof-graph/anchors.test.ts) keeps compiling and passing unchanged;
  // none of them do an exact-shape toEqual on a non-empty AnchorHit, which
  // is what made this route safe (see the H6 phase-1 task report). db-write
  // and idempotency-guard hits never set this — they are already
  // provider-agnostic (see WEBHOOK_PROVIDERS' own comment) and infer.ts's
  // STRUCTURAL_PATTERNS loop needs it ONLY to disambiguate which provider's
  // triple a webhook-verification hit belongs to; db-write/idempotency-guard
  // anchors are intentionally shared/unfiltered across every pattern (see
  // infer.ts's own comment on why). The three "iap-*" kinds (H6 phase 2a)
  // never set this either — there is only ever one IAP pattern
  // (payments/iap-subscription-flow), so there is nothing to disambiguate.
  providerSlug?: string;
  // OPTIONAL, set ONLY on auth anchors produced from an AUTH_LIBRARIES
  // descriptor (authLibraryHits, and refreshRotationHits which derives from
  // them). The auth analogue of providerSlug, and it exists for the same
  // reason: without it, nothing downstream can tell that a triad was
  // assembled from anchors belonging to DIFFERENT auth libraries.
  //
  // Deliberately unset on the guard anchors (route-guard / guard-response)
  // and on refresh-invalidation: those are framework-level shapes
  // (`res.status(401)`, `redirect(...)`, an ORM delete), not the property of
  // any auth library, so they are shared across every library scope. Setting
  // a libraryId on them would wrongly prevent a real single-library flow
  // from finding its own guard.
  libraryId?: string;
}

// -----------------------------------------------------------------------
// Package specifiers the recognizers below match against. This is SPIKE
// DETECTOR DATA — the same kind of thing as an entry in signatures/*.json's
// import tables — NOT a taxonomy slug from taxonomy.json. The distinction
// matters: CLAUDE.md's "closed vocabulary" invariant is about what slug a
// bundle is allowed to claim, and this spike never writes to a bundle at
// all (see the spike doc's Invariants). Adding, removing, or renaming an
// entry in the tables below has zero effect on that guarantee — it only
// changes which raw import specifiers this experimental recognizer
// happens to look for.
// -----------------------------------------------------------------------
const STRIPE_SPECIFIER = "stripe";
const PRISMA_SPECIFIERS = new Set(["@prisma/client", "prisma"]);
const SUPABASE_SPECIFIER = "@supabase/supabase-js";
const PG_SPECIFIER = "pg";
const KNEX_SPECIFIER = "knex";
const DRIZZLE_SPECIFIER = "drizzle-orm";

const DB_PACKAGE_SPECIFIERS = new Set([
  ...PRISMA_SPECIFIERS,
  SUPABASE_SPECIFIER,
  PG_SPECIFIER,
  KNEX_SPECIFIER,
  DRIZZLE_SPECIFIER,
]);

const PRISMA_WRITE_VERBS = new Set(["create", "createMany", "update", "updateMany", "upsert"]);
const SUPABASE_WRITE_VERBS = new Set(["insert", "upsert", "update"]);
// knex's tracked write-verb set deliberately has no "upsert" entry: knex
// doesn't expose a single ".upsert(...)" method the way Prisma/Supabase do
// (its idiom is `.insert(...).onConflict(...).merge(...)`, a longer chain
// this milestone's shape rules don't special-case) — so a knex write hit
// can never also be upsert-shaped via THIS table; see matchDbWrite's own
// comment.
const KNEX_WRITE_VERBS = new Set(["insert", "update"]);
const DRIZZLE_WRITE_SEGMENTS = new Set(["insert", "update", "onConflictDoUpdate"]);
const DB_READ_VERBS = new Set(["findUnique", "findFirst", "findOne", "select", "get"]);

const PG_WRITE_SQL = /^\s*(insert|update)\b/i;
const PG_UPSERT_SQL = /on\s+conflict/i;

// -----------------------------------------------------------------------
// WEBHOOK_PROVIDERS — H6 multi-provider generalization (see
// docs/proof-graph-spike.md and this milestone's own doc, phase 1). SPIKE
// DETECTOR DATA, same status as every other table in this file (see the
// comment above STRIPE_SPECIFIER etc.): a versioned, in-repo, deterministic
// pattern table this experimental recognizer walks — NOT the taxonomy
// authority itself. `slug` below is only meaningful because
// inferStructuralSkills (infer.ts) cross-checks it against taxonomy.json at
// runtime before ever producing a finding that names it (defense in depth,
// same posture as skill-detect.ts's compile()); adding a descriptor here
// with a slug that isn't ALSO added to taxonomy.json produces a ScanError,
// never a silent bundle leak.
//
// Phase 1 of H6 shipped ONLY the Stripe descriptor — an intentionally
// provable no-op refactor: the recognizer iterates this table instead of
// hardcoding Stripe's shape, and with exactly one entry the observable
// behavior was byte-for-byte identical to before the refactor (see phase
// 1's own commit/task report). Phase 2a (this file's current state) adds
// the remaining 4 webhook-shaped providers below — PayPal, Mercado Pago,
// Lemon Squeezy, Paddle — plus RevenueCat/IAP as an entirely separate
// recognizer further down (IAP has no webhook node at all; see the IAP
// section). Decision (documented per the milestone task): each provider
// gets its OWN taxonomy slug rather than a generic
// "payments/payment-webhook-flow" for all of them — the provider is part
// of the evidence and the label a company sees, not an implementation
// detail to collapse away.
export interface WebhookProviderDescriptor {
  /** Taxonomy slug (taxonomy.json) this provider's webhook pattern produces. */
  slug: string;
  /** npm specifiers that identify the provider (mirrors STRIPE_SPECIFIER etc. above). */
  packages: string[];
  /**
   * Call-chain endings that mean "verify webhook" once a call's receiver
   * has been resolved to one of `packages` — each inner array is checked
   * against the END of the resolved chain, same rule webhookHits already
   * applied to Stripe (`["webhooks","constructEvent"]` matches a resolved
   * chain ending in exactly those two segments, in that order).
   */
  verifyChainSuffixes: string[][];
  /**
   * Header/signature literal(s) for the weaker file-level fallback (no
   * receiver resolution at all — see webhookHits' own comment on why that
   * fallback exists and why it's intentionally weaker).
   */
  signatureLiterals: string[];
  /**
   * OPTIONAL (H6 phase 2a) — ADDITIVE extension for a provider whose
   * webhook-flow anchor isn't a dedicated "verify" call at all, but a call
   * that ALSO serves another purpose. Mercado Pago is the one provider that
   * needs this today: its SDK has no `verifyWebhookSignature`-style method
   * — the shape is "create a Preference/Payment" (the call that starts the
   * flow, e.g. `preference.create(...)` / `payment.create(...)`) followed
   * by an IPN/webhook notification Mercado Pago sends back (covered by
   * `signatureLiterals` below, e.g. `x-signature`). Rather than stretch
   * `verifyChainSuffixes`'s meaning ("this call verifies a signature") to
   * cover "this call merely STARTS the flow", this is a separate,
   * explicitly-named field: checked the SAME way as verifyChainSuffixes
   * (receiver resolved to one of `packages`, chain suffix match) but
   * produces a hit with a DIFFERENT reason string, so `explain` output
   * never claims a creation call is a signature check it isn't. See
   * webhookHits' own comment for the exact matching logic.
   *
   * Known parser-level gap (documented, not a bug): a bare
   * `new Preference(...)` instantiation that's never followed by a
   * `.create(...)` call produces no hit at all — parser-adapter.ts only
   * tracks CallExpression nodes as ParsedCall (see its own module comment);
   * a NewExpression used as a binding's initializer becomes a
   * ParsedBinding, which webhookHits (like every anchor recognizer in this
   * file) never scans directly. In practice every real Mercado Pago
   * integration DOES follow construction with `.create(...)`, so this gap
   * is expected to be invisible in real repos.
   */
  creationChainSuffixes?: string[][];
  /**
   * OPTIONAL (H6 phase 2a) — ADDITIVE, Lemon Squeezy-only today. A narrow
   * special case: `createHmac(...)` + `timingSafeEqual(...)` calls
   * anywhere in the SAME FILE as this literal count as manual webhook
   * verification EVEN WITHOUT importing any of `packages` above — the one
   * documented exception, in this whole table, to "webhook-verification
   * always requires SOME reference to the provider's own package" (Lemon
   * Squeezy's own SDK doesn't expose a signature-verification helper; their
   * docs show hand-rolled HMAC instead, so gating this purely on the
   * package import would miss the common real-world shape entirely).
   *
   * KNOWN, ACCEPTED COLLISION (documented per the milestone task, not
   * fixed): Mercado Pago's `signatureLiterals` also includes "x-signature"
   * (its real IPN header name), and this rule doesn't check for the
   * ABSENCE of a Mercado Pago import — so a file that hand-rolls HMAC
   * verification AND happens to also import "mercadopago" (or just
   * contains the "x-signature" literal for an unrelated reason) could, in
   * principle, produce BOTH a Lemon Squeezy manual-HMAC hit and a Mercado
   * Pago file-level-fallback hit. Accepted because: (a) it requires the
   * SAME file to independently satisfy Mercado Pago's OWN package-import
   * gate too — the manual-HMAC rule doesn't relax anything about the OTHER
   * provider's own matching; (b) a Mercado Pago IPN handler hand-rolling
   * HMAC with `timingSafeEqual` specifically is not how that SDK's
   * integrations are typically written; (c) even if both fire,
   * infer.ts's per-pattern providerSlug filtering keeps each pattern's
   * classification looking ONLY at its own hits — a spurious extra hit for
   * provider A never pollutes provider B's triple/pair search. See
   * anchors.test.ts's dedicated collision-shaped test.
   */
  manualHmacLiteral?: string;
}

export const WEBHOOK_PROVIDERS: WebhookProviderDescriptor[] = [
  {
    slug: "payments/payment-webhook-flow",
    packages: [STRIPE_SPECIFIER],
    verifyChainSuffixes: [
      ["webhooks", "constructEvent"],
      ["webhooks", "constructEventAsync"],
    ],
    signatureLiterals: ["stripe-signature"],
  },
  {
    slug: "payments/paypal-webhook-flow",
    packages: ["@paypal/checkout-server-sdk", "@paypal/paypal-server-sdk"],
    // Both the legacy checkout-server-sdk and the newer paypal-server-sdk
    // expose the verify call under a `verifyWebhookSignature` method name,
    // either directly on the resolved client (`paypalClient
    // .verifyWebhookSignature(...)`) or nested one level under a
    // "webhooksController"-style sub-client
    // (`paypalClient.webhooksController.verifyWebhookSignature(...)`) — kept
    // to just these two suffixes, both ending in the one distinctive
    // segment name, rather than trying to enumerate every SDK-version
    // client-shape variant.
    verifyChainSuffixes: [["verifyWebhookSignature"], ["webhooksController", "verifyWebhookSignature"]],
    signatureLiterals: ["paypal-transmission-sig", "paypal-auth-algo"],
  },
  {
    slug: "payments/mercadopago-flow",
    packages: ["mercadopago"],
    // No dedicated "verify" call on this SDK — see
    // WebhookProviderDescriptor.creationChainSuffixes' own comment for the
    // shape this provider actually uses instead.
    verifyChainSuffixes: [],
    // `new Preference(client)` / `new Payment(client)` followed by
    // `.create(...)` — resolveReceiver's binding-resolution rule (rule 2)
    // strips the constructor name itself (`Preference`/`Payment`) when
    // splicing the binding's chain back in, so BOTH classes collapse to the
    // exact same resolved chain here: `["create"]`. That collapse is
    // intentional, not a loss of precision that matters for this
    // recognizer — the milestone's own spec lists "new Preference /
    // preference.create / payment.create" as equivalent anchor shapes, and
    // this is the single suffix that captures all of them once resolved.
    creationChainSuffixes: [["create"]],
    // Mercado Pago's real IPN/webhook notification carries an
    // "x-signature" header — same literal Lemon Squeezy also uses; see
    // WebhookProviderDescriptor.manualHmacLiteral's own comment on the
    // documented, accepted collision this creates.
    signatureLiterals: ["x-signature"],
  },
  {
    slug: "payments/lemonsqueezy-webhook-flow",
    packages: ["@lemonsqueezy/lemonsqueezy.js"],
    // No dedicated "verify" call either — Lemon Squeezy's own docs show
    // hand-rolled HMAC verification (see manualHmacLiteral below), not an
    // SDK helper method.
    verifyChainSuffixes: [],
    signatureLiterals: ["x-signature"],
    manualHmacLiteral: "x-signature",
  },
  {
    slug: "payments/paddle-webhook-flow",
    packages: ["@paddle/paddle-node-sdk"],
    verifyChainSuffixes: [["unmarshal"], ["webhooks", "unmarshal"]],
    signatureLiterals: ["paddle-signature"],
  },
];

// True when `chain`'s LAST `suffix.length` segments equal `suffix`, in
// order — the generalized version of webhookHits' original inline
// last/secondLast comparison (`last !== "constructEvent" ... secondLast
// !== "webhooks"`). A chain shorter than the suffix can never match, the
// same way the original code's explicit `resolved.chain.length < 2`
// early-return worked for Stripe's 2-segment suffix.
function matchesChainSuffix(chain: string[], suffix: string[]): boolean {
  if (chain.length < suffix.length) return false;
  const offset = chain.length - suffix.length;
  return suffix.every((segment, i) => chain[offset + i] === segment);
}

function fileImportsSpecifier(file: ParsedFile, specifier: string): boolean {
  return file.imports.some((imp) => imp.specifier === specifier);
}

function importSpecifierForLocalName(file: ParsedFile, localName: string): string | null {
  for (const imp of file.imports) {
    for (const binding of imp.bindings) {
      if (binding.local === localName) return imp.specifier;
    }
  }
  return null;
}

/**
 * The EXPORTED name a local binding came from — `import { signIn as login }`
 * -> "signIn" for local "login"; a plain `import { signIn }` -> "signIn".
 * Null when the local name isn't an import binding at all.
 *
 * Needed by authLibraryHits for BARE-FUNCTION anchors (see its own comment):
 * resolveReceiver returns the receiver chain with its root REMOVED, so a call
 * like `signIn(...)` — where the imported binding IS the whole callee —
 * resolves to an EMPTY chain and can never match a suffix. Recovering the
 * name requires going back to the import, and the exported name is the right
 * one to match against a descriptor table that names API functions, not
 * whatever local alias a file happened to choose.
 */
function importedNameForLocalName(file: ParsedFile, localName: string): string | null {
  for (const imp of file.imports) {
    for (const binding of imp.bindings) {
      if (binding.local === localName) return binding.imported;
    }
  }
  return null;
}

interface ReceiverResolution {
  specifier: string;
  // The call's chain with its root replaced by whatever the root resolved
  // THROUGH — e.g. for `stripe.webhooks.constructEvent()` where `stripe` is
  // `new Stripe(...)`, this is ["webhooks","constructEvent"] (the "Stripe"
  // segment the binding resolved through is dropped, since it isn't part of
  // the logical shape a recognizer matches against — only the SPECIFIER
  // matters for what it resolved to).
  chain: string[];
}

/**
 * Resolves a call's receiver CHAIN ROOT to the import specifier it really
 * comes from, per the milestone's three-rule contract:
 *
 * Rule 1 — the root is directly an import binding's local name.
 *
 * Rule 2 — the root is a same-file ParsedBinding with source kind "new" or
 * "call" (e.g. `const stripe = new Stripe(...)`) whose OWN chain's root is,
 * in turn, DIRECTLY an import binding — not itself another same-file
 * binding needing further resolution. That "own chain root" requirement is
 * what "anything deeper -> unresolved" enforces: this function never
 * recurses into a second binding lookup.
 *
 * Rule 3 — one alias hop (source kind "alias", e.g. `const w =
 * stripe.webhooks`) is allowed, resolved with the EXACT SAME "binding's own
 * chain root must be a direct import" rule as rule 2 — the only difference
 * between "new"/"call" and "alias" is what kind of expression produced the
 * binding, which is irrelevant to the chain-splicing arithmetic below, so
 * both share this one code path. Because rule 2 and rule 3 both require the
 * binding's root to be a DIRECT import (never another binding), stacking
 * them — e.g. `const stripe = new Stripe(...); const w = stripe.webhooks;
 * w.constructEvent()` — resolves to null: `w`'s alias root is `stripe`,
 * which is itself a binding, not an import, so rule 3's own "direct import"
 * requirement fails. This is the intended, documented depth limit, not a
 * bug — see anchors.test.ts's "resolves nothing when a new/call binding and
 * an alias hop are stacked" case.
 */
function resolveReceiver(file: ParsedFile, call: ParsedCall): ReceiverResolution | null {
  if (call.chain.length === 0) return null;
  const [root, ...tail] = call.chain;

  const direct = importSpecifierForLocalName(file, root);
  if (direct) return { specifier: direct, chain: tail };

  const binding = file.bindings.find((b) => b.name === root);
  if (!binding) return null;
  const bindingChain = binding.source.chain;
  if (bindingChain.length === 0) return null;
  const [bindingRoot, ...bindingTail] = bindingChain;
  const viaBinding = importSpecifierForLocalName(file, bindingRoot);
  if (!viaBinding) return null; // deeper than one hop -> unresolved, by design
  return { specifier: viaBinding, chain: [...bindingTail, ...tail] };
}

// -----------------------------------------------------------------------
// (a) webhook-verification
// -----------------------------------------------------------------------

function webhookHits(graph: ProofGraph, path: string, file: ParsedFile): AnchorHit[] {
  const hits: AnchorHit[] = [];

  for (const call of file.calls) {
    // The shape check ("...webhooks.constructEvent") must run against the
    // RESOLVED chain, not the raw call.chain — an alias hop (rule 3)
    // shortens the raw chain (`w.constructEvent(...)` is only 2 segments
    // long) while the segment resolveReceiver spliced back in
    // (`stripe.webhooks` -> tail ["webhooks"]) is what actually carries the
    // "webhooks" shape. Checking call.chain directly here would silently
    // never match an alias-resolved call.
    const resolved = resolveReceiver(file, call);
    if (!resolved) continue;
    // H6: iterate WEBHOOK_PROVIDERS instead of hardcoding Stripe. With
    // today's single-entry table this produced byte-for-byte the same
    // decision as the old inline `resolved.specifier !== STRIPE_SPECIFIER`
    // check (phase 1); phase 2a added 4 more descriptors — see
    // WEBHOOK_PROVIDERS' own comment.
    const provider = WEBHOOK_PROVIDERS.find((p) => p.packages.includes(resolved.specifier));
    if (!provider) continue;

    const matchedVerifySuffix = provider.verifyChainSuffixes.find((suffix) => matchesChainSuffix(resolved.chain, suffix));
    if (matchedVerifySuffix) {
      hits.push({
        kind: "webhook-verification",
        path,
        enclosingFunction: call.enclosingFunction,
        line: call.line,
        reason: `${resolved.specifier}.${matchedVerifySuffix.join(".")} (receiver resolved to import "${resolved.specifier}")`,
        providerSlug: provider.slug,
      });
      continue; // a dedicated verify call already produced this call's hit; don't also test it against creationChainSuffixes
    }

    // H6 phase 2a: Mercado Pago-style "creation call counts as the webhook
    // anchor" — see WebhookProviderDescriptor.creationChainSuffixes' own
    // comment. Reason string is deliberately different from the verify-call
    // branch above so `explain` never conflates the two.
    const matchedCreationSuffix = provider.creationChainSuffixes?.find((suffix) => matchesChainSuffix(resolved.chain, suffix));
    if (matchedCreationSuffix) {
      hits.push({
        kind: "webhook-verification",
        path,
        enclosingFunction: call.enclosingFunction,
        line: call.line,
        reason: `${resolved.specifier}.${matchedCreationSuffix.join(".")} (creation call counts as this provider's webhook anchor — receiver resolved to import "${resolved.specifier}"; see WebhookProviderDescriptor.creationChainSuffixes)`,
        providerSlug: provider.slug,
      });
    }
  }

  // File-level fallback, explicitly weaker (per the milestone spec): a
  // provider's signature literal is present somewhere in the file AND the
  // file externally imports one of that provider's packages — no receiver
  // resolution at all, just co-location. This is the one place in this
  // module where a hit is produced WITHOUT resolving a receiver, by design
  // (a header read like `req.headers['stripe-signature']` is a member
  // access, not a call — see ParsedFile.literals' own comment in
  // parser-adapter.ts). One hit per file per provider (the FIRST matching
  // literal, in source order — ParsedFile.literals is already sorted by
  // position), not one per occurrence: the signal is "this file reads the
  // header," not a count. With today's single-entry WEBHOOK_PROVIDERS table
  // this is exactly one hit at most, same as the old hardcoded Stripe-only
  // check.
  for (const provider of WEBHOOK_PROVIDERS) {
    const matchingSpecifier = provider.packages.find((specifier) => fileImportsSpecifier(file, specifier));
    if (!matchingSpecifier) continue;
    const signatureLiteral = file.literals.find((l) => provider.signatureLiterals.includes(l.value));
    if (!signatureLiteral) continue;

    hits.push({
      kind: "webhook-verification",
      path,
      enclosingFunction: signatureLiteral.enclosingFunction,
      line: signatureLiteral.line,
      reason: `literal "${signatureLiteral.value}" present and file imports "${matchingSpecifier}" (weaker: file-level fallback, no receiver resolved)`,
      providerSlug: provider.slug,
    });
  }

  // H6 phase 2a — narrow special case (Lemon Squeezy only today, see
  // WebhookProviderDescriptor.manualHmacLiteral's own comment): a file that
  // hand-rolls HMAC verification (createHmac(...) AND timingSafeEqual(...)
  // calls, anywhere in the file, in either order — chain suffix, not
  // receiver-resolved, since a manual crypto helper is plain
  // `import { createHmac, timingSafeEqual } from "node:crypto"`, not this
  // provider's own package at all) co-located with the provider's signature
  // literal counts as verification EVEN WITHOUT importing `packages` — the
  // one place in this whole function a webhook-verification hit doesn't
  // require any reference to the provider's own package.
  for (const provider of WEBHOOK_PROVIDERS) {
    if (!provider.manualHmacLiteral) continue;
    const hasCreateHmac = file.calls.some((c) => c.chain[c.chain.length - 1] === "createHmac");
    const hasTimingSafeEqual = file.calls.some((c) => c.chain[c.chain.length - 1] === "timingSafeEqual");
    if (!hasCreateHmac || !hasTimingSafeEqual) continue;
    const signatureLiteral = file.literals.find((l) => l.value === provider.manualHmacLiteral);
    if (!signatureLiteral) continue;

    hits.push({
      kind: "webhook-verification",
      path,
      enclosingFunction: signatureLiteral.enclosingFunction,
      line: signatureLiteral.line,
      reason: `manual HMAC verification: "createHmac"+"timingSafeEqual" calls co-located with literal "${signatureLiteral.value}" (narrow special case: verification without importing "${provider.packages[0]}" — see WebhookProviderDescriptor.manualHmacLiteral)`,
      providerSlug: provider.slug,
    });
  }

  return hits;
}

// -----------------------------------------------------------------------
// (b) db-write
// -----------------------------------------------------------------------

interface DbWriteMatch {
  reason: string;
  // Whether THIS SAME write is also upsert-shaped, per idempotency-guard
  // rule (1) — computed from the exact resolution (receiver-resolved or
  // fallback-matched) that produced the write hit in the first place, so a
  // fallback-matched supabase `.upsert(...)` is just as eligible as a
  // receiver-resolved one. Intentional: one call can be BOTH a db-write and
  // an idempotency-guard hit (an upsert is both), see findAnchors below.
  upsertShaped: boolean;
}

/**
 * Matches a call against the db-write shape rules for each tracked
 * package. Tries full receiver resolution first (works cleanly for
 * prisma/pg/drizzle and any supabase/knex call that isn't chained off an
 * invoked table selector). Falls back to a documented, PACKAGE-SPECIFIC,
 * file-level co-location check for supabase/knex only — see the comment on
 * that branch for why those two (and only those two) need it.
 */
function matchDbWrite(file: ParsedFile, call: ParsedCall): DbWriteMatch | null {
  const resolved = resolveReceiver(file, call);
  if (resolved) {
    const last = resolved.chain[resolved.chain.length - 1];

    if (PRISMA_SPECIFIERS.has(resolved.specifier) && PRISMA_WRITE_VERBS.has(last)) {
      return {
        reason: `${resolved.specifier} .${last}(...) (receiver resolved to import "${resolved.specifier}")`,
        upsertShaped: last === "upsert",
      };
    }

    if (resolved.specifier === PG_SPECIFIER && last === "query") {
      const writeArg = call.stringArgs.find((s) => PG_WRITE_SQL.test(s));
      if (writeArg) {
        return {
          reason: 'pg pool.query(...) with a write-shaped SQL string argument (receiver resolved to import "pg")',
          upsertShaped: call.stringArgs.some((s) => PG_UPSERT_SQL.test(s)),
        };
      }
    }

    if (resolved.specifier === KNEX_SPECIFIER && KNEX_WRITE_VERBS.has(last)) {
      return {
        reason: `knex .${last}(...) (receiver resolved to import "knex")`,
        upsertShaped: false, // see KNEX_WRITE_VERBS' own comment
      };
    }

    if (resolved.specifier === DRIZZLE_SPECIFIER && resolved.chain.some((s) => DRIZZLE_WRITE_SEGMENTS.has(s))) {
      return {
        reason: 'drizzle-orm chain containing a write segment (receiver resolved to import "drizzle-orm")',
        upsertShaped: resolved.chain.includes("onConflictDoUpdate"),
      };
    }

    if (resolved.specifier === SUPABASE_SPECIFIER && resolved.chain.some((s) => SUPABASE_WRITE_VERBS.has(s))) {
      return {
        reason: 'supabase-js chain containing a write segment (receiver resolved to import "@supabase/supabase-js")',
        upsertShaped: resolved.chain.includes("upsert"),
      };
    }
  }

  // Documented fallback for supabase/knex only. Both packages' common
  // calling idiom invokes the table selector AS A FUNCTION —
  // `supabase.from('orders').insert(...)`, `knex('users').insert(...)` —
  // which makes the selector itself a CallExpression sitting in the middle
  // of the chain. chainOf (parser-adapter.ts) can only walk
  // identifier/`this`/property/element access; a call result is exactly the
  // shape it already collapses to a single "*" segment (same convention as
  // a computed member access), so resolveReceiver's root lookup fails for
  // the ENSUING `.insert(...)`/`.upsert(...)`/`.update(...)` call in
  // practice — there is no root name left to resolve. This is the same
  // documented syntactic-parser limitation as chainOf's own comment, not a
  // gap in resolveReceiver's three rules. Falling back to file-level import
  // co-location for just these two packages (matches the milestone spec's
  // explicit escape hatch for supabase: "or containing them at all — keep
  // simple") keeps the common real-world idiom detectable without
  // pretending a receiver was actually resolved when it wasn't. This is
  // NOT the milestone's HARD TIMEBOX-wide degrade (which would drop
  // receiver resolution for every rule) — it is a narrow, single-branch
  // fallback that only ever engages when resolveReceiver has already
  // returned null AND the chain root is specifically the "*" wildcard that
  // signals an unresolvable-because-invoked receiver.
  if (call.chain[0] === "*") {
    const tail = call.chain.slice(1);
    if (tail.some((s) => SUPABASE_WRITE_VERBS.has(s)) && fileImportsSpecifier(file, SUPABASE_SPECIFIER)) {
      return {
        reason:
          'supabase-js chain containing a write segment (file-level fallback: receiver unresolved through a chained .from(...) call, file imports "@supabase/supabase-js")',
        upsertShaped: tail.includes("upsert"),
      };
    }
    const last = call.chain[call.chain.length - 1];
    if (KNEX_WRITE_VERBS.has(last) && fileImportsSpecifier(file, KNEX_SPECIFIER)) {
      return {
        reason: `knex .${last}(...) (file-level fallback: receiver unresolved through a chained knex(...) call, file imports "knex")`,
        upsertShaped: false,
      };
    }
  }

  return null;
}

// -----------------------------------------------------------------------
// (c) idempotency-guard
// -----------------------------------------------------------------------

// Rule (3), lookup-before-write: is this call a READ on a DB-resolved root?
// Deliberately receiver-resolution ONLY, no supabase/knex fallback — the
// milestone spec's fallback escape hatch is scoped to the db-write rule
// only, and extending it here would risk a false "guard" claim from an
// unrelated `.get(...)`/`.select(...)` call whose root the parser genuinely
// couldn't place. A supabase/knex `.select(...)` chained off an invoked
// table selector is therefore a documented gap in rule (3) specifically —
// see anchors.test.ts.
function matchDbRead(file: ParsedFile, call: ParsedCall): boolean {
  const resolved = resolveReceiver(file, call);
  if (!resolved) return false;
  if (!DB_PACKAGE_SPECIFIERS.has(resolved.specifier)) return false;
  const last = resolved.chain[resolved.chain.length - 1];
  return DB_READ_VERBS.has(last);
}

function matchExplicitIdempotencyKey(call: ParsedCall): boolean {
  return call.argPropertyNames.includes("idempotencyKey");
}

// -----------------------------------------------------------------------
// (d) IAP / RevenueCat — H6 phase 2a
//
// This provider's shape doesn't fit "webhook verified -> DB write ->
// idempotency guard" at all: an in-app-purchase flow has no webhook (see
// GOALS-proof-graph-spike.md's H6 task). Its own 3-anchor shape is:
// configure the SDK, make a purchase call, gate access on entitlement
// state. db-write/idempotency-guard are irrelevant here and never appear
// in this section — infer.ts's "iap-flow" pattern uses these 3 kinds
// instead (see that file's STRUCTURAL_PATTERNS entry).
// -----------------------------------------------------------------------

// Exported (not just an internal const) so infer.ts's STRUCTURAL_PATTERNS
// "iap-flow" entry can derive its own `packages` field from the SAME list
// rather than duplicating it — same single-source-of-truth rationale as
// STRUCTURAL_PATTERNS' own `packages: provider.packages` derivation from
// WEBHOOK_PROVIDERS.
export const IAP_PACKAGES = ["react-native-purchases", "@revenuecat/purchases-js"];

const IAP_PURCHASE_LAST_SEGMENTS = new Set(["purchasePackage", "purchaseProduct", "purchaseStoreProduct"]);

/**
 * configure + purchase hits. Primary rule: receiver resolved (via
 * resolveReceiver, same mechanism every other recognizer in this file
 * uses) to one of IAP_PACKAGES, with the resolved chain's LAST segment
 * being "configure" (-> iap-configure) or one of the 3 tracked purchase
 * verbs (-> iap-purchase). Fallback (weaker, no receiver resolved, same
 * "co-location" posture as webhookHits' own literal fallback): engaged
 * ONLY when the file imports an IAP package at all, for a call whose RAW
 * chain either literally equals ["Purchases","configure"] (catches the
 * common `Purchases.configure(...)` shape even in the rare case receiver
 * resolution didn't fire) or whose raw last segment is one of the purchase
 * verbs. The fallback is only ever tried for a call resolveReceiver could
 * NOT resolve — see the `continue` right after the primary branch below —
 * so a single call never produces two hits for the same kind.
 */
function iapConfigureAndPurchaseHits(path: string, file: ParsedFile): AnchorHit[] {
  const hits: AnchorHit[] = [];
  const importsIapPackage = IAP_PACKAGES.some((specifier) => fileImportsSpecifier(file, specifier));

  for (const call of file.calls) {
    const resolved = resolveReceiver(file, call);

    if (resolved && IAP_PACKAGES.includes(resolved.specifier)) {
      const last = resolved.chain[resolved.chain.length - 1];
      if (last === "configure") {
        hits.push({
          kind: "iap-configure",
          path,
          enclosingFunction: call.enclosingFunction,
          line: call.line,
          reason: `${resolved.specifier}.configure(...) (receiver resolved to import "${resolved.specifier}")`,
        });
      }
      if (IAP_PURCHASE_LAST_SEGMENTS.has(last)) {
        hits.push({
          kind: "iap-purchase",
          path,
          enclosingFunction: call.enclosingFunction,
          line: call.line,
          reason: `${resolved.specifier}.${last}(...) (receiver resolved to import "${resolved.specifier}")`,
        });
      }
      continue; // receiver already resolved to an IAP package; never also test the weaker raw-chain fallback for this call
    }

    if (!importsIapPackage) continue;

    if (matchesChainSuffix(call.chain, ["Purchases", "configure"])) {
      hits.push({
        kind: "iap-configure",
        path,
        enclosingFunction: call.enclosingFunction,
        line: call.line,
        reason: 'raw chain "Purchases.configure(...)" (weaker: file-level fallback, no receiver resolved; file imports an IAP package)',
      });
    }
    const rawLast = call.chain[call.chain.length - 1];
    if (IAP_PURCHASE_LAST_SEGMENTS.has(rawLast)) {
      hits.push({
        kind: "iap-purchase",
        path,
        enclosingFunction: call.enclosingFunction,
        line: call.line,
        reason: `raw call ending ".${rawLast}(...)" (weaker: file-level fallback, no receiver resolved; file imports an IAP package)`,
      });
    }
  }

  return hits;
}

const ENTITLEMENT_SEGMENT = "entitlements";

/**
 * Entitlement-gate hits: any CALL, or bare property/element-access read (see
 * parser-adapter.ts's ParsedAccess), whose chain contains an "entitlements"
 * segment anywhere (not just first/last — allows shapes like
 * `customerInfo.entitlements.active.hasOwnProperty('pro')`, chain
 * ["customerInfo","entitlements","active","hasOwnProperty"], or a computed
 * access folded to "*" by chainOf, e.g.
 * `customerInfo.entitlements.active['pro'].someMethod()`).
 *
 * The access half closes what used to be this rule's documented, accepted
 * gap: the single most common real-world shape,
 * `if (customerInfo.entitlements.active['pro']) { ... }`, is a bare
 * property/element-access expression, not a CallExpression, so it never
 * produced a ParsedCall — and, before ParsedAccess existed, there was no
 * AnchorHit this rule could honestly construct for it at all (see H6's
 * original comment here, and issue #10). ParsedAccess already excludes a
 * call's own callee (see parser-adapter.ts's isMaximalAccessNode), so a call
 * like `customerInfo.entitlements.active.get('pro')` still produces exactly
 * one hit — from file.calls, same as before — not two.
 */
function iapEntitlementGateHits(path: string, file: ParsedFile): AnchorHit[] {
  const hits: AnchorHit[] = [];
  for (const call of file.calls) {
    if (!call.chain.includes(ENTITLEMENT_SEGMENT)) continue;
    hits.push({
      kind: "iap-entitlement-gate",
      path,
      enclosingFunction: call.enclosingFunction,
      line: call.line,
      reason: `call chain contains an "${ENTITLEMENT_SEGMENT}" segment (chain: ${call.chain.join(".")})`,
    });
  }
  for (const access of file.accesses) {
    if (!access.chain.includes(ENTITLEMENT_SEGMENT)) continue;
    hits.push({
      kind: "iap-entitlement-gate",
      path,
      enclosingFunction: access.enclosingFunction,
      line: access.line,
      reason: `bare property/element access contains an "${ENTITLEMENT_SEGMENT}" segment (chain: ${access.chain.join(".")}) — not a call`,
    });
  }
  return hits;
}

// -----------------------------------------------------------------------
// (e) auth flows — issue #5
//
// Three shapes, one descriptor table. Same "SPIKE DETECTOR DATA, not the
// taxonomy authority" status as WEBHOOK_PROVIDERS/IAP_PACKAGES above (see
// the comment over STRIPE_SPECIFIER): inferStructuralSkills still validates
// every STRUCTURAL_PATTERNS slug against taxonomy.json at runtime.
//
// THE HONESTY RULE (issue #5, verbatim): "The verification anchor must be
// real verification, not decoration. `jwt.verify` counts, `jwt.decode` alone
// does not. Rendering a login form does not." That rule is enforced two
// ways here: (1) by omission — no decode-shaped call appears in any
// `*ChainSuffixes` field below, so it can never produce a hit; and (2) by
// `decodeOnlyChainSuffixes`, which exists ONLY to name the calls that
// deliberately produce nothing, so the intent is greppable and testable
// rather than implicit in an absence. Nothing reads that field to make a
// hit; test/proof-graph/anchors.test.ts reads it to assert the absence.
// -----------------------------------------------------------------------

export interface AuthLibraryDescriptor {
  /** Human-readable library name — used in `reason` strings only. */
  name: string;
  /** npm specifiers that identify this library (mirrors WebhookProviderDescriptor.packages). */
  packages: string[];
  /**
   * Per-anchor-kind call-chain suffixes, each checked against the END of a
   * RESOLVED receiver chain by matchesChainSuffix — the exact same mechanism
   * WEBHOOK_PROVIDERS.verifyChainSuffixes uses. A kind a given library has no
   * shape for is simply absent (e.g. NextAuth performs its own code exchange
   * internally and exposes no call for it, so it has no codeExchange entry
   * and therefore can never, on its own, complete the oauth-flow triad — a
   * documented consequence, not an oversight).
   */
  credentialVerification?: string[][];
  sessionIssuance?: string[][];
  authorizeRedirect?: string[][];
  codeExchange?: string[][];
  tokenVerification?: string[][];
  /**
   * DOCUMENTED NON-ANCHORS. Calls that look adjacent to verification but
   * deliberately produce NO hit of any kind — the honesty rule made
   * explicit and testable. Never read by any recognizer below.
   */
  decodeOnlyChainSuffixes?: string[][];
}

export const AUTH_LIBRARIES: AuthLibraryDescriptor[] = [
  {
    name: "NextAuth/Auth.js",
    // "next-auth/react" is where `signIn`/`signOut` actually live in v4 —
    // the single most common NextAuth import in real code. Omitting it made
    // the sessionIssuance/authorizeRedirect entries below unreachable for
    // the idiomatic client shape; found while building
    // fixtureAuthMixedLibraries.
    packages: ["next-auth", "next-auth/react", "next-auth/next", "next-auth/jwt", "@auth/core"],
    // `getServerSession(...)` / `getToken(...)` both validate an existing
    // session or JWT server-side — real verification. Auth.js v5's `auth()`
    // helper is deliberately NOT listed: the idiomatic shape is
    // `const { auth } = NextAuth(config)` re-exported from a LOCAL module
    // (`@/auth`), so resolveReceiver resolves its root to a relative
    // specifier, never to one of `packages` — listing it would match
    // nothing while implying coverage this table doesn't have.
    credentialVerification: [["getServerSession"], ["getToken"]],
    sessionIssuance: [["signIn"]],
    // `signIn("github")` is what builds and follows the provider authorize
    // URL — the same call is therefore BOTH the authorize-redirect anchor
    // and the session-issuance anchor. One call producing two kinds is
    // precedented and intentional (an upsert-shaped write is already both a
    // db-write and an idempotency-guard; see DbWriteMatch's own comment).
    authorizeRedirect: [["signIn"]],
    // No codeExchange: NextAuth performs the exchange inside its own route
    // handler and exposes no call site to anchor on. See this interface's
    // own comment.
  },
  {
    name: "Supabase Auth",
    packages: [SUPABASE_SPECIFIER],
    // getUser() re-validates the JWT against the auth server; getSession()
    // reads and validates the stored session. Both are real verification —
    // unlike a bare decode, neither trusts the token's own claims.
    credentialVerification: [
      ["auth", "getUser"],
      ["auth", "getSession"],
    ],
    sessionIssuance: [
      ["auth", "signInWithPassword"],
      ["auth", "signInWithOtp"],
      ["auth", "verifyOtp"],
      ["auth", "setSession"],
    ],
    authorizeRedirect: [["auth", "signInWithOAuth"]],
    codeExchange: [["auth", "exchangeCodeForSession"]],
    tokenVerification: [["auth", "getUser"]],
  },
  {
    name: "plain JWT (jsonwebtoken/jose)",
    packages: ["jsonwebtoken", "jose"],
    // THE canonical instance of the honesty rule: `verify`/`jwtVerify`
    // check the signature; `decode`/`decodeJwt` parse claims WITHOUT
    // checking anything. Only the former appear here.
    credentialVerification: [["verify"], ["jwtVerify"]],
    tokenVerification: [["verify"], ["jwtVerify"]],
    // jsonwebtoken's `jwt.sign(...)` resolves cleanly (default import ->
    // chain ["sign"]). jose's `new SignJWT(payload).setProtectedHeader(...)
    // .sign(key)` does NOT: its chain root is a CALL RESULT, which chainOf
    // folds to "*", so resolveReceiver has no root name to place. That is
    // the same documented parser limitation the supabase/knex db-write
    // fallback exists for, and it is left as a known gap here rather than
    // adding a second co-location fallback for it.
    sessionIssuance: [["sign"]],
    decodeOnlyChainSuffixes: [["decode"], ["decodeJwt"]],
  },
];

// Access-decision shapes for route-guard / guard-response. LIBRARY-AGNOSTIC
// and deliberately ungated on any auth import — exactly like db-write, which
// is also recognized wherever it appears. A stray `res.status(401)` in a repo
// with no auth library therefore produces an anchor and NO finding: every
// auth pattern's PRIMARY anchor (anchorKinds[0]) is a verification kind that
// requires one of AUTH_LIBRARIES' packages, and inferStructuralSkills' step 4
// emits nothing for a pattern with neither package presence nor a primary
// anchor. The guard anchors can never manufacture a finding by themselves.
const GUARD_STATUS_CODES = new Set([401, 403]);
const GUARD_STATUS_SEGMENTS = new Set(["status", "sendStatus"]);
const GUARD_REDIRECT_SEGMENT = "redirect";

/**
 * route-guard / guard-response hits — the SAME rule emitted under BOTH kind
 * names, because the same access decision genuinely serves both flows
 * (auth/session-flow calls it route-guard; auth/jwt-refresh-flow calls it
 * guard-response) and infer.ts filters anchors by kind per pattern. Emitting
 * one kind and aliasing it in infer.ts would instead require a special case
 * in anchorsForPatternKind, which this file's precedent (one call, two kinds
 * — see the upsert case) avoids needing.
 *
 * Two recognized shapes:
 *   (a) a call whose chain ends in "status"/"sendStatus" carrying a 401 or
 *       403 NUMERIC argument (see ParsedCall.numberArgs, added for this
 *       milestone — the code is the whole signal; a bare "some status was
 *       set" match would be decoration);
 *   (b) a call whose chain ends in "redirect" — `res.redirect(...)`,
 *       `NextResponse.redirect(...)`, bare `redirect(...)` from
 *       next/navigation. Receiver-agnostic on purpose: the redirect target
 *       varies per framework while the segment name does not.
 *
 * KNOWN, ACCEPTED GAP (documented, not a bug): the App-Router idiom
 * `NextResponse.json({ error }, { status: 401 })` carries its code as a
 * PROPERTY of an object-literal argument. ParsedCall.argPropertyNames
 * records that a `status` KEY is present but never its VALUE (see its own
 * comment), so this rule cannot tell that shape's 401 from a 200 and
 * deliberately does not match it at all — under-claiming rather than
 * guessing, consistent with this module's "a call it can't confidently
 * place is simply not a hit" posture. Widening argPropertyNames to carry
 * literal values would be a parser change with a much broader blast radius
 * than numberArgs, and is left for a follow-up.
 */
function authGuardHits(path: string, file: ParsedFile): AnchorHit[] {
  const hits: AnchorHit[] = [];

  const push = (call: ParsedCall, reason: string): void => {
    for (const kind of ["route-guard", "guard-response"] as const) {
      hits.push({ kind, path, enclosingFunction: call.enclosingFunction, line: call.line, reason });
    }
  };

  for (const call of file.calls) {
    const last = call.chain[call.chain.length - 1];
    if (last === undefined) continue;

    if (GUARD_STATUS_SEGMENTS.has(last)) {
      const code = call.numberArgs.find((n) => GUARD_STATUS_CODES.has(n));
      if (code !== undefined) {
        push(call, `access decision: call chain ending ".${last}(${code})" (denial status code, not a bare status call)`);
        continue; // one call never produces two guard hits of the same kind
      }
    }

    if (last === GUARD_REDIRECT_SEGMENT) {
      push(call, `access decision: call chain ending ".${GUARD_REDIRECT_SEGMENT}(...)" (chain: ${call.chain.join(".")})`);
    }
  }

  return hits;
}

/**
 * Every AUTH_LIBRARIES-driven anchor kind, in one pass. Receiver resolution
 * ONLY (resolveReceiver, same three-rule contract every other recognizer in
 * this file uses) — there is deliberately NO file-level co-location fallback
 * anywhere in this function. The webhook fallback exists because a signature
 * HEADER READ is a member access with no call to attach to; every auth anchor
 * here is a genuine call, so a fallback would only ever buy false positives
 * against the honesty rule.
 */
function authLibraryHits(path: string, file: ParsedFile): AnchorHit[] {
  const hits: AnchorHit[] = [];

  for (const call of file.calls) {
    const resolved = resolveReceiver(file, call);
    if (!resolved) continue;
    const library = AUTH_LIBRARIES.find((l) => l.packages.includes(resolved.specifier));
    if (!library) continue;

    // BARE-FUNCTION anchors. Unlike every payments descriptor — all of which
    // match a receiver-shaped call (`stripe.webhooks.constructEvent`,
    // `paddle.webhooks.unmarshal`) — several auth anchors ARE the imported
    // binding itself: `signIn(...)`, `getServerSession(...)`, `getToken(...)`,
    // `jwtVerify(...)`. resolveReceiver strips the chain ROOT (it returns the
    // tail, since only the specifier matters for what the root resolved to),
    // so those calls arrive here with an EMPTY chain and can never match a
    // 1-segment suffix — matchesChainSuffix treats a chain shorter than the
    // suffix as an automatic miss.
    //
    // Recover the name from the import instead, preferring the EXPORTED name
    // so `import { signIn as login }` still matches the descriptor's "signIn"
    // rather than the file's private alias. Found by
    // fixtureAuthMixedLibraries, which produced no NextAuth anchor at all
    // until this was fixed — the whole NextAuth descriptor was dead code, as
    // were jose's `jwtVerify` entries.
    const effectiveChain =
      resolved.chain.length > 0
        ? resolved.chain
        : [importedNameForLocalName(file, call.chain[0]) ?? call.chain[0]];

    // Ordered so `reason` names the kind that fired. A single call MAY
    // produce several kinds (NextAuth's signIn is both authorize-redirect
    // and session-issuance; Supabase's auth.getUser is both
    // credential-verification and token-verification) — that is the
    // intended, precedented behavior, not double-counting.
    const table: [AnchorKind, string[][] | undefined][] = [
      ["credential-verification", library.credentialVerification],
      ["session-issuance", library.sessionIssuance],
      ["authorize-redirect", library.authorizeRedirect],
      ["code-exchange", library.codeExchange],
      ["token-verification", library.tokenVerification],
    ];

    for (const [kind, suffixes] of table) {
      const matched = suffixes?.find((suffix) => matchesChainSuffix(effectiveChain, suffix));
      if (!matched) continue;
      hits.push({
        kind,
        path,
        enclosingFunction: call.enclosingFunction,
        line: call.line,
        reason: `${library.name}: ${resolved.specifier}.${matched.join(".")} (receiver resolved to import "${resolved.specifier}")`,
        libraryId: library.name,
      });
    }
  }

  return hits;
}

// Marker literals for the refresh-rotation rule below. Presence of one of
// these SOMEWHERE in the file is what distinguishes "this sign call mints a
// refreshed access token" from "this sign call mints the original one" —
// the two are otherwise the identical `jwt.sign(...)` shape.
const REFRESH_MARKER_LITERALS = new Set(["refresh_token", "refreshToken", "refresh"]);

/**
 * refresh-rotation: a session-issuance-shaped call sitting in the SAME
 * enclosing function as a token-verification call, in a file that also
 * carries a refresh marker literal.
 *
 * Deliberately the narrowest rule in this file, because the shape it names
 * is genuinely ambiguous syntactically: `jwt.sign(...)` is byte-identical
 * whether it mints a first access token or a refreshed one. Requiring
 * co-located verification (you must have checked the refresh token before
 * issuing against it) plus an explicit refresh marker is what makes the
 * claim defensible rather than a guess.
 *
 * refresh-rotation is a REQUIRED member of the auth/jwt-refresh-flow triad.
 * That is a deliberate correction to an earlier reading of issue #5, which
 * took refresh-rotation to be the OPTIONAL member by analogy with Mercado
 * Pago's idempotency-guard. Making it optional was demonstrably wrong: with
 * rotation optional, the pattern classified from token-verification +
 * guard-response alone, so "verify a token, deny with 401" — one of the most
 * common shapes in any web codebase, and one that refreshes nothing — became
 * a CLAIMED jwt-refresh-flow finding (reproduced end-to-end against
 * fixtureAuthSessionDirect, a plain Supabase password login).
 *
 * The precedent doesn't transfer, and the reason is worth stating: an
 * idempotency guard genuinely STRENGTHENS a payment webhook flow, so making
 * it optional is sound. Rotation does not strengthen a refresh flow — it IS
 * the refresh flow. What issue #5's sentence actually describes as the
 * strengthener is invalidation of the OLD token, which is now its own
 * optional kind (see refreshInvalidationHits below).
 */
function refreshRotationHits(path: string, file: ParsedFile, libraryHits: AnchorHit[]): AnchorHit[] {
  if (!file.literals.some((l) => REFRESH_MARKER_LITERALS.has(l.value))) return [];

  const verifyScopes = new Set(
    libraryHits.filter((h) => h.kind === "token-verification").map((h) => h.enclosingFunction)
  );

  return libraryHits
    .filter((h) => h.kind === "session-issuance" && verifyScopes.has(h.enclosingFunction))
    .map((h) => ({
      kind: "refresh-rotation" as AnchorKind,
      path,
      enclosingFunction: h.enclosingFunction,
      line: h.line,
      // Inherits the issuing call's library — a rotation belongs to whichever
      // library minted the token.
      libraryId: h.libraryId,
      reason: `token issuance co-located with a token-verification call in the same scope, in a file carrying a refresh marker literal (${h.reason})`,
    }));
}

// Call-chain last segments that mean "the OLD credential was revoked", not
// merely "a new one was issued". Deliberately a short, distinctive
// allowlist: each of these names an act of destruction/revocation, none is a
// generic verb that shows up incidentally in unrelated code. `delete` and
// `deleteMany` are the ORM shapes for dropping a stored refresh-token row
// (Prisma/Supabase/knex all use one of these); `signOut` is Supabase's own
// session teardown.
const INVALIDATION_SEGMENTS = new Set([
  "revoke",
  "revokeToken",
  "revokeRefreshToken",
  "invalidate",
  "blacklist",
  "signOut",
  "delete",
  "deleteMany",
]);

/**
 * refresh-invalidation — the OPTIONAL strengthener for
 * auth/jwt-refresh-flow, per issue #5: "If rotation/invalidation of the old
 * token is present it strengthens the finding."
 *
 * Gated on the SAME refresh marker literal refreshRotationHits requires, for
 * the same reason: `prisma.session.delete(...)` is an utterly generic call,
 * and only its co-location with refresh-token handling makes it evidence of
 * anything. Without that gate this rule would fire on every ORM delete in
 * every repo.
 *
 * Never a required anchor. Its absence caps auth/jwt-refresh-flow at
 * `inferred`; its presence lets the pattern reach `direct`. A flow that
 * rotates without invalidating is real and provable — it just isn't the same
 * strength of claim as one that also closes the old token out.
 */
function refreshInvalidationHits(path: string, file: ParsedFile): AnchorHit[] {
  if (!file.literals.some((l) => REFRESH_MARKER_LITERALS.has(l.value))) return [];

  const hits: AnchorHit[] = [];
  for (const call of file.calls) {
    const last = call.chain[call.chain.length - 1];
    if (last === undefined || !INVALIDATION_SEGMENTS.has(last)) continue;
    hits.push({
      kind: "refresh-invalidation",
      path,
      enclosingFunction: call.enclosingFunction,
      line: call.line,
      reason: `old-credential revocation: call chain ending ".${last}(...)" in a file carrying a refresh marker literal (chain: ${call.chain.join(".")})`,
    });
  }
  return hits;
}

// -----------------------------------------------------------------------
// findAnchors
// -----------------------------------------------------------------------

function sortHits(hits: AnchorHit[]): AnchorHit[] {
  return [...hits].sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    if (a.line !== b.line) return a.line - b.line;
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    return 0;
  });
}

/**
 * Deterministic anchor recognizer over one ProofGraph (one HEAD snapshot,
 * per the spike's invariants — see docs/proof-graph-spike.md). Same input
 * graph always produces the same (sorted) output array; no randomness, no
 * network, no type-checker.
 */
export function findAnchors(graph: ProofGraph): AnchorHit[] {
  const hits: AnchorHit[] = [];

  for (const path of graph.files()) {
    const file = graph.parsedFile(path);
    if (!file) continue; // defensive; every path from graph.files() has a parsedFile by construction

    hits.push(...webhookHits(graph, path, file));
    hits.push(...iapConfigureAndPurchaseHits(path, file));
    hits.push(...iapEntitlementGateHits(path, file));

    // Auth flows (issue #5). refreshRotationHits derives from the library
    // hits rather than re-walking file.calls — it needs to know which scopes
    // already contain a token-verification hit, which is exactly what
    // authLibraryHits just computed.
    const libraryHits = authLibraryHits(path, file);
    hits.push(...libraryHits);
    hits.push(...refreshRotationHits(path, file, libraryHits));
    hits.push(...refreshInvalidationHits(path, file));
    hits.push(...authGuardHits(path, file));

    // Reads seen so far in each enclosing-function scope of THIS file, in
    // source-position order. file.calls is already sorted by source
    // position (parser-adapter.ts's bySourcePosition), so "already
    // accumulated by the time we reach a write" is equivalent to rule (3)'s
    // "at a LOWER line number" without a second pass over the file.
    const priorReadsByScope = new Map<string | null, { line: number; lastSegment: string }[]>();

    for (const call of file.calls) {
      const isRead = matchDbRead(file, call);
      if (isRead) {
        const arr = priorReadsByScope.get(call.enclosingFunction) ?? [];
        arr.push({ line: call.line, lastSegment: call.chain[call.chain.length - 1] });
        priorReadsByScope.set(call.enclosingFunction, arr);
      }

      const write = matchDbWrite(file, call);
      if (write) {
        hits.push({
          kind: "db-write",
          path,
          enclosingFunction: call.enclosingFunction,
          line: call.line,
          reason: write.reason,
        });

        // Rule (1): an upsert-shaped write is idempotent by construction —
        // deliberately the SAME call producing both a db-write AND an
        // idempotency-guard hit, not a bug (see DbWriteMatch's own
        // comment).
        if (write.upsertShaped) {
          hits.push({
            kind: "idempotency-guard",
            path,
            enclosingFunction: call.enclosingFunction,
            line: call.line,
            reason: `upsert-shaped write is idempotent by construction (${write.reason})`,
          });
        }

        // Rule (3): lookup-before-write.
        const priorReads = priorReadsByScope.get(call.enclosingFunction);
        if (priorReads && priorReads.length > 0) {
          const earliest = priorReads[0]; // pushed in source order -> first is earliest
          hits.push({
            kind: "idempotency-guard",
            path,
            enclosingFunction: call.enclosingFunction,
            line: call.line,
            reason: `lookup-before-write: a read call (chain ending ".${earliest.lastSegment}") at line ${earliest.line} precedes this write in the same function`,
          });
        }
      }

      // Rule (2): explicit idempotency key, package-agnostic — no DB
      // resolution needed at all.
      if (matchExplicitIdempotencyKey(call)) {
        hits.push({
          kind: "idempotency-guard",
          path,
          enclosingFunction: call.enclosingFunction,
          line: call.line,
          reason: 'explicit "idempotencyKey" argument property',
        });
      }
    }
  }

  return sortHits(hits);
}
