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

const DEFAULT_STREAMS: PromptStreams = { input: process.stdin, output: process.stdout };

/**
 * `rl.question()` never settles if the input stream hits EOF before an
 * answer arrives (e.g. closed/piped stdin in a script or CI) — the process
 * would then idle with nothing keeping the event loop alive and exit 0
 * without ever producing a bundle. Racing against the interface's own
 * "close" event turns that silent non-answer into an explicit failure.
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

// Console-UX overhaul (2026-08): kept for promptUseGitIdentity below — the
// git-identity fast-path offer for a 2+-candidate repo. promptAuthors' own
// one-candidate case used to share this exact phrasing as its own Y/n
// confirmation; that confirmation is gone now (see promptAuthors' own
// comment below) — the single unified promptConfirmScan is what asks this
// question, merged with authorization, for that case. Thousands separator
// matches scan-command.ts's own commit-count formatting.
function formatIdentityConfirmationPrompt(c: AuthorCandidate): string {
  return `Found ${c.count.toLocaleString("en-US")} commit${c.count === 1 ? "" : "s"} authored by ${c.email}. Use this identity? (Y/n) `;
}

export async function promptAuthors(
  candidates: AuthorCandidate[],
  streams: PromptStreams = DEFAULT_STREAMS,
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

/**
 * Offers a previously saved identity selection (identity-selection-store.ts)
 * as a fast Y/n confirmation before falling back to the full numbered list —
 * only ever called when the saved selection's author-list hash still
 * matches the repo's current candidates (build-bundle.ts). Y-default, same
 * pattern as promptUseGitIdentity.
 */
export async function promptUseSavedSelection(
  authors: string[],
  streams: PromptStreams = DEFAULT_STREAMS
): Promise<boolean> {
  const rl = createInterface(streams);
  try {
    const answer = await questionOrThrowOnClose(
      rl,
      `Use your saved identity selection: ${authors.join(", ")}? (Y/n) `,
      "Input closed before an author identity was selected. Use --author <email> and --yes for non-interactive runs."
    );
    const trimmed = answer.trim().toLowerCase();
    return trimmed === "" || trimmed.startsWith("y");
  } finally {
    rl.close();
  }
}

/**
 * Offers the repo's own `git config user.email` as a fast default before
 * falling back to the full author list — only ever called when it matches
 * one of 2+ real candidates (build-bundle.ts). Y-default, same pattern as
 * promptAuthors' single-candidate confirmation.
 */
export async function promptUseGitIdentity(
  candidate: AuthorCandidate,
  streams: PromptStreams = DEFAULT_STREAMS
): Promise<boolean> {
  const rl = createInterface(streams);
  try {
    const answer = await questionOrThrowOnClose(
      rl,
      formatIdentityConfirmationPrompt(candidate),
      "Input closed before an author identity was selected. Use --author <email> and --yes for non-interactive runs."
    );
    const trimmed = answer.trim().toLowerCase();
    return trimmed === "" || trimmed.startsWith("y");
  } finally {
    rl.close();
  }
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
 * identity AND authorization together — default flips to N: pressing
 * Enter declines, the user must type `y` to proceed. This is the one place
 * that safety property lives now; unifying the three questions must never
 * weaken it.
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
  streams: PromptStreams = DEFAULT_STREAMS
): Promise<boolean> {
  const countsByEmail = new Map(candidates.map((c) => [c.email, c.count]));
  const totalCommits = authors.reduce((sum, email) => sum + (countsByEmail.get(email) ?? 0), 0);
  const emailList = authors.join(", ");
  const rl = createInterface(streams);
  try {
    const answer = await questionOrThrowOnClose(
      rl,
      `Scan ${totalCommits.toLocaleString("en-US")} ${commitWord(totalCommits)} by ${emailList}? This confirms ` +
        "you're authorized to analyze this repository. (y/N) ",
      "Input closed before authorization was confirmed. Use --author <email> and --yes for non-interactive runs."
    );
    return answer.trim().toLowerCase().startsWith("y");
  } finally {
    rl.close();
  }
}

function commitWord(n: number): string {
  return n === 1 ? "commit" : "commits";
}

/**
 * Post-scan (console-UX overhaul, 2026-08): asked once, right after the
 * TTY summary, only when there's an actual stored session and this exact
 * bundle content hasn't already been uploaded (scan-command.ts's
 * `nextStepsState` — with no session, submitting would just fail with
 * "not logged in", so the existing textual "redential login && redential
 * submit" hint in the summary is left as the only next step; nothing new
 * to add for an already-identical upload either). Y-default: Enter accepts
 * — this is a deliberately low-friction "yes, wire it up" step, unlike the
 * scan-authorization question above, since the user already reviewed and
 * approved everything about to be uploaded in the summary just printed.
 */
export async function promptAddToProfile(streams: PromptStreams = DEFAULT_STREAMS): Promise<boolean> {
  const rl = createInterface(streams);
  try {
    const answer = await questionOrThrowOnClose(
      rl,
      "Add this to your Redential profile? (Y/n) ",
      "Input closed before the profile-upload prompt was answered."
    );
    const trimmed = answer.trim().toLowerCase();
    return trimmed === "" || trimmed.startsWith("y");
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
export async function promptPrivateLabel(streams: PromptStreams = DEFAULT_STREAMS): Promise<string> {
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

/** Separate confirmation from promptConfirmScan — "I'm authorized to scan"
 * and "upload this specific bundle" are different questions. */
export async function promptConfirmUpload(streams: PromptStreams = DEFAULT_STREAMS): Promise<boolean> {
  const rl = createInterface(streams);
  try {
    const answer = await questionOrThrowOnClose(
      rl,
      "Upload this bundle? (y/n) ",
      "Input closed before the upload was confirmed. Use --confirm-upload for non-interactive runs."
    );
    return answer.trim().toLowerCase().startsWith("y");
  } finally {
    rl.close();
  }
}
