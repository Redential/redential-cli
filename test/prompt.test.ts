import { describe, expect, it } from "vitest";
import { Readable, Writable } from "node:stream";
import { promptAuthors, promptConfirmAttestation, promptConfirmUpload } from "../src/prompt.js";
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
});

describe("promptAuthors — single candidate (Y/n confirmation, Y default)", () => {
  const only = { email: "user@example.com", count: 250 };

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
