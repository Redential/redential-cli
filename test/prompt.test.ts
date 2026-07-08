import { describe, expect, it } from "vitest";
import { Readable, Writable } from "node:stream";
import { promptAuthors, promptConfirmAttestation } from "../src/prompt.js";
import { ScanError } from "../src/scan.js";

// Stdin closed/EOF before an answer (e.g. piped input in a script or CI)
// must fail loudly, not hang forever and let the process exit 0 silently.
function endedInput(): Readable {
  const input = new Readable({ read() {} });
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
});
