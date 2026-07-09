import { createInterface, type Interface } from "node:readline/promises";
import { ScanError } from "./errors.js";

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
        `Found 1 identity: ${formatCandidate(only)}. Is this you? (Y/n) `,
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

const ATTESTATION_TEXT = "I am authorized to analyze this repository.";

export async function promptConfirmAttestation(
  streams: PromptStreams = DEFAULT_STREAMS
): Promise<boolean> {
  const rl = createInterface(streams);
  try {
    const answer = await questionOrThrowOnClose(
      rl,
      `${ATTESTATION_TEXT} Confirm? (y/n) `,
      "Input closed before authorization was confirmed."
    );
    return answer.trim().toLowerCase().startsWith("y");
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
