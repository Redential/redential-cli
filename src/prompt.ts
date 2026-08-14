import { createInterface, type Interface } from "node:readline/promises";
import { ScanError } from "./errors.js";
import { validatePrivateLabel } from "./private-label.js";

export interface AuthorCandidate {
  email: string;
  count: number;
}

export interface PromptStreams {
  input: unknown;
  output: unknown;
}

// Test-only override (regression-coverage follow-up, 2026-08) — lets a test
// drive the REAL exported prompt functions (not the injectable `...Fn`
// options build-bundle.ts/scan-command.ts/submit-command.ts expose, which
// bypass these functions entirely) through fake PassThrough-shaped streams,
// even from call sites (like build-bundle.ts) that never expose a `streams`
// parameter of their own. Same "settable module-level state, production
// never touches it" pattern as debug.ts's setDebugEnabled. `defaultStreams`
// is called fresh on every prompt invocation that omits its `streams`
// argument (a function used as a default-parameter value is re-evaluated on
// every such call, unlike a module-level const captured once at import
// time), so a test can set this override immediately before driving a real
// interactive flow and unset it immediately after.
let testDefaultStreams: PromptStreams | null = null;
export function __setDefaultStreamsForTest(streams: PromptStreams | null): void {
  testDefaultStreams = streams;
}
function defaultStreams(): PromptStreams {
  return testDefaultStreams ?? { input: process.stdin, output: process.stdout };
}

/**
 * `rl.question()` never settles if the input stream hits EOF before an
 * answer arrives (e.g. closed/piped stdin in a script or CI) — the process
 * would then idle with nothing keeping the event loop alive and exit 0
 * without ever producing a bundle. Racing against the interface's own
 * "close" event turns that silent non-answer into an explicit failure.
 *
 * Deliberately passes `rl.question(prompt)` straight into `Promise.race`
 * with no extra wrapping — an intermediate `await`/`.then()` here would add
 * a microtask hop to the success path that the sibling `closed` promise
 * (which rejects synchronously inside its event-listener callback) doesn't
 * have, and on a fast-resolving answer that extra hop can flip which of
 * the two "wins" the race, spuriously rejecting an otherwise-successful
 * answer. See `promptConfirmScan`'s re-ask loop for the one place that
 * DOES need extra normalization (a second `rl.question()` call after the
 * interface may already be closed) — handled there instead, not here,
 * precisely to keep every OTHER (single-question) prompt in this file
 * free of this timing hazard.
 */
function questionOrThrowOnClose(rl: Interface, prompt: string, closeMessage: string): Promise<string> {
  const closed = new Promise<never>((_, reject) => {
    rl.once("close", () => reject(new ScanError(closeMessage)));
  });
  return Promise.race([rl.question(prompt), closed]);
}

function formatCandidate(c: AuthorCandidate): string {
  return `${c.email} (${c.count} commit${c.count === 1 ? "" : "s"})`;
}

export async function promptAuthors(
  candidates: AuthorCandidate[],
  streams: PromptStreams = defaultStreams(),
  preselectedEmails?: string[]
): Promise<string[]> {
  // Console-UX overhaul (2026-08): a single candidate is almost always
  // "you" — rather than asking a standalone "Use this identity?" Y/n here
  // AND a separate authorization question later, the sole candidate is
  // taken directly (no prompt, no I/O at all) and the single unified
  // promptConfirmScan (build-bundle.ts) is what actually asks the user,
  // showing this exact email + commit count merged with the authorization
  // question. 2+ candidates still need the numbered list below — there's
  // no single obvious default to silently pick for them.
  if (candidates.length === 1) {
    return [candidates[0].email];
  }

  const rl = createInterface(streams);
  try {
    console.log("Which of these author identities are yours?");
    candidates.forEach((c, i) => {
      console.log(`  ${i + 1}. ${formatCandidate(c)}`);
    });

    // Identity-selection-memory milestone (2026-07): when a previous saved
    // selection is passed in, an empty answer (bare Enter) falls back to it
    // instead of always meaning "none selected" — but only for the still-
    // present emails, and only when at least one of them still matches a
    // candidate (otherwise the prompt and behavior stay byte-identical to
    // before this milestone).
    const preselectedIndices = (preselectedEmails ?? [])
      .map((email) => candidates.findIndex((c) => c.email === email))
      .filter((i) => i >= 0);
    const questionText =
      preselectedIndices.length > 0
        ? `Enter the numbers, comma-separated (e.g. 1,3) [Enter = ${preselectedIndices.map((i) => i + 1).join(",")}]: `
        : "Enter the numbers, comma-separated (e.g. 1,3): ";

    const answer = await questionOrThrowOnClose(
      rl,
      questionText,
      "Input closed before an author identity was selected. Use --author <email> and --yes for non-interactive runs."
    );
    if (answer.trim() === "" && preselectedIndices.length > 0) {
      return [...new Set(preselectedIndices.map((i) => candidates[i].email))];
    }
    const indices = answer
      .split(",")
      .map((s) => parseInt(s.trim(), 10) - 1)
      .filter((i) => i >= 0 && i < candidates.length);
    return [...new Set(indices.map((i) => candidates[i].email))];
  } finally {
    rl.close();
  }
}

function commitWord(n: number): string {
  return n === 1 ? "commit" : "commits";
}

/**
 * Shared text builder for every "Scan `<N>` commits by `<email(s)>`? This
 * confirms you're authorized to analyze this repository. (y/n)" question in
 * this file. Owner directive (2026-08): `promptUseSavedSelection` and
 * `promptUseGitIdentity` now delegate straight to `promptConfirmScan` for
 * this exact text — since their own "yes" also grants authorization, they
 * share not just the wording but the identical no-default/re-ask
 * interaction as the CLI's one true authorization gate. There is no longer
 * any y/n prompt in this file whose "yes" grants authorization AND keeps
 * a default.
 */
function formatScanConfirmText(candidates: AuthorCandidate[], authors: string[]): string {
  const countsByEmail = new Map(candidates.map((c) => [c.email, c.count]));
  const totalCommits = authors.reduce((sum, email) => sum + (countsByEmail.get(email) ?? 0), 0);
  const emailList = authors.join(", ");
  return `Scan ${totalCommits.toLocaleString("en-US")} ${commitWord(totalCommits)} by ${emailList}? This confirms you're authorized to analyze this repository.`;
}

function isExplicitYes(answer: string): boolean {
  const trimmed = answer.trim().toLowerCase();
  return trimmed === "y" || trimmed === "yes";
}

function isExplicitNo(answer: string): boolean {
  const trimmed = answer.trim().toLowerCase();
  return trimmed === "n" || trimmed === "no";
}

/**
 * Bug fix (owner follow-up, 2026-08 — reproduced via pty on a real repo
 * with 2+ raw author emails): offers a previously saved identity selection
 * (identity-selection-store.ts) as a fast default before falling back to
 * the full numbered list — only ever called when the saved selection's
 * author-list hash still matches the repo's current candidates
 * (build-bundle.ts). Previously asked its own separate "Use your saved
 * identity selection: ...? (Y/n)" Y/n, ALWAYS followed by a second,
 * redundant `promptConfirmScan` call for the exact same authors — visibly
 * two questions in a row asking the same thing.
 *
 * Consistency fix (owner directive, 2026-08): this question's own "yes"
 * GRANTS authorization (it's the exact same sentence `promptConfirmScan`
 * asks — see `formatScanConfirmText`), so it must follow the SAME rule as
 * every other question that does: no implied default, re-asks until an
 * explicit `y`/`yes` or `n`/`no`. A Y-default here would let a bare Enter
 * silently grant authorization on the most common repeat-scan path —
 * exactly what the owner's rule forbids. Delegating straight to
 * `promptConfirmScan` (rather than duplicating its loop) guarantees this
 * can never drift out of sync with the CLI's one true authorization gate.
 * Declining (an explicit `n`/`no`) still falls through to the full
 * numbered list, exactly as before — that part of this function's role
 * (a SELECTION mechanism, fast default vs. full list) is unchanged; only
 * the accept/decline INTERACTION shape changed.
 *
 * `candidates` is the full enumerated candidate list this repo's history
 * produced — needed to look up each stored author's own commit count for
 * display.
 */
export async function promptUseSavedSelection(
  authors: string[],
  candidates: AuthorCandidate[],
  streams: PromptStreams = defaultStreams()
): Promise<boolean> {
  return promptConfirmScan(candidates, authors, streams);
}

/**
 * Bug fix (owner follow-up, 2026-08 — same reproduction as
 * `promptUseSavedSelection` above): offers the repo's own `git config
 * user.email` as a fast default before falling back to the full author
 * list — only ever called when it matches one of 2+ real candidates
 * (build-bundle.ts). Previously asked its own separate "Found N commits
 * authored by X. Use this identity? (Y/n)" Y/n, ALWAYS followed by a
 * second, redundant `promptConfirmScan` call.
 *
 * Consistency fix (owner directive, 2026-08): same rationale as
 * `promptUseSavedSelection` above — this question's "yes" also grants
 * authorization, so it delegates straight to `promptConfirmScan` too:
 * no default, re-asks until an explicit y/n. Declining still falls
 * through to the full numbered list, unchanged.
 */
export async function promptUseGitIdentity(
  candidate: AuthorCandidate,
  streams: PromptStreams = defaultStreams()
): Promise<boolean> {
  return promptConfirmScan([candidate], [candidate.email], streams);
}

/**
 * Console-UX overhaul (2026-08): the single unified pre-scan confirmation
 * that replaces the three separate questions this CLI used to ask
 * (the connectable-repo "Continue locally?" guardrail — now a non-blocking
 * end-of-scan notice, no question at all, see public-remote.ts; the
 * per-candidate identity confirmation; and the authorization attestation,
 * including the two explanatory context lines that used to precede it —
 * owner follow-up, 2026-08: deleted entirely, since the question's own
 * text already carries the authorization meaning). One question, covering
 * identity AND authorization together.
 *
 * Owner directive (2026-08): this is THE ONLY prompt in the whole CLI with
 * NO default and a re-ask loop — `(y/n)`, no capital, no implied default.
 * An empty answer (bare Enter) neither proceeds nor cancels: it re-asks
 * the exact same question, looping until an explicit `y`/`yes` or
 * `n`/`no` (case-insensitive) is given. This is the CLI's one true
 * authorization gate — every other y/n prompt in this file defaults to
 * Y on Enter; this one refuses to infer anything from silence. EOF (input
 * closed before an explicit answer, on any iteration of the loop) still
 * throws the same `ScanError` as before, unaffected by the looping.
 * `--yes` still bypasses this function entirely (build-bundle.ts).
 *
 * `authors` is the already-determined selection (from the numbered list,
 * a fast-path offer, or the sole candidate); `candidates` is the full
 * enumerated list this repo's history produced, used only to look up each
 * selected author's own commit count for display — a `--author` flag that
 * doesn't match any real commit in the repo simply shows 0, exactly as
 * honest as the numbers `runScan` itself would compute right after.
 */
export async function promptConfirmScan(
  candidates: AuthorCandidate[],
  authors: string[],
  streams: PromptStreams = defaultStreams()
): Promise<boolean> {
  const prompt = `${formatScanConfirmText(candidates, authors)} (y/n) `;
  const closeMessage =
    "Input closed before authorization was confirmed. Use --author <email> and --yes for non-interactive runs.";
  const rl = createInterface(streams);
  try {
    for (;;) {
      let answer: string;
      try {
        answer = await questionOrThrowOnClose(rl, prompt, closeMessage);
      } catch (err) {
        // On the SECOND (or later) iteration only: the input stream may
        // have already ended while delivering the previous (re-asked)
        // answer, leaving `rl` fully closed by the time this call is made
        // — its own "close" event already fired in the past, so
        // `questionOrThrowOnClose`'s fresh listener never catches it (a
        // `once` listener only ever catches a FUTURE emission), and
        // `rl.question()` itself rejects with Node's own raw "readline was
        // closed" message instead. Normalize that (and only that) case to
        // the same `ScanError` a first-attempt EOF already throws — a
        // caller must never see Node's internal message (this repo's
        // error policy). A genuine `ScanError` from the first-attempt path
        // is rethrown unchanged.
        if (err instanceof ScanError) throw err;
        throw new ScanError(closeMessage);
      }
      if (isExplicitYes(answer)) return true;
      if (isExplicitNo(answer)) return false;
      // Anything else — including a bare Enter — re-asks. Never inferred,
      // never defaulted; see this function's own doc comment.
    }
  } finally {
    rl.close();
  }
}

const PRIVATE_LABEL_PROMPT_TEXT = "Private label for this repo (only you will ever see it): ";
/** 1 initial attempt + this many re-asks = 3 total attempts before giving
 * up — see docs/private-label.md's "mandatory, not optional" section. */
const PRIVATE_LABEL_MAX_RETRIES = 2;

/**
 * Mandatory on every `submit` — see docs/private-label.md. Re-asks on any
 * validation failure (empty, too long, control characters, or a secret
 * pattern — all via the same `validatePrivateLabel` the `--label` flag
 * itself is checked against), printing the specific reason so the user
 * knows what to fix, up to `PRIVATE_LABEL_MAX_RETRIES` times; the final
 * failed attempt re-throws the validation error itself rather than a
 * generic one, so the exit message still names the actual problem.
 */
export async function promptPrivateLabel(streams: PromptStreams = defaultStreams()): Promise<string> {
  const rl = createInterface(streams);
  try {
    for (let attempt = 0; attempt <= PRIVATE_LABEL_MAX_RETRIES; attempt++) {
      const answer = await questionOrThrowOnClose(
        rl,
        PRIVATE_LABEL_PROMPT_TEXT,
        "Input closed before a private label was entered. Use --label for non-interactive runs."
      );
      try {
        return validatePrivateLabel(answer);
      } catch (err) {
        if (attempt === PRIVATE_LABEL_MAX_RETRIES) throw err;
        const message = err instanceof Error ? err.message : String(err);
        // console.error (real stderr), not the injectable `streams.output`
        // — same choice promptAuthors already makes for its own interstitial
        // "Which of these..." line, which isn't captured by tests either;
        // this is guidance text, not part of the single-line prompt itself.
        console.error(`${message} Please try again.`);
      }
    }
    // Unreachable: the loop above always either returns or throws on its
    // last iteration — kept only to satisfy the function's return type.
    throw new ScanError("Private label was not provided.");
  } finally {
    rl.close();
  }
}

/**
 * Separate confirmation from `promptConfirmScan` — "I'm authorized to
 * scan" and "upload this specific bundle" are different questions.
 *
 * Owner directive (2026-08): this IS the single upload confirmation now —
 * `scan`'s old separate "Add this to your Redential profile?" post-scan
 * prompt is gone entirely (scan-command.ts continues straight into
 * `submit`'s own flow instead of asking its own question first), so this
 * text was retargeted from "Upload this bundle?" to "Upload this to your
 * Redential profile?" to read naturally as the one decision either
 * `redential submit` directly, or a `scan` hand-off, ever asks. Y-default
 * (Enter accepts) — an ordinary y/n prompt, unlike `promptConfirmScan`'s
 * deliberate no-default re-ask loop: by this point the user has already
 * reviewed the exact byte-for-byte JSON just printed above it (see
 * submit-command.ts's own ordering, which prints that JSON immediately
 * before this question on every path) and the consent box before that.
 */
export async function promptConfirmUpload(streams: PromptStreams = defaultStreams()): Promise<boolean> {
  const rl = createInterface(streams);
  try {
    const answer = await questionOrThrowOnClose(
      rl,
      "Upload this to your Redential profile? (Y/n) ",
      "Input closed before the upload was confirmed. Use --confirm-upload for non-interactive runs."
    );
    const trimmed = answer.trim().toLowerCase();
    return trimmed === "" || trimmed.startsWith("y");
  } finally {
    rl.close();
  }
}
