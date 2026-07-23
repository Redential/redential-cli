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

// Console-UX milestone (2026-07): both single-identity confirmations
// (promptAuthors' one-candidate case and promptUseGitIdentity below) share
// this exact "Found <n> commits authored by <email>. Use this identity?"
// phrasing — they're the same interaction (confirm a single candidate
// identity), just reached from two different code paths. Thousands
// separator matches scan-command.ts's own commit-count formatting.
function formatIdentityConfirmationPrompt(c: AuthorCandidate): string {
    return `Found ${c.count.toLocaleString("en-US")} commit${c.count === 1 ? "" : "s"} authored by ${c.email}. Use this identity? (Y/n) `;
}

export async function promptAuthors(
  candidates: AuthorCandidate[],
  streams: PromptStreams = DEFAULT_STREAMS
): Promise<string[]> {
  const rl = createInterface(streams);
  try {
    // A single candidate is almost always "you" — a Y/n confirmation (Y
    // default, so pressing Enter accepts) is faster than making the user
    // type "1" for the only option. 2+ candidates keep the numbered list:
    // there's no single obvious default to pick for them.
    if (candidates.length === 1) {
      const [only] = candidates;
      const answer = await questionOrThrowOnClose(
        rl,
        formatIdentityConfirmationPrompt(only),
        "Input closed before an author identity was selected."
      );
      const trimmed = answer.trim().toLowerCase();
      return trimmed === "" || trimmed.startsWith("y") ? [only.email] : [];
    }

    console.log("Which of these author identities are yours?");
    candidates.forEach((c, i) => {
      console.log(`  ${i + 1}. ${formatCandidate(c)}`);
    });
    const answer = await questionOrThrowOnClose(
      rl,
      "Enter the numbers, comma-separated (e.g. 1,3): ",
      "Input closed before an author identity was selected."
    );
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
      "Input closed before an author identity was selected."
    );
    const trimmed = answer.trim().toLowerCase();
    return trimmed === "" || trimmed.startsWith("y");
  } finally {
    rl.close();
  }
}

// Console-UX milestone (2026-07): default flipped from a neutral "(y/n)" to
// an explicit "(y/N)" — pressing Enter now DECLINES, the user must type
// "y". This is a copy/default change only: the check below already only
// ever accepted an explicit answer starting with "y" (an empty answer never
// matched), so the recorded attestation's *content* (build-bundle.ts passes
// this boolean straight through to runScan as `confirmed`) is unchanged —
// only what the prompt now visibly promises about the default matches what
// the code already did.
const ATTESTATION_TEXT = "Confirm you are authorized to analyze this repository.";

export async function promptConfirmAttestation(
  streams: PromptStreams = DEFAULT_STREAMS
): Promise<boolean> {
  const rl = createInterface(streams);
  try {
    const answer = await questionOrThrowOnClose(
      rl,
      `${ATTESTATION_TEXT} (y/N) `,
      "Input closed before authorization was confirmed."
    );
    return answer.trim().toLowerCase().startsWith("y");
  } finally {
    rl.close();
  }
}

/**
 * Asked ONLY in a real interactive terminal, right after
 * public-remote.ts's `publicHostWarning` notice has been printed
 * (non-blocking, via `warn()`) — see build-bundle.ts. Y-default: Enter
 * continues with the local scan, matching the other single-candidate Y/n
 * confirmations in this file. Answering "n" is the one path that aborts
 * before anything is scanned; the caller is responsible for exiting
 * cleanly (exit code 0) and pointing at the GitHub App as the alternative.
 */
export async function promptContinueLocally(streams: PromptStreams = DEFAULT_STREAMS): Promise<boolean> {
  const rl = createInterface(streams);
  try {
    const answer = await questionOrThrowOnClose(
      rl,
      "Continue locally? (Y/n) ",
      "Input closed before the connectable-repo prompt was answered."
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
        "Input closed before a private label was entered."
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

/** Separate confirmation from promptConfirmAttestation — "I'm authorized to
 * scan" and "upload this specific bundle" are different questions. */
export async function promptConfirmUpload(streams: PromptStreams = DEFAULT_STREAMS): Promise<boolean> {
  const rl = createInterface(streams);
  try {
    const answer = await questionOrThrowOnClose(
      rl,
      "Upload this bundle? (y/n) ",
      "Input closed before the upload was confirmed."
    );
    return answer.trim().toLowerCase().startsWith("y");
  } finally {
    rl.close();
  }
}
