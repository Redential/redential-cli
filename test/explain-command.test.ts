// H4 of the proof-graph spike (see docs/proof-graph-spike.md): drives
// executeExplainCommand directly over the H3 fixtures (test/proof-graph/
// fixtures.js) — same harness approach as test/scan-command.test.ts (call
// the command function directly with an injected `log` collector, never
// spawn the built CLI). USER is always passed explicitly via `author`
// (rather than relying on the default `git config user.email` fallback) so
// these tests don't depend on whatever global git config the machine
// running them happens to have — see test/author-preselection.test.ts for
// the same rationale applied to that command's own default-selection tests.
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { executeExplainCommand } from "../src/explain-command.js";
import { ScanError } from "../src/errors.js";
import { cleanup, commit, createRepo } from "./support/fixtures.js";
import {
  USER,
  fixtureCommentsOnly,
  fixtureDirectPattern,
  fixtureIapDirect,
  fixtureLayeredPattern,
  fixtureLemonSqueezyManualHmacDirect,
  fixtureMercadoPagoDirectNoIdempotency,
  fixturePaddleDirect,
  fixturePaypalDirect,
  fixtureStripeUnused,
  fixtureAuthSessionDirect,
  fixtureAuthOauthDirect,
  fixtureAuthJwtRefreshDirect,
  fixtureAuthJwtRefreshWithInvalidation,
} from "./proof-graph/fixtures.js";
import { generateBudgetBustingSourceFiles } from "./proof-graph/scale-fixtures.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) cleanup(dirs.pop()!);
});

function collectLog(): { log: (m: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { log: (m: string) => lines.push(m), lines };
}

describe("executeExplainCommand", () => {
  it("direct fixture: DIRECT classification, the three anchor kinds, the file path, and claimed yes", async () => {
    const dir = fixtureDirectPattern();
    dirs.push(dir);
    const { log, lines } = collectLog();

    await executeExplainCommand({
      repoPath: dir,
      skill: "payments/payment-webhook-flow",
      author: [USER.email],
      log,
    });

    const output = lines.join("\n");
    expect(output).toContain("DIRECT");
    expect(output).toContain("webhook-verification:");
    expect(output).toContain("db-write:");
    expect(output).toContain("idempotency-guard:");
    expect(output).toContain("src/webhook.ts");
    expect(output).toContain("Claimed: yes");
  });

  it("layered fixture: INFERRED classification and the handler -> service -> repo connection chain", async () => {
    const dir = fixtureLayeredPattern();
    dirs.push(dir);
    const { log, lines } = collectLog();

    await executeExplainCommand({
      repoPath: dir,
      skill: "payments/payment-webhook-flow",
      author: [USER.email],
      log,
    });

    const output = lines.join("\n");
    expect(output).toContain("INFERRED");
    const connectionLine = lines.find((l) => l.startsWith("Connection:"))!;
    expect(connectionLine).toContain("src/handler.ts -> src/service.ts -> src/repo.ts");
    expect(output).toContain("Claimed: yes");
  });

  it("stripe-unused fixture: AMBIGUOUS, explicit not-claimed wording, and a why", async () => {
    const dir = fixtureStripeUnused();
    dirs.push(dir);
    const { log, lines } = collectLog();

    await executeExplainCommand({
      repoPath: dir,
      skill: "payments/payment-webhook-flow",
      author: [USER.email],
      log,
    });

    const output = lines.join("\n");
    expect(output).toContain("AMBIGUOUS");
    expect(output).toContain("Claimed: no");
    expect(output).toContain("NOT CLAIMED:");
    expect(output).toContain("never claimed");
    expect(output).toContain("never enter a scan/submit bundle");
    expect(output).toContain("Why:");
  });

  it("unknown slug: a taxonomy.json-citing error, never a stack trace", async () => {
    const dir = fixtureDirectPattern();
    dirs.push(dir);

    await expect(
      executeExplainCommand({
        repoPath: dir,
        skill: "not/a-real-slug",
        author: [USER.email],
      })
    ).rejects.toThrow(ScanError);

    try {
      await executeExplainCommand({ repoPath: dir, skill: "not/a-real-slug", author: [USER.email] });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ScanError);
      expect((err as Error).message).toContain("taxonomy.json");
      expect((err as Error).message).toContain("not/a-real-slug");
    }
  });

  it("a valid but non-structural taxonomy slug: the known-limit message, not a detection attempt", async () => {
    const dir = fixtureDirectPattern();
    dirs.push(dir);

    try {
      await executeExplainCommand({ repoPath: dir, skill: "payments/stripe", author: [USER.email] });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ScanError);
      expect((err as Error).message).toContain("payment-webhook-flow");
      expect((err as Error).message).toContain("spike");
    }
  });

  it("a repo with no structural finding at all: a friendly 'not detected' message", async () => {
    const dir = fixtureCommentsOnly();
    dirs.push(dir);

    try {
      await executeExplainCommand({
        repoPath: dir,
        skill: "payments/payment-webhook-flow",
        author: [USER.email],
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ScanError);
      expect((err as Error).message).toContain("not detected");
    }
  });

  // Boundary pin: `explain` is a read-only diagnostic — it must never write
  // anything anywhere. Two independent checks, per CLAUDE.md's guidance to
  // pick the stronger technique and document it: a static source scan is the
  // STRONGER check (it's exhaustive over every fs-write API the file could
  // call, regardless of which directory a bug might target), so it's the
  // primary assertion; the fixture-directory-listing snapshot is a weaker,
  // secondary integration check (it would only catch a write landing inside
  // this specific repo directory) kept alongside it for defense in depth.
  it("never writes a file: no fs-write API is referenced in explain-command.ts, and a real run doesn't touch the fixture repo's directory listing", async () => {
    const srcUrl = new URL("../src/explain-command.ts", import.meta.url);
    const source = readFileSync(srcUrl, "utf8");
    expect(source).not.toMatch(/writeFileSync|appendFileSync|mkdirSync|createWriteStream|rmSync|writeFile\(/);

    const dir = fixtureDirectPattern();
    dirs.push(dir);
    const before = readdirSync(dir, { recursive: true } as { recursive: true }).sort();

    await executeExplainCommand({
      repoPath: dir,
      skill: "payments/payment-webhook-flow",
      author: [USER.email],
      log: () => {},
    });

    const after = readdirSync(dir, { recursive: true } as { recursive: true }).sort();
    expect(after).toEqual(before);
  });

  it("no --author given: falls back to `git config user.email` (non-interactive), and honestly reports no-commits-found for an identity that matched none", async () => {
    const dir = fixtureDirectPattern();
    dirs.push(dir);
    // Explicit repo-local user.email so this test's outcome doesn't depend
    // on whatever the host machine's own git identity happens to be — an
    // email guaranteed to have zero commits in this fixture (only
    // USER/OTHER ever commit to it).
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["config", "user.email", "not-a-committer@example.com"], { cwd: dir });
    const { log, lines } = collectLog();

    await executeExplainCommand({
      repoPath: dir,
      skill: "payments/payment-webhook-flow",
      author: [],
      log,
    });

    const output = lines.join("\n");
    // The pattern is still DIRECT (detection is independent of attribution),
    // but nothing is claimed for an author identity that matched no commits.
    expect(output).toContain("DIRECT");
    expect(output).toContain("no commits found for not-a-committer@example.com");
    expect(output).toContain("Claimed: no");
  });

  // Quick win #2 (history-dominated repos follow-up — see
  // docs/proof-graph-spike.md's "Scale hardening" -> "History-dominated
  // repos" subsection): --since narrows the commit walk explain's
  // attribution is computed over, without touching detection at all
  // (detection reads the HEAD snapshot, independent of history). Built as a
  // dedicated tmpdir case (rather than reusing fixtureDirectPattern as-is)
  // because this needs explicit commit-date control fixtureDirectPattern's
  // builder doesn't expose.
  describe("--since narrowing", () => {
    it("turns an attributed finding into not-attributed once the window excludes the user's commit, and the window shows up in the output", async () => {
      const dir = createRepo();
      dirs.push(dir);
      commit(dir, {
        message: "add stripe webhook handler",
        authorName: USER.name,
        authorEmail: USER.email,
        authorDate: "2020-01-01T00:00:00Z",
        files: {
          "src/webhook.ts": [
            'import Stripe from "stripe";',
            'import { PrismaClient } from "@prisma/client";',
            "",
            'const stripe = new Stripe("sk_test_xxx-EXAMPLE-xxx");',
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

      // No --since: full history is walked, the commit is in range, and the
      // user's own added-lines diff touched the finding's supporting file.
      const baseline = collectLog();
      await executeExplainCommand({
        repoPath: dir,
        skill: "payments/payment-webhook-flow",
        author: [USER.email],
        log: baseline.log,
      });
      const baselineOutput = baseline.lines.join("\n");
      expect(baselineOutput).toContain("DIRECT");
      expect(baselineOutput).toContain("Claimed: yes");
      expect(baselineOutput).toContain("YES — your own added-lines diff touched");

      // --since 2024-01-01 excludes the (2020) commit entirely — detection
      // stays DIRECT (it's independent of history), but attribution flips:
      // the user has no commits left in the window at all, so nothing can
      // be claimed. The window itself shows up in the attribution line.
      const narrowed = collectLog();
      await executeExplainCommand({
        repoPath: dir,
        skill: "payments/payment-webhook-flow",
        author: [USER.email],
        since: "2024-01-01",
        log: narrowed.log,
      });
      const narrowedOutput = narrowed.lines.join("\n");
      expect(narrowedOutput).toContain("DIRECT");
      expect(narrowedOutput).toContain("Claimed: no");
      expect(narrowedOutput).toContain(`no commits found for ${USER.email}`);
      const attributionLine = narrowed.lines.find((l) => l.startsWith("Attribution"))!;
      expect(attributionLine).toContain("window:");
      expect(attributionLine).toContain("2024-01-01");
    });
  });

  // Scale hardening (see docs/proof-graph-spike.md's "Scale hardening"
  // subsection and src/proof-graph/infer.ts's INFER_WORK_BUDGET /
  // findInferredTriple): when the cross-file search hits its deterministic
  // work budget, `explain` must surface that plainly, not just silently
  // report AMBIGUOUS the same way a genuinely-disconnected pattern would.
  it("search-space-exceeding fixture: AMBIGUOUS, and the work-budget degradation line is printed", async () => {
    const dir = createRepo();
    dirs.push(dir);
    // Reuses the exact same engineered-to-exceed-the-budget generator as
    // test/proof-graph/scale.test.ts's own budget case (130 distinct files
    // per anchor kind, all importing one shared hub — see
    // scale-fixtures.ts's own comment on why that guarantees the full
    // 130^3 = 2,197,000-combination search actually runs, clearing
    // INFER_WORK_BUDGET's 2,000,000).
    commit(dir, {
      message: "add a search-space-exceeding fixture",
      authorName: USER.name,
      authorEmail: USER.email,
      files: generateBudgetBustingSourceFiles({ filesPerKind: 130 }),
    });
    const { log, lines } = collectLog();

    await executeExplainCommand({
      repoPath: dir,
      skill: "payments/payment-webhook-flow",
      author: [USER.email],
      log,
    });

    const output = lines.join("\n");
    expect(output).toContain("AMBIGUOUS");
    expect(output).toContain("Claimed: no");
    expect(output).toContain("exceeded the deterministic work budget");
    expect(output).toContain("degraded to AMBIGUOUS");
  });

  // Live progress (src/proof-graph/progress.ts): wired through this
  // command's pipeline so a real, slow run isn't silent. Two invariants
  // matter here more than the exact phase sequence (progress.test.ts
  // already covers the reporter's own behavior in isolation): (1) zero
  // contamination — enabling progress must never change a single byte of
  // stdout, and every progress byte must land on stderr, never in `log`;
  // (2) zero leakage — no fixture-derived path/function/email ever reaches
  // stderr, only the fixed phase labels and plain numbers.
  describe("live progress", () => {
    it("enabled (isTTY: true): all progress bytes go to stderr (never `log`/stdout), and stdout is byte-identical to a run with progress disabled", async () => {
      const dir = fixtureDirectPattern();
      dirs.push(dir);

      const stderrChunks: string[] = [];
      const withProgress = collectLog();
      await executeExplainCommand({
        repoPath: dir,
        skill: "payments/payment-webhook-flow",
        author: [USER.email],
        log: withProgress.log,
        isTTY: true,
        progressWrite: (chunk) => stderrChunks.push(chunk),
      });

      const withoutProgress = collectLog();
      await executeExplainCommand({
        repoPath: dir,
        skill: "payments/payment-webhook-flow",
        author: [USER.email],
        log: withoutProgress.log,
        isTTY: false,
      });

      // No contamination: stdout (the `log` lines) is identical whether or
      // not progress was shown.
      expect(withProgress.lines).toEqual(withoutProgress.lines);

      // Progress actually happened, and only on stderr.
      expect(stderrChunks.length).toBeGreaterThan(0);
      const stderrOutput = stderrChunks.join("");
      expect(stderrOutput).toContain("Scanning HEAD");
      expect(stderrOutput).toContain("Analyzing structure");

      // No leakage: none of this fixture's own distinctive, git-derived
      // strings (a file path, a function name, the author's own email —
      // the exact kind of thing this command's own stdout output DOES
      // legitimately print, per its SCREEN vs BUNDLE boundary comment)
      // ever reach the progress stream.
      const forbiddenProbes = [
        "src/webhook.ts",
        "webhook.ts",
        "handleWebhook",
        USER.email,
        "stripe",
        "Stripe",
        "constructEvent",
      ];
      for (const probe of forbiddenProbes) {
        expect(stderrOutput).not.toContain(probe);
      }
      // And a strict charset allowlist, independent of the specific probes
      // above (see progress.test.ts's own version of this check for the
      // rationale): every byte is a fixed phase label or a plain number.
      expect(stderrOutput).toMatch(/^[A-Za-z0-9 ./()%\r\n-]*$/);
    });

    it("non-TTY default (no isTTY, no progressWrite given): zero progress bytes reach the real process.stderr", async () => {
      const dir = fixtureDirectPattern();
      dirs.push(dir);
      const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        const { log } = collectLog();
        await executeExplainCommand({
          repoPath: dir,
          skill: "payments/payment-webhook-flow",
          author: [USER.email],
          log,
        });
        expect(writeSpy).not.toHaveBeenCalled();
      } finally {
        writeSpy.mockRestore();
      }
    });
  });

  // Issue #5: `redential explain` must accept the three new auth slugs. No
  // production change was needed for that — explain-command.ts resolves the
  // requested slug against STRUCTURAL_PATTERNS itself and drives its anchor
  // grouping from the matched pattern's own `anchorKinds`, so the auth
  // patterns became explainable the moment they entered that table. These
  // tests exist to PROVE that rather than assume it, one happy path per new
  // slug, mirroring the H6 per-provider tests below.
  describe("auth-flows explain (issue #5)", () => {
    it("session-flow fixture: DIRECT, its own three anchor kinds, claimed yes", async () => {
      const dir = fixtureAuthSessionDirect();
      dirs.push(dir);
      const { log, lines } = collectLog();

      await executeExplainCommand({
        repoPath: dir,
        skill: "auth/session-flow",
        author: [USER.email],
        log,
      });

      const output = lines.join("\n");
      expect(output).toContain("Skill: auth/session-flow");
      expect(output).toContain("DIRECT");
      expect(output).toContain("credential-verification:");
      expect(output).toContain("session-issuance:");
      expect(output).toContain("route-guard:");
      expect(output).toContain("src/session.ts");
      expect(output).toContain("Claimed: yes");
    });

    it("oauth-flow fixture: DIRECT, authorize-redirect + code-exchange + session-issuance, claimed yes", async () => {
      const dir = fixtureAuthOauthDirect();
      dirs.push(dir);
      const { log, lines } = collectLog();

      await executeExplainCommand({
        repoPath: dir,
        skill: "auth/oauth-flow",
        author: [USER.email],
        log,
      });

      const output = lines.join("\n");
      expect(output).toContain("Skill: auth/oauth-flow");
      expect(output).toContain("DIRECT");
      expect(output).toContain("authorize-redirect:");
      expect(output).toContain("code-exchange:");
      expect(output).toContain("session-issuance:");
      expect(output).toContain("Claimed: yes");
    });

    it("jwt-refresh-flow without invalidation: capped at INFERRED with the cap line naming refresh-invalidation", async () => {
      const dir = fixtureAuthJwtRefreshDirect();
      dirs.push(dir);
      const { log, lines } = collectLog();

      await executeExplainCommand({
        repoPath: dir,
        skill: "auth/jwt-refresh-flow",
        author: [USER.email],
        log,
      });

      const output = lines.join("\n");
      expect(output).toContain("Skill: auth/jwt-refresh-flow");
      expect(output).toContain("Classification: INFERRED");
      // The real topology is still same-function — only confidence is
      // capped. This is the FIRST pattern whose optional kind lives OUTSIDE
      // its required triad, so it also exercises that generalization end to
      // end through the explain renderer.
      const connectionLine = lines.find((l) => l.startsWith("Connection:"))!;
      expect(connectionLine).toContain("same-function");
      const capLine = lines.find((l) => l.includes("Note: confidence is capped"))!;
      expect(capLine).toBeDefined();
      expect(capLine).toContain("refresh-invalidation");
      expect(output).toContain("Claimed: yes");
    });

    it("jwt-refresh-flow WITH invalidation: cap lifts to DIRECT and no cap line is printed", async () => {
      const dir = fixtureAuthJwtRefreshWithInvalidation();
      dirs.push(dir);
      const { log, lines } = collectLog();

      await executeExplainCommand({
        repoPath: dir,
        skill: "auth/jwt-refresh-flow",
        author: [USER.email],
        log,
      });

      const output = lines.join("\n");
      expect(output).toContain("Classification: DIRECT");
      expect(lines.find((l) => l.includes("Note: confidence is capped"))).toBeUndefined();
      // refresh-invalidation is deliberately ABSENT from this output, and
      // that is correct on two independent counts: `explain` groups anchors
      // by the matched pattern's own `anchorKinds` (which it is not a member
      // of), and the finding's supporting anchors are the triple the search
      // returned (which it is not part of either). Its only observable
      // effect is the one asserted above — the cap lifting, so the same
      // fixture-minus-invalidation reaches INFERRED and this one reaches
      // DIRECT.
      expect(output).toContain("token-verification:");
      expect(output).toContain("refresh-rotation:");
      expect(output).toContain("guard-response:");
    });
  });

  // H6 phase 2c: `explain` now covers all 6 STRUCTURAL_PATTERNS entries
  // (src/proof-graph/infer.ts), not just the original Stripe pattern — one
  // happy-path test per NEW provider added in H6 phase 2a/2b, over the H6
  // phase 2b fixtures (test/proof-graph/fixtures.ts), plus the
  // known-limit-message test updated for the now-6-entry table.
  describe("H6 multi-provider explain", () => {
    it("paypal fixture: DIRECT classification, its own anchor kinds, and claimed yes", async () => {
      const dir = fixturePaypalDirect();
      dirs.push(dir);
      const { log, lines } = collectLog();

      await executeExplainCommand({
        repoPath: dir,
        skill: "payments/paypal-webhook-flow",
        author: [USER.email],
        log,
      });

      const output = lines.join("\n");
      expect(output).toContain("Skill: payments/paypal-webhook-flow");
      expect(output).toContain("DIRECT");
      expect(output).toContain("webhook-verification:");
      expect(output).toContain("db-write:");
      expect(output).toContain("idempotency-guard:");
      expect(output).toContain("src/webhook.ts");
      expect(output).toContain("Claimed: yes");
    });

    it("mercadopago fixture (no idempotency guard anywhere): confidence capped at INFERRED, not DIRECT, with the cap explanation line", async () => {
      const dir = fixtureMercadoPagoDirectNoIdempotency();
      dirs.push(dir);
      const { log, lines } = collectLog();

      await executeExplainCommand({
        repoPath: dir,
        skill: "payments/mercadopago-flow",
        author: [USER.email],
        log,
      });

      const output = lines.join("\n");
      expect(output).toContain("Skill: payments/mercadopago-flow");
      expect(output).toContain("Classification: INFERRED");
      // The connection itself is still same-function (the creation call and
      // the DB write ARE co-located) — only the confidence is capped, per
      // StructuralPattern.optionalAnchorKinds' own comment in infer.ts.
      const connectionLine = lines.find((l) => l.startsWith("Connection:"))!;
      expect(connectionLine).toContain("same-function");
      const capLine = lines.find((l) => l.includes("Note: confidence is capped"))!;
      expect(capLine).toBeDefined();
      expect(capLine).toContain("capped at INFERRED, not DIRECT");
      expect(capLine).toContain("idempotency-guard");
      expect(capLine).toContain("missing everywhere in this repository");
      expect(output).toContain("Claimed: yes");
    });

    it("lemon squeezy manual-HMAC fixture: DIRECT classification and claimed yes", async () => {
      const dir = fixtureLemonSqueezyManualHmacDirect();
      dirs.push(dir);
      const { log, lines } = collectLog();

      await executeExplainCommand({
        repoPath: dir,
        skill: "payments/lemonsqueezy-webhook-flow",
        author: [USER.email],
        log,
      });

      const output = lines.join("\n");
      expect(output).toContain("Skill: payments/lemonsqueezy-webhook-flow");
      expect(output).toContain("DIRECT");
      expect(output).toContain("webhook-verification:");
      expect(output).toContain("manual HMAC verification");
      expect(output).toContain("Claimed: yes");
    });

    it("paddle fixture: DIRECT classification and claimed yes", async () => {
      const dir = fixturePaddleDirect();
      dirs.push(dir);
      const { log, lines } = collectLog();

      await executeExplainCommand({
        repoPath: dir,
        skill: "payments/paddle-webhook-flow",
        author: [USER.email],
        log,
      });

      const output = lines.join("\n");
      expect(output).toContain("Skill: payments/paddle-webhook-flow");
      expect(output).toContain("DIRECT");
      expect(output).toContain("webhook-verification:");
      expect(output).toContain("db-write:");
      expect(output).toContain("idempotency-guard:");
      expect(output).toContain("Claimed: yes");
    });

    it("iap fixture: DIRECT classification, its own iap-configure/iap-purchase/iap-entitlement-gate anchor kinds (not webhook/db-write/idempotency), and claimed yes", async () => {
      const dir = fixtureIapDirect();
      dirs.push(dir);
      const { log, lines } = collectLog();

      await executeExplainCommand({
        repoPath: dir,
        skill: "payments/iap-subscription-flow",
        author: [USER.email],
        log,
      });

      const output = lines.join("\n");
      expect(output).toContain("Skill: payments/iap-subscription-flow");
      expect(output).toContain("DIRECT");
      expect(output).toContain("iap-configure:");
      expect(output).toContain("iap-purchase:");
      expect(output).toContain("iap-entitlement-gate:");
      // iap-flow has no webhook/db-write/idempotency node at all (see
      // anchors.ts's IAP section comment) — these must never appear.
      expect(output).not.toContain("webhook-verification:");
      expect(output).not.toContain("db-write:");
      expect(output).not.toContain("idempotency-guard:");
      expect(output).toContain("src/purchases.ts");
      expect(output).toContain("Claimed: yes");
    });

    it("a valid but non-structural taxonomy slug: the known-limit message lists all 6 explainable slugs", async () => {
      const dir = fixtureDirectPattern();
      dirs.push(dir);

      try {
        await executeExplainCommand({ repoPath: dir, skill: "payments/stripe", author: [USER.email] });
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(ScanError);
        const message = (err as Error).message;
        expect(message).toContain("payments/payment-webhook-flow");
        expect(message).toContain("payments/paypal-webhook-flow");
        expect(message).toContain("payments/mercadopago-flow");
        expect(message).toContain("payments/lemonsqueezy-webhook-flow");
        expect(message).toContain("payments/paddle-webhook-flow");
        expect(message).toContain("payments/iap-subscription-flow");
      }
    });
  });
});
