import type { Bundle } from "./types.js";

/**
 * Renders a human-facing "wrapped" summary of an already-computed bundle for
 * TTY stdout. Every value describing the REPO comes from `Bundle` alone — no
 * new data collection, no network, no re-reading git. The closing next-step
 * hint is the one exception: it takes two plain booleans describing local
 * CLI session/submission state (never repo data, never derived from
 * anything besides the CLI's own config dir — see scan-command.ts's
 * `nextStepsState`), so this function stays a pure, fully unit-testable
 * function of its explicit inputs either way. See `docs/scan.md`.
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

function skillsSection(bundle: Bundle, theme: Theme): string[] {
  const skills = [...bundle.detected_skills].sort((a, b) => b.commit_count - a.commit_count);
  if (skills.length === 0) {
    return [
      `  ${theme.colors.DIM}No skills detected yet — signature matching covers 100+`,
      `  technologies (auth, payments, AI, infra, and more). Keep`,
      `  committing and rerun \`redential scan\`.${theme.colors.RESET}`,
    ];
  }
  const shown = skills.slice(0, 8);
  const labelWidth = Math.max(...shown.map((s) => s.slug.length), 4);
  const lines = shown.map(
    (s) =>
      `  ${s.slug.padEnd(labelWidth)}  ${theme.colors.GREEN}${String(s.commit_count).padStart(4)} commits${
        theme.colors.RESET
      }`
  );
  if (skills.length > shown.length) {
    lines.push(`  ${theme.colors.DIM}+${skills.length - shown.length} more${theme.colors.RESET}`);
  }
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
}

export function formatSummary(bundle: Bundle, opts: FormatSummaryOptions = {}): string {
  const theme = opts.plain ? PLAIN_THEME : RICH_THEME;
  const { colors, chars } = theme;
  const lines: string[] = [];

  // Printed after the JSON (scan-command.ts) so this is the last thing on
  // screen when the command ends — the divider marks where the JSON above
  // ends and the human-readable summary begins.
  lines.push(`  ${colors.GRAY}${chars.divider.repeat(WIDTH)}${colors.RESET}`);
  lines.push("");

  const title = "YOUR PRIVATE REPO, WRAPPED";
  const pad = Math.max(0, Math.floor((WIDTH - title.length) / 2));
  lines.push(`  ${colors.CYAN}${chars.boxTL + chars.boxH.repeat(WIDTH) + chars.boxTR}${colors.RESET}`);
  lines.push(
    `  ${colors.CYAN}${chars.boxV}${colors.RESET}${" ".repeat(pad)}${colors.BOLD}${colors.CYAN}${title}${
      colors.RESET
    }${" ".repeat(WIDTH - pad - title.length)}${colors.CYAN}${chars.boxV}${colors.RESET}`
  );
  lines.push(`  ${colors.CYAN}${chars.boxBL + chars.boxH.repeat(WIDTH) + chars.boxBR}${colors.RESET}`);
  lines.push("");

  const commitCount = bundle.commits.user_total.toLocaleString("en-US");
  const windowSuffix = opts.sinceLabel ? ` ${colors.DIM}(${opts.sinceLabel})${colors.RESET}` : "";
  lines.push(
    `  ${colors.BOLD}${humanizeSpan(bundle.commits.span_days)}, ${commitCount} commits${colors.RESET}${windowSuffix}`
  );
  lines.push("");

  lines.push(heading("COMMITS BY HOUR (UTC)", theme));
  lines.push(`  ${hourAxis()}`);
  lines.push(`  ${colors.GREEN}${sparkline(bundle.commits.hour_histogram, theme)}${colors.RESET}`);
  lines.push("");

  lines.push(heading("COMMITS BY WEEKDAY", theme));
  lines.push(...weekdaySection(bundle.commits.weekday_histogram, theme));
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
  lines.push(
    ...sectionOrTeaser(
      bundle.categories,
      (cats) =>
        shareSection(
          cats.map((c) => ({
            label: c.name,
            share: c.churn_share,
            suffix: `(${c.commit_count} commit${c.commit_count === 1 ? "" : "s"})`,
          })),
          5,
          theme
        ),
      "No category data yet.",
      theme
    )
  );
  lines.push("");

  lines.push(heading("SKILLS DETECTED", theme));
  lines.push(...skillsSection(bundle, theme));
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
      `  ${colors.DIM}Tip: sign your commits (git config commit.gpgsign true) — signed history is the strongest anchor for your credential.${colors.RESET}`
    );
  }
  lines.push("");

  lines.push(
    `  ${colors.DIM}Nothing left your machine. Verify: github.com/Jppblue/redential-cli${colors.RESET}`
  );

  // Three states, in order — see FormatSummaryOptions' own doc comment:
  // no session -> login+submit; session but not yet submitted -> submit
  // only; session AND already submitted this exact content -> nothing,
  // since re-submitting would upload nothing new.
  if (!opts.hasSession) {
    lines.push("");
    lines.push(`  ${colors.BOLD}Want this on a public, verifiable profile?${colors.RESET}`);
    lines.push(`  ${chars.arrow} redential login && redential submit`);
  } else if (!opts.alreadySubmittedIdentical) {
    lines.push("");
    lines.push(`  ${colors.BOLD}Want this on a public, verifiable profile?${colors.RESET}`);
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
