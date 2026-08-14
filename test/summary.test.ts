import { describe, expect, it } from "vitest";
import { formatConsentSummary, formatSummary, shouldUsePlainOutput } from "../src/summary.js";
import type { Bundle } from "../src/types.js";

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

function baseBundle(overrides: Partial<Bundle> = {}): Bundle {
  return {
    schema_version: "1.1.0",
    runner: "local",
    tool_version: "0.1.0",
    created_at: "2026-07-09T00:00:00.000Z",
    repo: { host_type: "github", age_days: 900, repo_fingerprint: "deadbeef" },
    identity: { author_identity_hashes: ["abc123"], other_contributors_count: 2 },
    commits: {
      user_total: 1847,
      first_at: "2024-01-01T00:00:00.000Z",
      last_at: "2026-07-01T00:00:00.000Z",
      span_days: 912,
      hour_histogram: [
        1, 0, 0, 0, 0, 2, 5, 10, 20, 30, 25, 15, 10, 8, 6, 4, 3, 2, 1, 1, 0, 0, 0, 0,
      ],
      weekday_histogram: [5, 40, 38, 42, 39, 30, 6],
    },
    signed: { count: 830, ratio: 0.45 },
    languages: [
      { extension: ".ts", share: 0.62 },
      { extension: ".json", share: 0.2 },
      { extension: ".md", share: 0.18 },
    ],
    categories: [
      { name: "backend", commit_count: 120, churn_share: 0.4 },
      { name: "testing", commit_count: 80, churn_share: 0.35 },
      { name: "docs", commit_count: 20, churn_share: 0.25 },
    ],
    detected_skills: [
      { slug: "ai/anthropic-api", commit_count: 14, first_seen: "2024-02-01", last_seen: "2026-06-01" },
      { slug: "auth/clerk", commit_count: 6, first_seen: "2024-03-01", last_seen: "2025-01-01" },
    ],
    ownership: { user_commit_ratio: 0.78 },
    integrity: {
      merkle_root: "0".repeat(64),
      algorithm: "sha256",
      date_forensics: { author_span_days: 900, committer_span_days: 895, mismatch_ratio: 0.05, committer_burst_ratio: 0.03 },
    },
    attestation: { authorized_confirmation: true, confirmed_at: "2026-07-09T00:00:00.000Z" },
    ...overrides,
  };
}

describe("formatSummary", () => {
  it("includes span, commit count, ownership, and the single closing line", () => {
    const text = stripAnsi(formatSummary(baseBundle()));
    // Phase 2 header line: "<span> · <commits> authored commits · <ownership>%
    // ownership" — replaces the old "<span>, <commits> commits" line, folding
    // the ownership figure (previously only in the footer block) up top too.
    expect(text).toContain("2 years · 1,847 authored commits · 78% ownership");
    // Owner follow-up (2026-08): the closing block shrank to exactly one
    // line — no more repeated privacy paragraph/jargon, no --json/--details
    // footer hints (moved to docs/scan.md), no textual next-step CTA (moved
    // to a live post-scan prompt in scan-command.ts).
    expect(text).toContain("Nothing was uploaded. You choose what gets sent. github.com/Redential/redential-cli");
  });

  it("opens with the header title and ends with the single closing line — nothing else after it", () => {
    const text = formatSummary(baseBundle());
    const lines = text.split("\n");
    expect(stripAnsi(lines[0])).toContain("PRIVATE WORK, LOCALLY DERIVED");
    const lastNonEmptyLine = stripAnsi(lines.filter((l) => l.trim() !== "").at(-1)!);
    expect(lastNonEmptyLine).toContain("Nothing was uploaded. You choose what gets sent.");
  });

  it("does not mention signed commits below the Signed commits line (tip relocated to post-submit — see submit-command.ts)", () => {
    const text = stripAnsi(formatSummary(baseBundle({ signed: { count: 0, ratio: 0 } })));
    expect(text).not.toContain("Tip: none of your commits are signed.");
  });

  it("omits the COMMITS BY HOUR/WEEKDAY histogram sections by default (moved behind --details in phase 2)", () => {
    const text = stripAnsi(formatSummary(baseBundle()));
    expect(text).not.toContain("COMMITS BY HOUR");
    expect(text).not.toContain("COMMITS BY WEEKDAY");
  });

  it("with { details: true }, renders a 24-wide hour-of-day sparkline and all 7 weekday labels", () => {
    const text = stripAnsi(formatSummary(baseBundle(), { details: true }));
    expect(text).toContain("COMMITS BY HOUR");
    expect(text).toContain("COMMITS BY WEEKDAY");
    for (const day of ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]) {
      expect(text).toContain(day);
    }
    const hourLine = text
      .split("\n")
      .find((line) => /[·▁▂▃▄▅▆▇█]{24}/.test(line.trim()));
    expect(hourLine).toBeDefined();
  });

  it("renders top languages, and humanized (never lowercase) top categories, with percentages", () => {
    const text = stripAnsi(formatSummary(baseBundle()));
    expect(text).toContain(".ts");
    expect(text).toContain("62%");
    // Humanized category label ("backend" -> "Backend"), and the old
    // "(N commits)" suffix is gone per the phase-2 layout (percentage only).
    expect(text).toContain("Backend");
    expect(text).toContain("40%");
    expect(text).not.toContain("(120 commits)");
  });

  it("hides the 'other' category and any category under 2% churn share", () => {
    const bundle = baseBundle({
      categories: [
        { name: "backend", commit_count: 120, churn_share: 0.5 },
        { name: "other", commit_count: 50, churn_share: 0.4 },
        { name: "docs", commit_count: 2, churn_share: 0.01 },
      ],
    });
    const text = stripAnsi(formatSummary(bundle));
    // Isolate the TOP CATEGORIES section (the footer's fixed disclaimer
    // text legitimately contains the word "other" — "...or other
    // contributors." — so a whole-output substring check would false-fail).
    const lines = text.split("\n");
    const start = lines.findIndex((l) => l.includes("TOP CATEGORIES"));
    const end = lines.findIndex((l, i) => i > start && l.trim() === "");
    const categoriesBlock = lines.slice(start, end).join("\n");
    expect(categoriesBlock).toContain("Backend");
    expect(categoriesBlock).not.toContain("Other");
    expect(categoriesBlock).not.toMatch(/\bother\b/i);
    expect(categoriesBlock).not.toContain("Docs");
  });

  it("renders detected capabilities under CAPABILITIES DETECTED with human labels (never raw slugs), grouped by taxonomy slug prefix, with commit counts", () => {
    const text = stripAnsi(formatSummary(baseBundle()));
    expect(text).toContain("CAPABILITIES DETECTED");
    // Group headers, humanized from the slug prefix.
    expect(text).toContain("AI");
    expect(text).toContain("Authentication");
    // Human labels from taxonomy.json, not the raw slugs.
    expect(text).toContain("Anthropic API");
    expect(text).toContain("14 commits");
    expect(text).toContain("Clerk");
    expect(text).toContain("6 commits");
    expect(text).not.toContain("ai/anthropic-api");
    expect(text).not.toContain("auth/clerk");
  });

  it("orders capability groups by total commit count descending, and entries within a group by commit count descending, capped at 4 with an honest '+N more'", () => {
    const bundle = baseBundle({
      detected_skills: [
        { slug: "frontend/react", commit_count: 5, first_seen: "2024-01-01", last_seen: "2024-01-01" },
        { slug: "frontend/nextjs", commit_count: 50, first_seen: "2024-01-01", last_seen: "2024-01-01" },
        { slug: "frontend/tailwind", commit_count: 40, first_seen: "2024-01-01", last_seen: "2024-01-01" },
        { slug: "frontend/svelte", commit_count: 30, first_seen: "2024-01-01", last_seen: "2024-01-01" },
        { slug: "frontend/astro", commit_count: 20, first_seen: "2024-01-01", last_seen: "2024-01-01" },
        { slug: "auth/clerk", commit_count: 3, first_seen: "2024-01-01", last_seen: "2024-01-01" },
      ],
    });
    const text = stripAnsi(formatSummary(bundle));
    const frontendIdx = text.indexOf("Frontend");
    const authIdx = text.indexOf("Authentication");
    // Frontend's total (145) beats Authentication's (3) — Frontend first.
    expect(frontendIdx).toBeGreaterThan(-1);
    expect(authIdx).toBeGreaterThan(frontendIdx);
    // 5 frontend skills detected (React at 5 commits is the lowest and the
    // one left out), only 4 shown, honestly marked.
    expect(text).toContain("+1 more");
    expect(text).not.toContain("React");
    // Highest-commit shown entry (Next.js, 50) appears before the lowest
    // shown one (Astro, 20) — sorted descending within the group.
    expect(text.indexOf("Next.js")).toBeLessThan(text.indexOf("Astro"));
  });

  it("falls back to the bare slug (grouped under its own prefix) for a slug with no taxonomy.json label", () => {
    const bundle = baseBundle({
      detected_skills: [
        { slug: "made-up/not-a-real-slug", commit_count: 4, first_seen: "2024-01-01", last_seen: "2024-01-01" },
      ],
    });
    const text = stripAnsi(formatSummary(bundle));
    expect(text).toContain("Made-up");
    expect(text).toContain("made-up/not-a-real-slug");
  });

  it("falls back to teaser copy when detected_skills is empty, without throwing", () => {
    const text = stripAnsi(formatSummary(baseBundle({ detected_skills: [] })));
    expect(text).toContain("No signatures matched");
  });

  it("falls back to teaser copy when languages/categories are empty, without throwing", () => {
    const text = stripAnsi(formatSummary(baseBundle({ languages: [], categories: [] })));
    expect(text).toContain("No language data");
    expect(text).toContain("No category data yet");
  });

  it("does not throw on an all-zero histogram (single commit, no churn), including under --details", () => {
    const bundle = baseBundle({
      commits: {
        user_total: 1,
        first_at: "2026-07-09T00:00:00.000Z",
        last_at: "2026-07-09T00:00:00.000Z",
        span_days: 0,
        hour_histogram: new Array(24).fill(0),
        weekday_histogram: [0, 1, 0, 0, 0, 0, 0],
      },
      languages: [],
      categories: [],
      detected_skills: [],
    });
    expect(() => formatSummary(bundle, { details: true })).not.toThrow();
    const text = stripAnsi(formatSummary(bundle, { details: true }));
    expect(text).toContain("a single day");
  });

  it("never contains raw JSON braces from the bundle itself", () => {
    const text = formatSummary(baseBundle());
    expect(text).not.toContain("{");
    expect(text).not.toContain("}");
  });

  it("plain mode ({ plain: true }) is pure printable ASCII — no ANSI escapes, no Unicode", () => {
    const text = formatSummary(baseBundle(), { plain: true, details: true });
    // eslint-disable-next-line no-control-regex
    expect(text).toMatch(/^[\x20-\x7e\n]*$/);
  });

  it("plain mode still renders the same data (span/commits/ownership, capability labels)", () => {
    const text = formatSummary(baseBundle(), { plain: true });
    expect(text).toContain("2 years - 1,847 authored commits - 78% ownership");
    expect(text).toContain("Anthropic API");
  });

  it("rich mode (default) contains ANSI escapes and Unicode block/box-drawing characters", () => {
    const text = formatSummary(baseBundle());
    // eslint-disable-next-line no-control-regex
    expect(text).toMatch(/\x1b\[[0-9;]*m/);
    expect(text).toContain("█");
  });

  // Owner follow-up (2026-08): the --json/--details footer hints, the
  // repeated privacy paragraph, and the textual next-step CTA are all gone
  // from the terminal output — replaced by the single closing line above.
  // `redential scan --json`/`--details` are documented in `--help` and
  // docs/scan.md instead (docs/scan.md's "How it works"/"The summary"
  // sections); the next-step CTA is now a live post-scan prompt
  // (scan-command.ts), not text inside this function at all — so
  // `FormatSummaryOptions` no longer has session-state fields to test here.
  it("never mentions the old --json/--details footer hints or the textual next-step CTA", () => {
    const text = stripAnsi(formatSummary(baseBundle()));
    expect(text).not.toContain("Inspect the exact payload");
    expect(text).not.toContain("More detail (hour/weekday histograms)");
    expect(text).not.toContain("Add this private work to your public Redential profile");
    expect(text).not.toContain("redential login && redential submit");
  });

  it("never says 'verifiable profile' (forbidden phrasing, historical regression guard)", () => {
    const text = stripAnsi(formatSummary(baseBundle()));
    expect(text).not.toContain("verifiable profile");
  });

  it("plain mode's closing line stays pure printable ASCII", () => {
    const text = formatSummary(baseBundle(), { plain: true });
    // eslint-disable-next-line no-control-regex
    expect(text).toMatch(/^[\x20-\x7e\n]*$/);
    expect(text).toContain("Nothing was uploaded. You choose what gets sent.");
  });

  // Phase 2 note: the old, separate "STRUCTURAL EVIDENCE (proof graph)"
  // section (with a per-slug "-> full local evidence: redential explain
  // <slug>" pointer line) is REMOVED per the owner-approved layout — the
  // exact approved output has no such section, only the CAPABILITIES
  // DETECTED flagship rows below. The core guarantee (a structural finding
  // is visibly, distinctly called out, listed first, before any grouped
  // capability) is preserved and, if anything, strengthened: it's now
  // impossible to miss, right at the top of the one capabilities section
  // instead of a second section a user could scroll past. `redential
  // explain <slug>` itself is unchanged and still documented elsewhere
  // (README, docs/proof-graph-spike.md) — only this summary's own pointer
  // line to it is gone.
  describe("structural evidence (proof graph) — CAPABILITIES DETECTED tag", () => {
    it("renders a STRUCTURAL · DIRECT tag on a structural/direct capability, listed FIRST (human label, not the slug)", () => {
      const bundle = baseBundle({
        detected_skills: [
          {
            slug: "payments/payment-webhook-flow",
            commit_count: 5,
            first_seen: "2024-01-01",
            last_seen: "2024-06-01",
            evidence: "structural",
            confidence: "direct",
          },
          { slug: "auth/clerk", commit_count: 3, first_seen: "2024-01-01", last_seen: "2024-01-01" },
        ],
      });
      const text = stripAnsi(formatSummary(bundle));
      expect(text).toContain("STRUCTURAL · DIRECT");
      expect(text).toContain("Payment webhook flow");
      expect(text).not.toContain("payments/payment-webhook-flow");
      // The ordinary import-tier skill gets no tag at all.
      const clerkLine = text.split("\n").find((l) => l.includes("Clerk"));
      expect(clerkLine).toBeDefined();
      expect(clerkLine).not.toContain("STRUCTURAL");
      // Structural entry appears before any grouped section.
      const structuralIdx = text.indexOf("Payment webhook flow");
      const groupIdx = text.indexOf("Authentication");
      expect(structuralIdx).toBeGreaterThan(-1);
      expect(groupIdx).toBeGreaterThan(structuralIdx);
    });

    it("renders a STRUCTURAL · INFERRED tag for a structural/inferred capability", () => {
      const bundle = baseBundle({
        detected_skills: [
          {
            slug: "payments/payment-webhook-flow",
            commit_count: 5,
            first_seen: "2024-01-01",
            last_seen: "2024-06-01",
            evidence: "structural",
            confidence: "inferred",
          },
        ],
      });
      const text = stripAnsi(formatSummary(bundle));
      expect(text).toContain("STRUCTURAL · INFERRED");
      expect(text).not.toContain("STRUCTURAL · DIRECT");
    });

    it("with multiple structural skills, all are listed first, sorted by commit count descending, never duplicated in a group below", () => {
      const bundle = baseBundle({
        detected_skills: [
          {
            slug: "payments/payment-webhook-flow",
            commit_count: 9,
            first_seen: "2024-01-01",
            last_seen: "2024-06-01",
            evidence: "structural",
            confidence: "direct",
          },
          {
            slug: "payments/paypal-webhook-flow",
            commit_count: 20,
            first_seen: "2024-01-01",
            last_seen: "2024-06-01",
            evidence: "structural",
            confidence: "inferred",
          },
          { slug: "auth/clerk", commit_count: 3, first_seen: "2024-01-01", last_seen: "2024-01-01" },
        ],
      });
      const text = stripAnsi(formatSummary(bundle));
      // Higher commit count (PayPal, 20) listed before the lower one (5, 9).
      expect(text.indexOf("PayPal webhook flow")).toBeLessThan(text.indexOf("Payment webhook flow"));
      // Neither structural label reappears a second time under a "Payments"
      // group further down — they're pulled out entirely, not duplicated.
      const paymentsGroupHeaderCount = text.split("\n").filter((l) => l.trim() === "Payments").length;
      expect(paymentsGroupHeaderCount).toBe(0);
    });

    it("no structural entries: renders no STRUCTURAL tag anywhere (regression — silent, not an empty section)", () => {
      const text = stripAnsi(formatSummary(baseBundle()));
      expect(text).not.toContain("STRUCTURAL");
    });

    it("plain mode uses the ASCII dot substitute in the tag (no ⚡/· glyphs) and stays pure printable ASCII", () => {
      const bundle = baseBundle({
        detected_skills: [
          {
            slug: "payments/payment-webhook-flow",
            commit_count: 5,
            first_seen: "2024-01-01",
            last_seen: "2024-06-01",
            evidence: "structural",
            confidence: "direct",
          },
        ],
      });
      const text = formatSummary(bundle, { plain: true });
      // eslint-disable-next-line no-control-regex
      expect(text).toMatch(/^[\x20-\x7e\n]*$/);
      expect(text).toContain("STRUCTURAL - DIRECT");
    });

    it("column alignment: the padded label/commit-count columns are unaffected by the trailing tag", () => {
      const bundle = baseBundle({
        detected_skills: [
          {
            slug: "payments/payment-webhook-flow",
            commit_count: 5,
            first_seen: "2024-01-01",
            last_seen: "2024-06-01",
            evidence: "structural",
            confidence: "direct",
          },
          { slug: "ai/anthropic-api", commit_count: 3, first_seen: "2024-01-01", last_seen: "2024-01-01" },
        ],
      });
      const text = stripAnsi(formatSummary(bundle));
      // The structural row and the (shorter) "Anthropic API" grouped row
      // share one label-width computation — both pad out before their own
      // commit-count column starts.
      expect(text).toContain("Payment webhook flow  ");
      expect(text).toMatch(/Anthropic API\s{2,}3 commits/);
    });
  });

  // Regression coverage for two cosmetic bugs found in a real-world scan
  // summary: (1) capability/header lines always said "N commits" even for
  // N === 1 ("1 commits"); (2) the commit-count column drifted out of line
  // whenever one capability label was longer than others, because the old
  // label-width computation didn't correctly account for the extra 2-space
  // indent on grouped rows relative to structural rows.
  describe("commit-count pluralization and column alignment (bugfix)", () => {
    it("pluralizes capability commit counts: singular '1 commit', plural 'N commits'", () => {
      const bundle = baseBundle({
        detected_skills: [
          { slug: "auth/clerk", commit_count: 1, first_seen: "2024-01-01", last_seen: "2024-01-01" },
          { slug: "ai/anthropic-api", commit_count: 2, first_seen: "2024-01-01", last_seen: "2024-01-01" },
        ],
      });
      const text = stripAnsi(formatSummary(bundle));
      expect(text).toContain("1 commit");
      expect(text).not.toContain("1 commits");
      expect(text).toContain("2 commits");
    });

    it("pluralizes a structural-evidence capability's commit count too: singular '1 commit'", () => {
      const bundle = baseBundle({
        detected_skills: [
          {
            slug: "payments/payment-webhook-flow",
            commit_count: 1,
            first_seen: "2024-01-01",
            last_seen: "2024-01-01",
            evidence: "structural",
            confidence: "direct",
          },
        ],
      });
      const text = stripAnsi(formatSummary(bundle));
      expect(text).toContain("1 commit");
      expect(text).not.toContain("1 commits");
    });

    it("pluralizes the header's authored-commit count: singular '1 authored commit', never '1 authored commits'", () => {
      const bundle = baseBundle({
        commits: {
          user_total: 1,
          first_at: "2026-07-09T00:00:00.000Z",
          last_at: "2026-07-09T00:00:00.000Z",
          span_days: 0,
          hour_histogram: new Array(24).fill(0),
          weekday_histogram: [0, 1, 0, 0, 0, 0, 0],
        },
      });
      const text = stripAnsi(formatSummary(bundle));
      expect(text).toContain("1 authored commit ");
      expect(text).not.toContain("1 authored commits");
    });

    it("keeps the plural header phrasing for N > 1 (no regression)", () => {
      const text = stripAnsi(formatSummary(baseBundle()));
      expect(text).toContain("1,847 authored commits");
    });

    it("aligns commit-count columns GLOBALLY across different capability groups — a long label in one group must not push its own row's count column out of line with a short label in a different group", () => {
      const bundle = baseBundle({
        detected_skills: [
          // Real taxonomy.json labels: a long one ("frontend" group) and a
          // short one ("auth" group) — each the sole entry in its own group,
          // so a per-group (rather than global) width computation would
          // wrongly align them independently instead of sharing one column.
          { slug: "frontend/tca", commit_count: 12, first_seen: "2024-01-01", last_seen: "2024-01-01" },
          { slug: "auth/clerk", commit_count: 3, first_seen: "2024-01-01", last_seen: "2024-01-01" },
        ],
      });
      const text = stripAnsi(formatSummary(bundle));
      const lines = text.split("\n");
      const longLine = lines.find((l) => l.includes("The Composable Architecture (Swift)"));
      const shortLine = lines.find((l) => l.includes("Clerk"));
      expect(longLine).toBeDefined();
      expect(shortLine).toBeDefined();
      expect(longLine!.indexOf("commit")).toBe(shortLine!.indexOf("commit"));
    });

    it("aligns commit-count columns WITHIN a group when one label is much longer than another (real-world repro: 'Supabase (Postgres client)' vs 'Prisma ORM', both under Databases)", () => {
      const bundle = baseBundle({
        detected_skills: [
          { slug: "db/supabase", commit_count: 104, first_seen: "2024-01-01", last_seen: "2024-01-01" },
          { slug: "db/prisma", commit_count: 3, first_seen: "2024-01-01", last_seen: "2024-01-01" },
        ],
      });
      const text = stripAnsi(formatSummary(bundle));
      const lines = text.split("\n");
      const supabaseLine = lines.find((l) => l.includes("Supabase (Postgres client)"));
      const prismaLine = lines.find((l) => l.includes("Prisma ORM"));
      expect(supabaseLine).toBeDefined();
      expect(prismaLine).toBeDefined();
      expect(supabaseLine!.indexOf("commit")).toBe(prismaLine!.indexOf("commit"));
    });
  });
});

describe("formatConsentSummary", () => {
  it("derives commit count and humanized span from the bundle", () => {
    const text = stripAnsi(formatConsentSummary(baseBundle(), { command: "submit" }));
    expect(text).toContain("1,847 commits spanning 2 years");
  });

  it("pluralizes the commit-count line: singular '1 commit spanning', never '1 commits spanning'", () => {
    const bundle = baseBundle({
      commits: {
        user_total: 1,
        first_at: "2026-07-09T00:00:00.000Z",
        last_at: "2026-07-09T00:00:00.000Z",
        span_days: 0,
        hour_histogram: new Array(24).fill(0),
        weekday_histogram: [0, 1, 0, 0, 0, 0, 0],
      },
    });
    const text = stripAnsi(formatConsentSummary(bundle, { command: "submit" }));
    expect(text).toContain("1 commit spanning");
    expect(text).not.toContain("1 commits spanning");
  });

  it("derives detected-skill count and top-3 HUMAN LABELS (sorted by commit_count desc) from the bundle, never raw slugs", () => {
    const bundle = baseBundle({
      detected_skills: [
        { slug: "auth/clerk", commit_count: 1, first_seen: "2024-01-01", last_seen: "2024-01-01" },
        { slug: "payments/stripe", commit_count: 100, first_seen: "2024-01-01", last_seen: "2024-01-01" },
        { slug: "db/postgres", commit_count: 50, first_seen: "2024-01-01", last_seen: "2024-01-01" },
        { slug: "ai/openai-api", commit_count: 10, first_seen: "2024-01-01", last_seen: "2024-01-01" },
      ],
    });
    const text = stripAnsi(formatConsentSummary(bundle, { command: "submit" }));
    // Human labels ("Stripe", "PostgreSQL"), not slugs. Only 2 of the top 3
    // labels fit the 60-char box at this length ("OpenAI API" would push it
    // over), so the box's own width-safety logic (buildSkillsLine, see the
    // dedicated width-safety tests below) drops to 2 and honestly folds the
    // rest — including the untruncated 3rd-ranked label — into "+2 more"
    // rather than silently dropping or truncating anything.
    expect(text).toContain("4 detected skills (top: Stripe, PostgreSQL, +2 more)");
    expect(text).not.toContain("payments/stripe");
    expect(text).not.toContain("db/postgres");
    expect(text).not.toContain("Clerk");
  });

  it("falls back to the bare slug for a slug with no taxonomy.json label (defensive — never invents a label)", () => {
    const bundle = baseBundle({
      detected_skills: [
        { slug: "not-a-real-taxonomy-slug", commit_count: 5, first_seen: "2024-01-01", last_seen: "2024-01-01" },
      ],
    });
    const text = stripAnsi(formatConsentSummary(bundle, { command: "submit" }));
    expect(text).toContain("not-a-real-taxonomy-slug");
  });

  it("drops the \"top:\" clause and shows 0 when there are no detected skills", () => {
    const text = stripAnsi(formatConsentSummary(baseBundle({ detected_skills: [] }), { command: "submit" }));
    expect(text).toContain("0 detected skills");
    expect(text).not.toContain("top:");
  });

  it("lists all items that are NEVER uploaded", () => {
    const text = stripAnsi(formatConsentSummary(baseBundle(), { command: "submit" }));
    expect(text).toContain("NEVER uploaded");
    expect(text).toContain("source code");
    expect(text).toContain("file names");
    expect(text).toContain("commit messages");
    expect(text).toContain("repo's name");
    expect(text).toContain("other contributors' identities");
  });

  it("mentions aggregated time patterns/languages/categories and salted fingerprints", () => {
    const text = stripAnsi(formatConsentSummary(baseBundle(), { command: "submit" }));
    expect(text).toContain("time patterns, languages and categories as aggregates");
    expect(text).toContain("salted fingerprints");
    expect(text).not.toContain("your identity");
  });

  it("scan phrasing says the upload WOULD happen; submit phrasing says it DOES", () => {
    const scanText = stripAnsi(formatConsentSummary(baseBundle(), { command: "scan" }));
    const submitText = stripAnsi(formatConsentSummary(baseBundle(), { command: "submit" }));
    expect(scanText).toContain("WHAT WOULD GET UPLOADED");
    expect(submitText).toContain("WHAT GETS UPLOADED");
    expect(submitText).not.toContain("WOULD");
  });

  it("plain mode is pure printable ASCII — no ANSI escapes, no Unicode box-drawing or bullet", () => {
    const text = formatConsentSummary(baseBundle(), { command: "submit", plain: true });
    // eslint-disable-next-line no-control-regex
    expect(text).toMatch(/^[\x20-\x7e\n]*$/);
    expect(text).not.toContain("╔");
    expect(text).not.toContain("•");
  });

  it("rich mode (default) contains ANSI escapes and Unicode box-drawing", () => {
    const text = formatConsentSummary(baseBundle(), { command: "submit" });
    // eslint-disable-next-line no-control-regex
    expect(text).toMatch(/\x1b\[[0-9;]*m/);
    expect(text).toContain("╔");
    expect(text).toContain("•");
  });

  it("never contains raw JSON braces from the bundle itself", () => {
    const text = formatConsentSummary(baseBundle(), { command: "submit" });
    expect(text).not.toContain("{");
    expect(text).not.toContain("}");
  });

  describe("top-skills line width safety (real, long taxonomy labels)", () => {
    // Real taxonomy.json entries whose LABELS (not slugs) are still long
    // enough to matter for width safety: "OpenTelemetry" and "Cloudflare
    // Workers" are genuine labels; the third slug is deliberately NOT a
    // real taxonomy entry, so it falls back to the bare (long) slug itself
    // — covering both the labeled and the fallback-to-slug width case in
    // one fixture.
    const LONG_SLUGS = ["observability/opentelemetry", "infra/cloudflare-workers", "data/elasticsearch-dsl"];
    const LONG_LABELS = ["OpenTelemetry", "Cloudflare Workers", "data/elasticsearch-dsl"];
    const BOX_WIDTH = 60;

    /**
     * Strips the box's 2-space left margin and the border char on both
     * ends (any of ╔/╚/║ rich or +/| plain), then trims trailing padding
     * spaces — leaving just the row's actual visible content, whatever its
     * length, so it can be checked against BOX_WIDTH directly.
     */
    function boxRowContent(line: string): string {
      return line.replace(/^ {2}[╔╚║+|]/, "").replace(/[╗╝║+|]$/, "").trimEnd();
    }

    it("keeps every rendered line's own content within the 60-char box width, never truncates an entry mid-word, and always closes the paren", () => {
      const bundle = baseBundle({
        detected_skills: LONG_SLUGS.map((slug, i) => ({
          slug,
          commit_count: 10 - i,
          first_seen: "2024-01-01",
          last_seen: "2024-01-01",
        })),
      });
      const text = stripAnsi(formatConsentSummary(bundle, { command: "submit" }));
      const lines = text.split("\n");

      // (a) no row's own content — border chars/margin stripped, trailing
      // padding stripped — exceeds the 60-char box width.
      for (const line of lines) {
        expect(boxRowContent(line).length).toBeLessThanOrEqual(BOX_WIDTH);
      }

      const skillsLine = boxRowContent(lines.find((l) => l.includes("detected skills"))!);
      expect(skillsLine).toContain("3 detected skills");

      // (b) never an opened "(top: ..." left unclosed — and no entry
      // appears as a truncated fragment: for each candidate label, if any
      // half of it shows up in the line, the WHOLE label must be present
      // verbatim.
      expect((skillsLine.match(/\(/g) ?? []).length).toBe((skillsLine.match(/\)/g) ?? []).length);
      for (const label of LONG_LABELS) {
        const halfway = label.slice(0, Math.floor(label.length / 2));
        if (skillsLine.includes(halfway)) {
          expect(skillsLine).toContain(label);
        }
      }
    });

    it("indicates omitted top skills honestly (\"+N more\") rather than silently dropping them, when only some fit", () => {
      const bundle = baseBundle({
        detected_skills: [
          { slug: "ai/anthropic-api", commit_count: 14, first_seen: "2024-01-01", last_seen: "2024-01-01" },
          ...LONG_SLUGS.slice(0, 2).map((slug, i) => ({
            slug,
            commit_count: 9 - i,
            first_seen: "2024-01-01",
            last_seen: "2024-01-01",
          })),
        ],
      });
      const text = stripAnsi(formatConsentSummary(bundle, { command: "submit" }));
      const skillsLine = boxRowContent(text.split("\n").find((l) => l.includes("detected skills"))!);

      // (c) the omitted skills are indicated honestly, at an entry boundary
      // (never mid-word), and the shown label that DOES fit is shown in
      // full (its human label, "Anthropic API" — not the raw slug).
      expect(skillsLine).toContain("Anthropic API");
      expect(skillsLine).not.toContain("ai/anthropic-api");
      expect(skillsLine).toMatch(/, \+\d+ more\)$/);
      expect((skillsLine.match(/\(/g) ?? []).length).toBe((skillsLine.match(/\)/g) ?? []).length);
      expect(skillsLine.length).toBeLessThanOrEqual(BOX_WIDTH);
    });

    it("plain mode with long labels stays pure printable ASCII and still respects the same width/closed-paren rules", () => {
      const bundle = baseBundle({
        detected_skills: LONG_SLUGS.map((slug, i) => ({
          slug,
          commit_count: 10 - i,
          first_seen: "2024-01-01",
          last_seen: "2024-01-01",
        })),
      });
      const text = formatConsentSummary(bundle, { command: "submit", plain: true });
      // eslint-disable-next-line no-control-regex
      expect(text).toMatch(/^[\x20-\x7e\n]*$/);
      const skillsLine = boxRowContent(text.split("\n").find((l) => l.includes("detected skills"))!);
      expect((skillsLine.match(/\(/g) ?? []).length).toBe((skillsLine.match(/\)/g) ?? []).length);
      expect(skillsLine.length).toBeLessThanOrEqual(BOX_WIDTH);
    });
  });
});

describe("shouldUsePlainOutput", () => {
  it("is always false on non-Windows platforms, regardless of env", () => {
    expect(shouldUsePlainOutput("darwin", {})).toBe(false);
    expect(shouldUsePlainOutput("linux", {})).toBe(false);
  });

  it("is true on win32 with no known ANSI/UTF-8-capable wrapper in env", () => {
    expect(shouldUsePlainOutput("win32", {})).toBe(true);
  });

  it("is false on win32 inside Windows Terminal (WT_SESSION set)", () => {
    expect(shouldUsePlainOutput("win32", { WT_SESSION: "abc" })).toBe(false);
  });

  it("is false on win32 inside a TERM_PROGRAM-reporting terminal (e.g. VS Code)", () => {
    expect(shouldUsePlainOutput("win32", { TERM_PROGRAM: "vscode" })).toBe(false);
  });

  it("is false on win32 under ConEmu (ConEmuANSI=ON)", () => {
    expect(shouldUsePlainOutput("win32", { ConEmuANSI: "ON" })).toBe(false);
  });

  it("is true on win32 when ConEmuANSI is present but not \"ON\"", () => {
    expect(shouldUsePlainOutput("win32", { ConEmuANSI: "OFF" })).toBe(true);
  });
});
