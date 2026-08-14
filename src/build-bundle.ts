import { runScan, listAuthors, computeRepoFingerprint, type AuthorCandidate } from "./scan.js";
import { ScanError } from "./errors.js";
import {
  promptAuthors,
  promptConfirmScan,
  promptUseGitIdentity,
  promptUseSavedSelection,
} from "./prompt.js";
import { isShallowRepository, getConfiguredUserEmail } from "./git.js";
import { shallowRepoWarning } from "./shallow-repo.js";
import { dim } from "./dim.js";
import { writeStderrLine } from "./stderr.js";
import {
  computeAuthorListHash,
  readIdentitySelection,
  saveIdentitySelection,
} from "./identity-selection-store.js";
import type { Bundle } from "./types.js";

export interface BuildBundleOptions {
  repoPath: string;
  author: string[];
  yes: boolean;
  toolVersion: string;
  configDir?: string;
  // Injectable for tests; defaults to the real interactive prompts. The
  // optional second argument (identity-selection-memory milestone, see
  // docs/identity-selection-memory.md) pre-marks a "still-present" saved
  // selection as the Enter-default inside the full numbered list — only
  // ever passed when a stored selection exists but its author-list hash no
  // longer matches (see the "stale store" branch below).
  promptAuthorsFn?: (candidates: AuthorCandidate[], preselectedEmails?: string[]) => Promise<string[]>;
  // Injectable for tests; defaults to the real interactive prompt
  // (prompt.ts's promptConfirmScan). Only ever called when `opts.yes` is
  // false — the single unified pre-scan confirmation (console-UX overhaul,
  // 2026-08), covering identity + authorization together.
  promptConfirmFn?: () => Promise<boolean>;
  // Injectable for tests; defaults to the real interactive prompt. Only
  // ever called when `git config user.email` matches one of 2+ candidates
  // — see the "author pre-selection" comment below.
  promptUseGitIdentityFn?: (candidate: AuthorCandidate) => Promise<boolean>;
  // Injectable for tests; defaults to the real interactive prompt. Only
  // ever called on a real TTY with 2+ candidates, when a stored selection
  // (identity-selection-store.ts) still matches the repo's current author
  // list exactly — see docs/identity-selection-memory.md.
  promptUseSavedSelectionFn?: (authors: string[]) => Promise<boolean>;
  warn?: (message: string) => void;
  // True when stdout is an interactive terminal (cli.ts passes
  // `process.stdout.isTTY`; scan-command.ts/submit-command.ts forward their
  // own `isTTY` option straight through). Used to decide whether the
  // identity-selection-memory fast paths (below) and the TTY-only
  // expectation-setting first line (see EXPECTATION_LINE) apply. Undefined
  // behaves like `false`, matching a piped stdout.
  isTTY?: boolean;
  // Raw --since spec, forwarded to runScan (src/since.ts parses it). See
  // scan-command.ts / docs/scan.md for the CLI-facing behavior.
  since?: string;
  // Forwarded to runScan — see ScanOptions.onProgress.
  onProgress?: (scanned: number, total: number) => void;
  // Console-UX overhaul (2026-08): fires once, right after the final
  // author selection is known (before the unified confirm below) — lets
  // scan-command.ts capture the exact emails just confirmed, so an
  // in-process hand-off to `submit` (the post-scan "Add this to your
  // Redential profile?" prompt) never has to re-derive or re-ask for an
  // identity the user already picked moments earlier in the same process.
  // Never called on the `--author`-flag path (nothing was "selected"
  // there — the caller already has the emails it passed in).
  onAuthorsSelected?: (authors: string[]) => void;
  // Bug fix (owner follow-up, 2026-08 — real-terminal repro): `scan`'s
  // post-scan hand-off into `submit` (scan-command.ts's
  // `continueIntoSubmit`) calls `buildBundleInteractively` a SECOND time
  // in the same process (submit needs its own freshly-built bundle — see
  // the comment below on why it can't just reuse scan's). Without this
  // flag, that second call printed the intro lines (the expectation line,
  // the local-scan line, "Reading git history...") all over again, right
  // in the middle of the combined output — the exact "banner prints twice"
  // bug the owner caught. Set ONLY by that one hand-off call site; a
  // standalone `redential submit` never sets it, since submit's own run
  // IS the start of its own flow and should print them normally.
  suppressIntro?: boolean;
}

/**
 * Shared by `scan` and `submit`: author selection, authorization
 * confirmation, and the actual scan. `submit` calls this directly instead
 * of re-deriving the bundle another way, so the bundle it uploads is
 * produced by the exact same code path `scan` prints (principle 4,
 * "User-reviewed").
 */
// TTY-only, printed before anything else (console-UX overhaul, 2026-08) —
// sets the full expectation for the whole credentialing flow, not just this
// one command: scanning itself takes seconds, the (separate, browser-based)
// spoken defense that actually completes the credential takes longer.
// Piped/non-TTY output never shows this — a script has no use for it.
// Printed in the terminal's own default (neutral) color, deliberately never
// wrapped in `dim()` — this is the one line meant to actually be read, not
// ambient text (owner follow-up, 2026-08).
const EXPECTATION_LINE =
  "Scanning takes seconds. Completing your credential afterwards takes a ~15-minute spoken defense in your browser.";

// Printed right after EXPECTATION_LINE (TTY) — or first (non-TTY) — before
// anything else prompt-worthy. stderr-only (via `warn`, same channel every
// other non-blocking notice in this file uses), in every mode (TTY and
// piped/non-TTY): this keeps the piped bundle JSON on stdout byte-identical
// to every prior release (see test/privacy/debug-output.test.ts's
// stdout-purity test, which the same discipline applies to here). `submit`
// reaches this line too, since it calls buildBundleInteractively directly —
// seeing it again there is fine and desirable, not a bug. Wrapped in
// `dim()` (owner follow-up, 2026-08): a calm, reassuring privacy statement
// should never read like an alert — red/orange/warning colors are reserved
// for real errors only, never for this.
const LOCAL_ONLY_NOTICE = "Local scan. Nothing leaves your machine.";

export async function buildBundleInteractively(opts: BuildBundleOptions): Promise<Bundle> {
  const warn = opts.warn ?? writeStderrLine;
  // Known cost, accepted for now (owner follow-up, 2026-08): the scan→
  // submit hand-off calls this function a second time in the same
  // process, re-walking the same repo history instead of reusing scan's
  // already-computed `Bundle`. This is deliberate, not an oversight — the
  // bundle carries wall-clock fields (`created_at`,
  // `attestation.confirmed_at`), and `submit`'s own byte-for-byte-print
  // invariant must reflect the EXACT bundle it's about to upload, built at
  // upload time, not a stale one computed moments earlier during `scan`'s
  // own summary. The rebuild is deterministic otherwise (same repo state,
  // same `--author`/`--since`), so the only real cost is a second local
  // `git log` walk — never a second network call, never a second prompt
  // for the same decision (see `suppressIntro` below and
  // `onAuthorsSelected`/`selectionAlreadyConfirmed` elsewhere in this
  // file). `suppressIntro` only silences the REPEATED banner text this
  // second call would otherwise print; it does not skip the rebuild itself.
  if (!opts.suppressIntro) {
    if (opts.isTTY) warn(EXPECTATION_LINE);
    warn(dim(LOCAL_ONLY_NOTICE));
  }

  if (isShallowRepository(opts.repoPath)) warn(shallowRepoWarning());

  let authors = opts.author;
  let enumeratedCandidates: AuthorCandidate[] | undefined;
  // Bug fix (owner follow-up, 2026-08 — reproduced via pty): true when a
  // fast-path offer (saved-selection or git-identity) was ACCEPTED — that
  // accept already asked (and got a "yes" to) the full unified
  // identity+authorization question via `promptConfirmScan` (see
  // prompt.ts's `promptUseSavedSelection`/`promptUseGitIdentity`), so the
  // final confirmation step below must NOT ask a second, redundant
  // question for the exact same selection. Declining a fast-path offer
  // always falls through to the numbered list instead, which is a
  // SELECTION step, not a confirmation of its own — that path still needs
  // (and gets) exactly one `promptConfirmScan` call below, same as always.
  let selectionAlreadyConfirmed = false;
  if (authors.length === 0) {
    // Bug fix (owner follow-up, 2026-08): author enumeration is a full
    // `git log` walk — on a large repo (the owner's repro: ~1,400 commits)
    // this can take a few real seconds with zero visible feedback between
    // the startup lines and the first question, easily read as a hang.
    // TTY-only (piped/non-TTY stdout must stay untouched — same "no output
    // beyond the bundle JSON" contract every other stderr notice in this
    // file already respects), dim (informational, not a warning), no
    // spinner needed — just proof the process is alive and doing something.
    if (opts.isTTY && !opts.suppressIntro) warn(dim("Reading git history..."));
    const candidates = await listAuthors(opts.repoPath);
    enumeratedCandidates = candidates;
    if (candidates.length === 0) {
      throw new ScanError("This repository has no commits yet — nothing to scan.");
    }

    // Identity-selection memory (see docs/identity-selection-memory.md):
    // `--author` flags (the `authors.length === 0` guard above) always
    // bypass this store entirely — no read, no write. Only reached when
    // the user is about to be asked interactively (or, non-TTY, would hit
    // the existing EOF error) which author identity is theirs.
    const fingerprint = computeRepoFingerprint(opts.repoPath, opts.configDir);
    const stored = readIdentitySelection(fingerprint, opts.configDir);
    const currentHash = computeAuthorListHash(candidates.map((c) => c.email));
    const candidateEmails = new Set(candidates.map((c) => c.email));
    // "Matches" means the stored selection's author-list hash is identical
    // to the repo's current one AND every stored author is still among the
    // current candidates — see docs/identity-selection-memory.md's
    // "Staleness" section.
    const storedMatches =
      stored !== null &&
      stored.author_list_hash === currentHash &&
      stored.authors.every((email) => candidateEmails.has(email));

    if (!opts.isTTY) {
      // Non-interactive: a matching stored selection is used silently (a
      // single stderr notice, never stdout — the piped bundle JSON must
      // stay byte-identical). Anything else — no stored entry, or a stale
      // one — falls through to today's exact flow (including its EOF
      // error naming --author/--yes); nothing is ever inferred here, and
      // nothing is ever saved on this path.
      if (storedMatches) {
        authors = stored!.authors;
        warn(`Using saved identity selection: ${authors.join(", ")} (docs/identity-selection-memory.md).`);
      } else {
        const result = await selectAuthorsTodaysFlow(opts, candidates);
        authors = result.authors;
        selectionAlreadyConfirmed = result.confirmedViaFastPath;
      }
    } else if (candidates.length > 1 && storedMatches) {
      // 2+ candidates, a matching stored selection: offer it back FIRST,
      // before the git-identity fast path. Declining falls through to
      // today's flow exactly, with no pre-marking — the user just
      // declined that selection, so it shouldn't linger as a default.
      const useSaved = await callPromptUseSavedSelection(opts, candidates, stored!.authors);
      if (useSaved) {
        authors = stored!.authors;
        selectionAlreadyConfirmed = true;
      } else {
        const result = await selectAuthorsTodaysFlow(opts, candidates);
        authors = result.authors;
        selectionAlreadyConfirmed = result.confirmedViaFastPath;
      }
    } else if (candidates.length > 1 && stored !== null && !storedMatches) {
      // 2+ candidates, a stale stored selection (author list changed since
      // it was saved): skip both the saved-selection offer and the
      // git-identity fast path, and go straight to the full list — with
      // the still-present stored authors pre-marked as its Enter-default,
      // so "still just those" costs one keystroke without ever silently
      // reusing an answer that no longer matches the history it was
      // chosen against. The numbered list is a SELECTION step, not a
      // confirmation, so `selectionAlreadyConfirmed` stays false here —
      // the usual single `promptConfirmScan` call below still fires.
      const storedStillPresent = stored.authors.filter((email) => candidateEmails.has(email));
      authors =
        storedStillPresent.length > 0
          ? await callPromptAuthors(opts, candidates, storedStillPresent)
          : (await selectAuthorsTodaysFlow(opts, candidates)).authors;
    } else {
      // Single candidate, or no stored entry at all: today's flow,
      // unchanged.
      const result = await selectAuthorsTodaysFlow(opts, candidates);
      authors = result.authors;
      selectionAlreadyConfirmed = result.confirmedViaFastPath;
    }

    opts.onAuthorsSelected?.(authors);

    // Save whatever the user just picked, interactively, for next time —
    // never on the non-interactive path (see above) and never an empty
    // selection. A store write failure must never break the scan itself.
    if (opts.isTTY && authors.length > 0) {
      try {
        saveIdentitySelection(fingerprint, authors, currentHash, opts.configDir);
      } catch {
        // Best-effort local UX cache only — see identity-selection-store.ts.
      }
    }
  }

  let confirmed = opts.yes || selectionAlreadyConfirmed;
  if (!confirmed) {
    const candidatesForConfirm = enumeratedCandidates ?? (await listAuthors(opts.repoPath));
    confirmed = await (opts.promptConfirmFn ?? (() => promptConfirmScan(candidatesForConfirm, authors)))();
  }

  return runScan({
    repoPath: opts.repoPath,
    authors,
    confirmed,
    toolVersion: opts.toolVersion,
    configDir: opts.configDir,
    since: opts.since,
    onProgress: opts.onProgress,
  });
}

/**
 * The author-selection flow exactly as it existed before the identity-
 * selection-memory milestone (docs/identity-selection-memory.md) — extracted
 * so every "fall through to today's flow" branch above (declined saved
 * selection, stale store with nothing still present, no store at all)
 * calls the exact same code, never a near-duplicate that could drift.
 *
 * With 2+ candidates, offers the repo's own git identity as a fast default
 * BEFORE the full list — most repos have one obvious "you". A single
 * candidate takes no confirmation of its own at all here (promptAuthors
 * returns it directly — see that function's own comment); asking a Y/n
 * "use this identity" question here too would be redundant, so this only
 * fires for 2+. Declining, or no match at all, falls through to the FULL,
 * unmodified list — never silently dropping the matched entry, since "no"
 * often means "that one plus others" for a multi-identity repo.
 *
 * Returns `confirmedViaFastPath: true` only when the git-identity offer was
 * ACCEPTED — that accept already asked the full unified
 * identity+authorization question (see prompt.ts's `promptUseGitIdentity`,
 * bug fix owner follow-up 2026-08), so the caller must not ask again. The
 * numbered-list fallback always returns `false` — a raw multi-way
 * selection, never a confirmation of its own.
 */
async function selectAuthorsTodaysFlow(
  opts: BuildBundleOptions,
  candidates: AuthorCandidate[]
): Promise<{ authors: string[]; confirmedViaFastPath: boolean }> {
  if (candidates.length > 1) {
    const gitEmail = getConfiguredUserEmail(opts.repoPath);
    const matched = gitEmail ? candidates.find((c) => c.email === gitEmail) : undefined;
    if (matched) {
      const useIt = await (opts.promptUseGitIdentityFn ?? promptUseGitIdentity)(matched);
      if (useIt) return { authors: [matched.email], confirmedViaFastPath: true };
    }
  }

  return { authors: await callPromptAuthors(opts, candidates), confirmedViaFastPath: false };
}

/**
 * Small adapter over `opts.promptAuthorsFn` (or the real `promptAuthors`) —
 * needed only because the real function's parameter order is
 * `(candidates, streams?, preselectedEmails?)` while the injectable
 * `BuildBundleOptions.promptAuthorsFn` (matching every test fake already in
 * this codebase, none of which take a `streams` argument) is
 * `(candidates, preselectedEmails?)`. Keeps both call sites above from
 * having to know which of the two shapes they're calling.
 */
function callPromptAuthors(
  opts: BuildBundleOptions,
  candidates: AuthorCandidate[],
  preselectedEmails?: string[]
): Promise<string[]> {
  if (opts.promptAuthorsFn) return opts.promptAuthorsFn(candidates, preselectedEmails);
  return promptAuthors(candidates, undefined, preselectedEmails);
}

/**
 * Small adapter over `opts.promptUseSavedSelectionFn` (or the real
 * `promptUseSavedSelection`) — needed for the same reason `callPromptAuthors`
 * above exists: the injectable `promptUseSavedSelectionFn` (matching every
 * existing test fake) is `(authors) => Promise<boolean>`, while the real
 * function additionally needs `candidates` (bug fix, owner follow-up
 * 2026-08 — see prompt.ts's own comment) to look up each stored author's
 * commit count for `promptConfirmScan`'s display text.
 */
function callPromptUseSavedSelection(
  opts: BuildBundleOptions,
  candidates: AuthorCandidate[],
  authors: string[]
): Promise<boolean> {
  if (opts.promptUseSavedSelectionFn) return opts.promptUseSavedSelectionFn(authors);
  return promptUseSavedSelection(authors, candidates);
}
