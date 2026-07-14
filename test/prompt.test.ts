import { describe, expect, it } from "vitest";
import { Readable, Writable } from "node:stream";
import {
  promptAuthors,
  promptConfirmAttestation,
  promptConfirmUpload,
  promptContinueLocally,
  promptUseGitIdentity,
} from "../src/prompt.js";
import { ScanError } from "../src/scan.js";

// Stdin closed/EOF before an answer (e.g. piped input in a script or CI)
// must fail loudly, not hang forever and let the process exit 0 silently.
function endedInput(): Readable {
  const input = new Readable({ read() {} });
  input.push(null);
  return input;
}

// Feeds a single line (as if the user typed it and hit Enter) then EOF.
function lineInput(line: string): Readable {
  const input = new Readable({ read() {} });
  input.push(`${line}\n`);
  input.push(null);
  return input;
}

function sinkOutput(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
}

// Captures every chunk readline writes to `output` (which includes the
// prompt text itself) — used below to assert on exact console-UX copy.
function captureOutput(): { stream: Writable; text: () => string } {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  return { stream, text: () => Buffer.concat(chunks).toString("utf8") };
}

describe("prompt EOF handling", () => {
  it("promptConfirmAttestation rejects when input closes before an answer", async () => {
    await expect(
      promptConfirmAttestation({ input: endedInput(), output: sinkOutput() })
    ).rejects.toBeInstanceOf(ScanError);
  });

  it("promptAuthors rejects when input closes before an answer", async () => {
    await expect(
      promptAuthors([{ email: "a@example.com", count: 1 }], {
        input: endedInput(),
        output: sinkOutput(),
      })
    ).rejects.toBeInstanceOf(ScanError);
  });

  it("promptConfirmUpload rejects when input closes before an answer", async () => {
    await expect(
      promptConfirmUpload({ input: endedInput(), output: sinkOutput() })
    ).rejects.toBeInstanceOf(ScanError);
  });

  it("promptUseGitIdentity rejects when input closes before an answer", async () => {
    await expect(
      promptUseGitIdentity({ email: "a@example.com", count: 1 }, { input: endedInput(), output: sinkOutput() })
    ).rejects.toBeInstanceOf(ScanError);
  });

  it("promptContinueLocally rejects when input closes before an answer", async () => {
    await expect(
      promptContinueLocally({ input: endedInput(), output: sinkOutput() })
    ).rejects.toBeInstanceOf(ScanError);
  });
});

describe("promptContinueLocally — Y/n confirmation, Y default (console-UX milestone)", () => {
  it("prints exactly 'Continue locally? (Y/n) '", async () => {
    const out = captureOutput();
    await promptContinueLocally({ input: lineInput(""), output: out.stream });
    expect(out.text()).toBe("Continue locally? (Y/n) ");
  });

  it("accepts on Enter (empty answer), defaulting to yes", async () => {
    const result = await promptContinueLocally({ input: lineInput(""), output: sinkOutput() });
    expect(result).toBe(true);
  });

  it("accepts on an explicit y/Y", async () => {
    const result = await promptContinueLocally({ input: lineInput("Y"), output: sinkOutput() });
    expect(result).toBe(true);
  });

  it("declines on an explicit n", async () => {
    const result = await promptContinueLocally({ input: lineInput("n"), output: sinkOutput() });
    expect(result).toBe(false);
  });
});

describe("promptConfirmAttestation — new copy, default flips to N (console-UX milestone)", () => {
  it("prints exactly 'Confirm you are authorized to analyze this repository. (y/N) '", async () => {
    const out = captureOutput();
    await promptConfirmAttestation({ input: lineInput("y"), output: out.stream });
    expect(out.text()).toBe("Confirm you are authorized to analyze this repository. (y/N) ");
  });

  it("Enter (empty answer) now DECLINES — the user must type y", async () => {
    const result = await promptConfirmAttestation({ input: lineInput(""), output: sinkOutput() });
    expect(result).toBe(false);
  });

  it("accepts only on an explicit y/Y", async () => {
    const result = await promptConfirmAttestation({ input: lineInput("y"), output: sinkOutput() });
    expect(result).toBe(true);
  });

  it("declines on an explicit n", async () => {
    const result = await promptConfirmAttestation({ input: lineInput("n"), output: sinkOutput() });
    expect(result).toBe(false);
  });
});

describe("promptUseGitIdentity — Y/n confirmation, Y default", () => {
  const candidate = { email: "you@example.com", count: 42 };

  it("prints the new 'Found <n> commits authored by <email>. Use this identity? (Y/n)' copy, thousands-separated", async () => {
    const out = captureOutput();
    await promptUseGitIdentity(
      { email: "you@example.com", count: 1378 },
      { input: lineInput(""), output: out.stream }
    );
    expect(out.text()).toBe("Found 1,378 commits authored by you@example.com. Use this identity? (Y/n) ");
  });

  it("accepts on Enter (empty answer), defaulting to yes", async () => {
    const result = await promptUseGitIdentity(candidate, { input: lineInput(""), output: sinkOutput() });
    expect(result).toBe(true);
  });

  it("accepts on an explicit y/Y", async () => {
    const result = await promptUseGitIdentity(candidate, { input: lineInput("Y"), output: sinkOutput() });
    expect(result).toBe(true);
  });

  it("declines on an explicit n", async () => {
    const result = await promptUseGitIdentity(candidate, { input: lineInput("n"), output: sinkOutput() });
    expect(result).toBe(false);
  });
});

describe("promptAuthors — single candidate (Y/n confirmation, Y default)", () => {
  const only = { email: "user@example.com", count: 250 };

  it("prints the same new 'Found <n> commits authored by <email>. Use this identity? (Y/n)' copy, thousands-separated", async () => {
    const out = captureOutput();
    await promptAuthors([{ email: "user@example.com", count: 1378 }], { input: lineInput(""), output: out.stream });
    expect(out.text()).toBe("Found 1,378 commits authored by user@example.com. Use this identity? (Y/n) ");
  });

  it("accepts on Enter (empty answer), defaulting to yes", async () => {
    const result = await promptAuthors([only], { input: lineInput(""), output: sinkOutput() });
    expect(result).toEqual(["user@example.com"]);
  });

  it("accepts on an explicit y/Y", async () => {
    const result = await promptAuthors([only], { input: lineInput("Y"), output: sinkOutput() });
    expect(result).toEqual(["user@example.com"]);
  });

  it("declines on an explicit n, returning no authors", async () => {
    const result = await promptAuthors([only], { input: lineInput("n"), output: sinkOutput() });
    expect(result).toEqual([]);
  });
});

describe("promptAuthors — 2+ candidates (numbered list, unchanged)", () => {
  const candidates = [
    { email: "a@example.com", count: 3 },
    { email: "b@example.com", count: 1 },
  ];

  it("selects the entries matching the comma-separated numbers", async () => {
    const result = await promptAuthors(candidates, { input: lineInput("1,2"), output: sinkOutput() });
    expect(result).toEqual(["a@example.com", "b@example.com"]);
  });

  it("selects only the single number given", async () => {
    const result = await promptAuthors(candidates, { input: lineInput("2"), output: sinkOutput() });
    expect(result).toEqual(["b@example.com"]);
  });

  it("ignores out-of-range numbers", async () => {
    const result = await promptAuthors(candidates, { input: lineInput("1,9"), output: sinkOutput() });
    expect(result).toEqual(["a@example.com"]);
  });
});
