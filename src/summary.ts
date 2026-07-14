import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Bundle, DetectedSkill } from "./types.js";

/**
 * Renders a human-facing summary of an already-computed bundle for TTY
 * stdout. Every value describing the REPO comes from `Bundle` alone — no
 * new data collection, no network, no re-reading git. Two exceptions, both
 * deliberately narrow:
 * - The closing next-step hint takes two plain booleans describing local
 *   CLI session/submission state (never repo data, never derived from
 *   anything besides the CLI's own config dir — see scan-command.ts's
 *   `nextStepsState`).
 * - Capability/category display labels are looked up in this repo's own
 *   `taxonomy.json` (a public, versioned, checked-in file — the same
 *   closed-vocabulary source `skill-detect.ts`/`explain-command.ts` already
 *   read locally), never invented and never a network call.
 * Both keep this file a pure, fully unit-testable function of its explicit
 * inputs plus this repo's own static data files. See `docs/scan.md`.
 */

const WIDTH = 60;

interface Theme {
  colors: {
    RESET: string;
    BOLD: string;
    DIM: string;
    CYAN: string;
    GREEN: string;
    YELLOW: string;
    GRAY: string;
  };
  chars: {
    barFilled: string;
    barEmpty: string;
    sparkLevels: string[];
    boxH: string;
    boxV: string;
    boxTL: string;
    boxTR: string;
    boxBL: string;
    boxBR: string;
    divider: string;
    arrow: string;
    /** Inline separator reused in a few places (the header's "span · commits
     * · ownership" line, the CAPABILITIES DETECTED structural tag) — not the
     * box divider (`divider`, a full-width rule). */
    dot: string;
  };
}

// ANSI escapes + Unicode box-drawing/block characters. Requires a terminal
// that both processes VT100 escapes and renders UTF-8 — true of essentially
// every terminal except plain Windows conhost (cmd.exe / classic
// PowerShell without Windows Terminal), which is what PLAIN_THEME is for.
const RICH_THEME: Theme = {
  colors: {
    RESET: "\x1b[0m",
    BOLD: "\x1b[1m",
    DIM: "\x1b[2m",
    CYAN: "\x1b[36m",
    GREEN: "\x1b[32m",
    YELLOW: "\x1b[33m",
    GRAY: "\x1b[90m",
  },
  chars: {
    barFilled: "█",
    barEmpty: "░",
    sparkLevels: ["·", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"],
    boxH: "═",
    boxV: "║",
    boxTL: "╔",
    boxTR: "╗",
    boxBL: "╚",
    boxBR: "╝",
    divider: "─",
    arrow: "→",
    // Same non-ASCII-terminal assumption as the box-drawing/block chars
    // above (▃▄█░ etc.) — no new risk class introduced by adding this.
    dot: "·",
  },
};

// No escape codes, no non-ASCII — every string this theme can ever produce
// prints correctly on a legacy console codepage. `sparkLevels` keeps 9
// levels (matching RICH_THEME's resolution) using printable ASCII only.
const PLAIN_THEME: Theme = {
  colors: {
    RESET: "",
    BOLD: "",
    DIM: "",
    CYAN: "",
    GREEN: "",
    YELLOW: "",
    GRAY: "",
  },
  chars: {
    barFilled: "#",
    barEmpty: "-",
    sparkLevels: [".", "_", "-", "^", "~", "=", "*", "%", "#"],
    boxH: "=",
    boxV: "|",
    boxTL: "+",
    boxTR: "+",
    boxBL: "+",
    boxBR: "+",
    divider: "-",
    arrow: "->",
    // Pure-ASCII substitute so plain mode's "no Unicode" guarantee holds.
    dot: "-",
  },
};

/**
 * `false` means: fall back to PLAIN_THEME. Only bare Windows conhost (no
 * known ANSI/UTF-8-capable wrapper) is untrusted — every other platform,
 * and every known Windows terminal replacement, gets the rich theme.
 * `platform`/`env` are passed explicitly (rather than reading
 * `process.platform`/`process.env` directly) so this stays a pure,
 * unit-testable function, matching the rest of the codebase's
 * injectable-dependency style (e.g. login.ts's `openFn`/`sleepFn`).
 */
export function shouldUsePlainOutput(platform: string, env: Record<string, string | undefined>): boolean {
  if (platform !== "win32") return false;
  // WT_SESSION: Windows Terminal. TERM_PROGRAM: e.g. VS Code's integrated
  // terminal. ConEmuANSI=ON: ConEmu/Cmder. All three are UTF-8 and
  // ANSI-capable regardless of the underlying console host.
  const hasKnownGoodWrapper = Boolean(env.WT_SESSION || env.TERM_PROGRAM || env.ConEmuANSI === "ON");
  return !hasKnownGoodWrapper;
}

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Mirrors skill-detect.ts's/explain-command.ts's own DEFAULT_TAXONOMY_PATH
// resolution (this file sits at the same depth under src/). Read lazily and
// cached at module scope — taxonomy.json is a static, checked-in file that
// never changes within a single process lifetime, so there is no
// correctness reason to re-read/re-parse it on every label lookup, only a
// (small, still worth avoiding) repeated I/O + JSON.parse cost across a
// summary with dozens of detected skills / categories.
const DEFAULT_TAXONOMY_PATH = fileURLToPath(new URL("../taxonomy.json", import.meta.url));
let cachedSkillLabels: Map<string, string> | null = null;

/**
 * Human label for a taxonomy.json skill slug, straight from the closed
 * vocabulary itself — never invented. Falls back to the bare slug only when
 * the taxonomy genuinely has no label for it (should not happen for a slug
 * that made it into a bundle at all, since skill-detect.ts already enforces
 * every detected slug is a taxonomy member — this fallback exists purely as
 * a defensive last resort, and is exercised in tests with deliberately
 * fake, non-taxonomy slugs).
 */
function skillLabel(slug: string, path: string = DEFAULT_TAXONOMY_PATH): string {
  if (!cachedSkillLabels) {
    const taxonomy = JSON.parse(readFileSync(path, "utf8")) as { skills: { slug: string; label: string }[] };
    cachedSkillLabels = new Map(taxonomy.skills.map((s) => [s.slug, s.label]));
  }
  return cachedSkillLabels.get(slug) ?? slug;
}

// Shared humanization map for BOTH the CAPABILITIES DETECTED group headers
// (keyed by taxonomy slug prefix — "frontend", "auth", "payments", etc.)
// and the TOP CATEGORIES row labels (keyed by `CategoryName` —
// `types.ts`'s CATEGORY_NAMES). The two key sets overlap but aren't
// identical (categories add "docs"/"ai-workflow"/"other"; groups add
// "ai"/"db"/"queues"/"observability"/"email"/"storage"/"realtime" that no
// category uses) — this is deliberately ONE map covering the union, per the
// owner's explicit nit that both surfaces must share the same presentation
// map rather than maintaining two that could drift out of sync. `"other"`
// is never looked up here: TOP CATEGORIES filters it out before this
// function is ever called (see categoriesSection below).
const PREFIX_DISPLAY_NAMES: Record<string, string> = {
  frontend: "Frontend",
  auth: "Authentication",
  db: "Databases",
  ai: "AI",
  payments: "Payments",
  backend: "Backend",
  queues: "Background jobs & queues",
  observability: "Observability",
  testing: "Testing",
  email: "Email",
  infra: "Infrastructure",
  storage: "Storage",
  realtime: "Realtime",
  data: "Data",
  docs: "Docs",
  "ai-workflow": "AI workflows",
};

function humanizePrefix(prefix: string): string {
  return PREFIX_DISPLAY_NAMES[prefix] ?? prefix.charAt(0).toUpperCase() + prefix.slice(1);
}

function humanizeSpan(days: number): string {
  if (days <= 0) return "a single day";
  const years = Math.floor(days / 365);
  if (years >= 1) return `${years} year${years === 1 ? "" : "s"}`;
  const months = Math.floor(days / 30);
  if (months >= 1) return `${months} month${months === 1 ? "" : "s"}`;
  return `${days} day${days === 1 ? "" : "s"}`;
}

function pct(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

function bar(fraction: number, width: number, theme: Theme): string {
  const clamped = Math.max(0, Math.min(1, fraction));
  const filled = Math.round(clamped * width);
  return theme.chars.barFilled.repeat(filled) + theme.chars.barEmpty.repeat(width - filled);
}

function sparkline(values: number[], theme: Theme): string {
  const levels = theme.chars.sparkLevels;
  const max = Math.max(...values, 0);
  if (max === 0) return levels[0].repeat(values.length);
  return values
    .map((v) => {
      if (v === 0) return levels[0];
      const level = Math.max(1, Math.round((v / max) * (levels.length - 1)));
      return levels[level];
    })
    .join("");
}

function hourAxis(): string {
  const chars = new Array(24).fill(" ");
  for (const [pos, label] of [
    [0, "0"],
    [6, "6"],
    [12, "12"],
    [18, "18"],
  ] as const) {
    for (let i = 0; i < label.length; i++) chars[pos + i] = label[i];
  }
  return chars.join("");
}

function heading(label: string, theme: Theme): string {
  return `  ${theme.colors.BOLD}${theme.colors.GRAY}${label}${theme.colors.RESET}`;
}

function sectionOrTeaser<T>(items: T[], render: (items: T[]) => string[], teaser: string, theme: Theme): string[] {
  return items.length > 0 ? render(items) : [`  ${theme.colors.DIM}${teaser}${theme.colors.RESET}`];
}

function weekdaySection(histogram: number[], theme: Theme): string[] {
  const max = Math.max(...histogram, 1);
  const barWidth = 20;
  return histogram.map((count, i) => {
    const filled = Math.round((count / max) * barWidth);
    const b = theme.chars.barFilled.repeat(filled) + theme.chars.barEmpty.repeat(barWidth - filled);
    return `  ${WEEKDAY_LABELS[i]}  ${theme.colors.GREEN}${b}${theme.colors.RESET}  ${count}`;
  });
}

// Only rendered under `--details` (FormatSummaryOptions.details) — moved
// out of the default summary in the phase-2 console-UX redesign so the
// default view stays a short, shareable "capabilities" overview. Same
// pure-formatting-over-the-bundle contract as everything else in this file.
function histogramSections(bundle: Bundle, theme: Theme): string[] {
  const { colors } = theme;
  const lines: string[] = [];
  lines.push(heading("COMMITS BY HOUR (UTC)", theme));
  lines.push(`  ${hourAxis()}`);
  lines.push(`  ${colors.GREEN}${sparkline(bundle.commits.hour_histogram, theme)}${colors.RESET}`);
  lines.push("");
  lines.push(heading("COMMITS BY WEEKDAY", theme));
  lines.push(...weekdaySection(bundle.commits.weekday_histogram, theme));
  lines.push("");
  return lines;
}

function shareSection(
  items: Array<{ label: string; share: number; suffix?: string }>,
  maxItems: number,
  theme: Theme
): string[] {
  const top = [...items].sort((a, b) => b.share - a.share).slice(0, maxItems);
  const max = Math.max(...top.map((i) => i.share), 0.0001);
  const labelWidth = Math.max(...top.map((i) => i.label.length), 4);
  return top.map((item) => {
    const b = bar(item.share / max, 20, theme);
    const label = item.label.padEnd(labelWidth);
    const suffix = item.suffix ? `  ${theme.colors.DIM}${item.suffix}${theme.colors.RESET}` : "";
    return `  ${label}  ${theme.colors.GREEN}${b}${theme.colors.RESET}  ${theme.colors.YELLOW}${pct(
      item.share
    ).padStart(4)}${theme.colors.RESET}${suffix}`;
  });
}

// TOP CATEGORIES: humanized display names (never the raw lowercase
// CategoryName — same shared PREFIX_DISPLAY_NAMES map the CAPABILITIES
// DETECTED groups use), "other" always hidden (it's a catch-all bucket, not
// a real category a user would recognize as their own work), and anything
// under 2% churn share hidden as noise below the threshold worth a row.
const CATEGORY_MIN_SHARE = 0.02;

function categoriesSection(bundle: Bundle, theme: Theme): string[] {
  const visible = bundle.categories.filter((c) => c.name !== "other" && c.churn_share >= CATEGORY_MIN_SHARE);
  return sectionOrTeaser(
    visible,
    (cats) => shareSection(cats.map((c) => ({ label: humanizePrefix(c.name), share: c.churn_share })), 5, theme),
    "No category data yet.",
    theme
  );
}

// Structural findings (proof graph, bundle schema 1.2.0+, `evidence:
// "structural"`) get a visible tag appended after the commit count in
// CAPABILITIES DETECTED — appended AFTER the padded label/count columns, so
// existing column alignment (computed from `labelWidth` alone) is
// untouched. Reuses the theme's own dot separator (already used elsewhere
// in this file, including its plain-ASCII substitute) rather than inventing
// a new glyph, so the "no Unicode in plain mode" guarantee extends here for
// free. Skills without `evidence: "structural"` (the vast majority —
// ordinary import-tier matches) render no tag at all, identical to before
// this feature existed.
function evidenceBadge(skill: DetectedSkill, theme: Theme): string {
  if (skill.evidence !== "structural") return "";
  const confidenceLabel = skill.confidence === "inferred" ? "INFERRED" : "DIRECT";
  return `   ${theme.colors.YELLOW}STRUCTURAL ${theme.chars.dot} ${confidenceLabel}${theme.colors.RESET}`;
}

const MAX_GROUP_ENTRIES = 4;

// Slug prefix ("frontend/react" -> "frontend"); a slug with no "/" (should
// not occur for real taxonomy entries, but kept defensive) groups under
// itself rather than throwing.
function slugPrefix(slug: string): string {
  const idx = slug.indexOf("/");
  return idx === -1 ? slug : slug.slice(0, idx);
}

interface CapabilityGroup {
  prefix: string;
  skills: DetectedSkill[];
  totalCommits: number;
}

/**
 * CAPABILITIES DETECTED — phase 2 of the console-UX redesign. Structural
 * findings (evidence: "structural") are pulled out and rendered FIRST, each
 * with a STRUCTURAL · DIRECT/INFERRED tag (see evidenceBadge above); if
 * there are none, nothing is printed about their absence (no empty
 * section, no "no structural findings" line — silence is the correct
 * signal here). Every remaining (ordinary import-tier) skill is grouped by
 * its taxonomy slug prefix ("frontend", "auth", "payments", ...), groups
 * ordered by their own total commit count descending, entries within a
 * group ordered by commit count descending and capped at
 * MAX_GROUP_ENTRIES ("+N more" beyond that) — never both listing a
 * structural finding a second time under its own group AND at the top,
 * since that would just be visual duplication of the same evidence.
 */
function capabilitiesSection(bundle: Bundle, theme: Theme): string[] {
  const { colors } = theme;
  const skills = bundle.detected_skills;
  if (skills.length === 0) {
    return [
      `  ${colors.DIM}No capabilities detected yet — signature matching covers 100+`,
      `  technologies (auth, payments, AI, infra, and more). Keep`,
      `  committing and rerun \`redential scan\`.${colors.RESET}`,
    ];
  }

  const structural = skills
    .filter((s) => s.evidence === "structural")
    .sort((a, b) => b.commit_count - a.commit_count);

  const groupsByPrefix = new Map<string, DetectedSkill[]>();
  for (const s of skills) {
    if (s.evidence === "structural") continue;
    const prefix = slugPrefix(s.slug);
    const list = groupsByPrefix.get(prefix);
    if (list) list.push(s);
    else groupsByPrefix.set(prefix, [s]);
  }
  const groups: CapabilityGroup[] = [...groupsByPrefix.entries()]
    .map(([prefix, groupSkills]) => ({
      prefix,
      skills: [...groupSkills].sort((a, b) => b.commit_count - a.commit_count),
      totalCommits: groupSkills.reduce((sum, s) => sum + s.commit_count, 0),
    }))
    .sort((a, b) => b.totalCommits - a.totalCommits);

  // One shared label width so the commit-count column lines up between the
  // 2-space-indented structural rows and the 4-space-indented group rows —
  // group rows get 2 fewer padding columns to compensate for their extra
  // indent.
  const allLabels = [
    ...structural.map((s) => skillLabel(s.slug)),
    ...groups.flatMap((g) => g.skills.slice(0, MAX_GROUP_ENTRIES).map((s) => skillLabel(s.slug))),
  ];
  const labelWidth = Math.max(...allLabels.map((l) => l.length), 4);

  const lines: string[] = [];
  for (const s of structural) {
    const label = skillLabel(s.slug);
    lines.push(
      `  ${label.padEnd(labelWidth)}  ${colors.GREEN}${String(s.commit_count).padStart(4)} commits${
        colors.RESET
      }${evidenceBadge(s, theme)}`
    );
  }
  if (structural.length > 0 && groups.length > 0) lines.push("");

  groups.forEach((group, i) => {
    lines.push(heading(humanizePrefix(group.prefix), theme));
    const shown = group.skills.slice(0, MAX_GROUP_ENTRIES);
    for (const s of shown) {
      const label = skillLabel(s.slug);
      lines.push(
        `    ${label.padEnd(Math.max(0, labelWidth - 2))}  ${colors.GREEN}${String(s.commit_count).padStart(
          4
        )} commits${colors.RESET}`
      );
    }
    if (group.skills.length > shown.length) {
      lines.push(`    ${colors.DIM}+${group.skills.length - shown.length} more${colors.RESET}`);
    }
    if (i < groups.length - 1) lines.push("");
  });

  return lines;
}

export interface FormatSummaryOptions {
  /** True to render the ASCII/no-color fallback (see `shouldUsePlainOutput`). */
  plain?: boolean;
  /**
   * Local CLI state for the closing next-step hint — never repo data.
   * `false`/omitted is always the safe default (never claims a session or
   * a prior submission that isn't actually known to exist):
   * - No session → "redential login && redential submit".
   * - Session, not yet submitted (or `alreadySubmittedIdentical` omitted)
   *   → "redential submit" only.
   * - Session AND this exact bundle content was already uploaded → no
   *   hint at all; re-submitting would send nothing new.
   */
  hasSession?: boolean;
  alreadySubmittedIdentical?: boolean;
  /** Human label for an active `--since` window ("last 2 years", "since
   * 2024-01-01" — src/since.ts's describeSince), shown next to the
   * span/commit-count line. Undefined/omitted means no window was applied
   * (the default: full history). Local CLI input, not bundle data — same
   * category as hasSession/alreadySubmittedIdentical above. */
  sinceLabel?: string;
  /** True when the scanned repo is a shallow clone (git.ts's
   * isShallowRepository) — same local-state category as the fields above.
   * Adds a note near the top of the summary; the stderr warning
   * (shallow-repo.ts) is the more prominent, always-shown version of this
   * — the summary note is a lighter reminder for whoever's looking at this
   * summary specifically. */
  isShallow?: boolean;
  /** True renders the extra COMMITS BY HOUR/WEEKDAY histogram sections
   * (`redential scan --details`) in addition to the default sections. The
   * default (false/omitted) omits them — see scan-command.ts and
   * docs/scan.md. Also drops the "More detail..." footer hint (already
   * showing what it would point to). */
  details?: boolean;
}

export function formatSummary(bundle: Bundle, opts: FormatSummaryOptions = {}): string {
  const theme = opts.plain ? PLAIN_THEME : RICH_THEME;
  const { colors, chars } = theme;
  const lines: string[] = [];

  lines.push(`  ${colors.BOLD}${colors.CYAN}PRIVATE WORK, LOCALLY DERIVED${colors.RESET}`);

  const commitCount = bundle.commits.user_total.toLocaleString("en-US");
  const windowSuffix = opts.sinceLabel ? ` ${colors.DIM}(${opts.sinceLabel})${colors.RESET}` : "";
  lines.push(
    `  ${colors.BOLD}${humanizeSpan(bundle.commits.span_days)} ${chars.dot} ${commitCount} authored commits ${
      chars.dot
    } ${pct(bundle.ownership.user_commit_ratio)} ownership${colors.RESET}${windowSuffix}`
  );
  if (opts.isShallow) {
    lines.push(
      `  ${colors.YELLOW}Note: shallow clone — history before the shallow boundary isn't counted above.${colors.RESET}`
    );
  }
  lines.push("");

  if (opts.details) {
    lines.push(...histogramSections(bundle, theme));
  }

  lines.push(heading("CAPABILITIES DETECTED", theme));
  lines.push("");
  lines.push(...capabilitiesSection(bundle, theme));
  lines.push("");

  lines.push(heading("TOP LANGUAGES", theme));
  lines.push(
    ...sectionOrTeaser(
      bundle.languages,
      (langs) => shareSection(langs.map((l) => ({ label: l.extension, share: l.share })), 5, theme),
      "No language data — every change so far was excluded (lockfiles, build output, generated dumps).",
      theme
    )
  );
  lines.push("");

  lines.push(heading("TOP CATEGORIES", theme));
  lines.push(...categoriesSection(bundle, theme));
  lines.push("");

  lines.push(
    `  ${colors.BOLD}Ownership${colors.RESET}       ${colors.YELLOW}${pct(
      bundle.ownership.user_commit_ratio
    )}${colors.RESET} of this repo's commits are yours`
  );
  lines.push(
    `  ${colors.BOLD}Signed commits${colors.RESET}  ${colors.YELLOW}${pct(bundle.signed.ratio)}${
      colors.RESET
    } of your commits are cryptographically signed`
  );
  if (bundle.signed.ratio === 0) {
    lines.push(
      `  ${colors.DIM}Tip: signing future commits adds a stronger identity anchor to your attestation.${colors.RESET}`
    );
  }
  lines.push("");

  lines.push(`  ${colors.GRAY}${chars.divider.repeat(WIDTH)}${colors.RESET}`);
  lines.push(`  ${colors.DIM}Nothing left your machine. Nothing is uploaded unless you run${colors.RESET}`);
  lines.push(`  ${colors.DIM}\`redential submit\` — and only the bounded bundle: aggregates,${colors.RESET}`);
  lines.push(`  ${colors.DIM}salted fingerprints, and closed-vocabulary capability slugs.${colors.RESET}`);
  lines.push(`  ${colors.DIM}Never code, file names, commit messages, or other contributors.${colors.RESET}`);
  lines.push(`  ${colors.DIM}Verify: github.com/Redential/redential-cli${colors.RESET}`);
  lines.push(`  ${colors.GRAY}${chars.divider.repeat(WIDTH)}${colors.RESET}`);
  lines.push("");

  lines.push(`  ${colors.DIM}Inspect the exact payload:  redential scan --json${colors.RESET}`);
  if (!opts.details) {
    lines.push(`  ${colors.DIM}More detail (hour/weekday histograms):  redential scan --details${colors.RESET}`);
  }

  // Three states, in order — see FormatSummaryOptions' own doc comment:
  // no session -> login+submit; session but not yet submitted -> submit
  // only; session AND already submitted this exact content -> nothing,
  // since re-submitting would upload nothing new.
  if (!opts.hasSession) {
    lines.push("");
    lines.push(`  ${colors.BOLD}Add this private work to your public Redential profile:${colors.RESET}`);
    lines.push(`  ${chars.arrow} redential login && redential submit`);
  } else if (!opts.alreadySubmittedIdentical) {
    lines.push("");
    lines.push(`  ${colors.BOLD}Add this private work to your public Redential profile:${colors.RESET}`);
    lines.push(`  ${chars.arrow} redential submit`);
  }

  const text = lines.join("\n");
  // Prose copy above uses em dashes for typographic style — harmless on
  // every rich terminal, but not printable on the legacy console codepages
  // PLAIN_THEME exists for. This is the one non-structural piece of
  // non-ASCII in the output, so it's normalized here rather than
  // threading a themed "dash" token through every string above.
  return opts.plain ? text.replace(/[—–]/g, "-") : text;
}

export interface FormatConsentSummaryOptions {
  /** True to render the ASCII/no-color fallback (see `shouldUsePlainOutput`). */
  plain?: boolean;
  /** Which command is rendering the block — only changes upload phrasing
   * ("gets" vs. "would get", since `scan` never actually uploads). */
  command: "scan" | "submit";
}

/**
 * Builds the "N detected skills (top: a, b, c)" line, fit to `maxWidth`
 * without ever cutting an entry short. Human labels vary a lot in length
 * ("Payment webhook flow" vs. "S3"), so a fixed "show top 3" can overflow
 * the box — this greedily drops from 3 top entries down to 0 until the
 * WHOLE clause (parenthesis included) fits, and if any of the `skillCount`
 * detected skills end up unlisted (either because more than 3 exist, or
 * because even fewer than 3 fit at this width), that's said honestly as
 * "+N more" at an entry boundary, never mid-word. Dropping to 0 shown
 * entries (bare "N detected skills", no parenthesis at all) is the
 * deliberate worst case for a single entry too long to fit at `maxWidth`
 * — still never truncates it, and never leaves an unclosed paren.
 */
function buildSkillsLine(bullet: string, skillCount: number, topLabels: string[], maxWidth: number): string {
  const base = `${bullet} ${skillCount} detected skills`;
  if (skillCount === 0) return base;
  for (let shownCount = topLabels.length; shownCount > 0; shownCount--) {
    const shown = topLabels.slice(0, shownCount);
    const omitted = skillCount - shown.length;
    const suffix = omitted > 0 ? `, +${omitted} more` : "";
    const candidate = `${base} (top: ${shown.join(", ")}${suffix})`;
    if (candidate.length <= maxWidth) return candidate;
  }
  return base;
}

/**
 * Renders a boxed, human-readable "consent summary" of exactly what a
 * `submit` would upload — printed BEFORE the exact JSON payload in
 * `submit`'s TTY output, so this is the actual surface a user reads before
 * authorizing an upload, not the raw JSON itself. Pure function of the
 * already-computed `bundle`: no new data collection, no network, no
 * re-reading git — every number below is derived straight from `bundle`
 * (labels via the same taxonomy.json lookup `capabilitiesSection` above
 * uses), so it can never drift from the JSON printed right after it. See
 * `docs/login-submit.md`.
 */
export function formatConsentSummary(bundle: Bundle, opts: FormatConsentSummaryOptions): string {
  const theme = opts.plain ? PLAIN_THEME : RICH_THEME;
  const { colors, chars } = theme;
  const bullet = opts.plain ? "-" : "•";

  // Interior box rows must carry no ANSI escapes of their own (color codes
  // would throw off the padding math) — raw text is padded to WIDTH first,
  // then wrapped in the (optionally colored) border chars. The title row is
  // the one exception (explicitly allowed to carry theme colors), built
  // separately below the same way formatSummary's title row is.
  function boxRow(raw: string): string {
    const clipped = raw.length > WIDTH ? raw.slice(0, WIDTH) : raw;
    const padded = clipped + " ".repeat(WIDTH - clipped.length);
    return `  ${colors.CYAN}${chars.boxV}${colors.RESET}${padded}${colors.CYAN}${chars.boxV}${colors.RESET}`;
  }

  const title = opts.command === "submit" ? "WHAT GETS UPLOADED" : "WHAT WOULD GET UPLOADED";
  const titlePad = Math.max(0, Math.floor((WIDTH - title.length) / 2));

  const commitCount = bundle.commits.user_total.toLocaleString("en-US");
  const span = humanizeSpan(bundle.commits.span_days);

  const skillCount = bundle.detected_skills.length;
  const topLabels = [...bundle.detected_skills]
    .sort((a, b) => b.commit_count - a.commit_count)
    .slice(0, 3)
    .map((s) => skillLabel(s.slug));
  // Every bullet row is wrapped as `boxRow(" " + text)` (a single leading
  // margin space before the bullet char) — so the available width for the
  // row's own text is WIDTH minus that one margin column.
  const rowTextWidth = WIDTH - 1;
  const skillsLine = buildSkillsLine(bullet, skillCount, topLabels, rowTextWidth);

  const lines: string[] = [];
  lines.push(`  ${colors.CYAN}${chars.boxTL}${chars.boxH.repeat(WIDTH)}${chars.boxTR}${colors.RESET}`);
  lines.push(
    `  ${colors.CYAN}${chars.boxV}${colors.RESET}${" ".repeat(titlePad)}${colors.BOLD}${colors.CYAN}${title}${
      colors.RESET
    }${" ".repeat(WIDTH - titlePad - title.length)}${colors.CYAN}${chars.boxV}${colors.RESET}`
  );
  lines.push(boxRow(""));
  lines.push(boxRow(` ${bullet} ${commitCount} commits spanning ${span}`));
  lines.push(boxRow(` ${skillsLine}`));
  lines.push(boxRow(` ${bullet} time patterns, languages and categories as aggregates`));
  lines.push(boxRow(` ${bullet} salted fingerprints (repo + identity, not reversible)`));
  lines.push(boxRow(""));
  lines.push(boxRow(` NEVER uploaded:`));
  lines.push(boxRow(`   source code, file names, commit messages`));
  lines.push(boxRow(`   the repo's name, other contributors' identities`));
  lines.push(`  ${colors.CYAN}${chars.boxBL}${chars.boxH.repeat(WIDTH)}${chars.boxBR}${colors.RESET}`);

  const text = lines.join("\n");
  // Same em-dash normalization as formatSummary — see its comment above.
  return opts.plain ? text.replace(/[—–]/g, "-") : text;
}
