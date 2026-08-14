import { afterEach, describe, expect, it, vi } from "vitest";
import { Readable, Writable } from "node:stream";
import {
  promptAddToProfile,
  promptAuthors,
  promptConfirmScan,
  promptConfirmUpload,
  promptPrivateLabel,
  promptUseGitIdentity,
  promptUseSavedSelection,
} from "../src/prompt.js";
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

// Feeds several lines in sequence (as if the user answered a re-asked
// prompt multiple times) — used by promptPrivateLabel's re-ask tests
// below. Unlike `lineInput`, this can't push every line eagerly up front:
// node's readline parses every already-buffered line in one pass and
// silently drops any line that arrives while no `rl.question()` callback
// is currently pending (readline re-emits it as a bare 'line' event
// instead, which nothing here listens for) — so pushing all 3 lines
// synchronously loses lines 2 and 3 before the second/third question() is
// even called. Delivering each line via `setImmediate` inside `_read()`
// instead lets each answer be consumed (and the next `question()` call
// issued) before the following line arrives. Never signals EOF (no
// `push(null)`) — none of the tests using this need it, since
// promptPrivateLabel either returns after a valid answer or throws
// synchronously after its final failed attempt, in both cases without
// calling `rl.question()` again.
function multiLineInput(...lines: string[]): Readable {
  let i = 0;
  return new Readable({
    read() {
      if (i >= lines.length) return;
      const line = lines[i];
      i++;
      setImmediate(() => this.push(`${line}\n`));
    },
  });
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
  it("promptConfirmScan rejects when input closes before an answer", async () => {
    await expect(
      promptConfirmScan([{ email: "a@example.com", count: 1 }], ["a@example.com"], {
        input: endedInput(),
        output: sinkOutput(),
      })
    ).rejects.toThrow(
      "Input closed before authorization was confirmed. Use --author <email> and --yes for non-interactive runs."
    );
  });

  it("promptAuthors rejects when input closes before an answer (2+ candidates)", async () => {
    await expect(
      promptAuthors(
        [
          { email: "a@example.com", count: 1 },
          { email: "b@example.com", count: 1 },
        ],
        {
          input: endedInput(),
          output: sinkOutput(),
        }
      )
    ).rejects.toThrow(
      "Input closed before an author identity was selected. Use --author <email> and --yes for non-interactive runs."
    );
  });

  it("promptConfirmUpload rejects when input closes before an answer", async () => {
    await expect(
      promptConfirmUpload({ input: endedInput(), output: sinkOutput() })
    ).rejects.toThrow(
      "Input closed before the upload was confirmed. Use --confirm-upload for non-interactive runs."
    );
  });

  it("promptUseGitIdentity rejects when input closes before an answer", async () => {
    await expect(
      promptUseGitIdentity({ email: "a@example.com", count: 1 }, { input: endedInput(), output: sinkOutput() })
    ).rejects.toThrow(
      "Input closed before an author identity was selected. Use --author <email> and --yes for non-interactive runs."
    );
  });

  it("promptAddToProfile rejects when input closes before an answer", async () => {
    await expect(
      promptAddToProfile({ input: endedInput(), output: sinkOutput() })
    ).rejects.toThrow("Input closed before the profile-upload prompt was answered.");
  });

  it("promptUseSavedSelection rejects when input closes before an answer", async () => {
    await expect(
      promptUseSavedSelection(["a@example.com"], { input: endedInput(), output: sinkOutput() })
    ).rejects.toThrow(
      "Input closed before an author identity was selected. Use --author <email> and --yes for non-interactive runs."
    );
  });

  it("promptPrivateLabel rejects when input closes before an answer", async () => {
    await expect(
      promptPrivateLabel({ input: endedInput(), output: sinkOutput() })
    ).rejects.toThrow(
      "Input closed before a private label was entered. Use --label for non-interactive runs."
    );
  });
});

describe("promptPrivateLabel — mandatory, re-asks up to 2 times on an invalid answer", () => {
  const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  afterEach(() => {
    consoleErrorSpy.mockClear();
  });

  it("prints exactly 'Private label for this repo (only you will ever see it): '", async () => {
    const out = captureOutput();
    await promptPrivateLabel({ input: lineInput("Acme Corp"), output: out.stream });
    expect(out.text()).toBe("Private label for this repo (only you will ever see it): ");
  });

  it("accepts a valid answer on the first attempt, trimmed", async () => {
    const result = await promptPrivateLabel({ input: lineInput("  Acme Corp  "), output: sinkOutput() });
    expect(result).toBe("Acme Corp");
  });

  it("re-asks once on an empty answer, then accepts a valid second answer", async () => {
    const result = await promptPrivateLabel({
      input: multiLineInput("", "Acme Corp"),
      output: sinkOutput(),
    });
    expect(result).toBe("Acme Corp");
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy.mock.calls[0][0]).toContain("cannot be empty");
  });

  it("re-asks on 2 consecutive invalid answers, then accepts a valid 3rd answer (the max)", async () => {
    const result = await promptPrivateLabel({
      input: multiLineInput("", "", "Acme Corp"),
      output: sinkOutput(),
    });
    expect(result).toBe("Acme Corp");
    expect(consoleErrorSpy).toHaveBeenCalledTimes(2);
  });

  it("after 3 empty answers (1 initial + 2 retries), throws the validation error rather than asking again", async () => {
    await expect(
      promptPrivateLabel({ input: multiLineInput("", "", ""), output: sinkOutput() })
    ).rejects.toThrow(/cannot be empty/);
  });

  it("also re-asks on a non-empty but otherwise invalid answer (e.g. too long), same as an empty one", async () => {
    const tooLong = "a".repeat(65);
    const result = await promptPrivateLabel({
      input: multiLineInput(tooLong, "Acme Corp"),
      output: sinkOutput(),
    });
    expect(result).toBe("Acme Corp");
    expect(consoleErrorSpy.mock.calls[0][0]).toContain("64 characters or fewer");
  });
});

describe("promptConfirmScan — unified identity+authorization confirm, default flips to N (console-UX overhaul)", () => {
  it("prints exactly 'Scan <N> commits by <email>? This confirms you're authorized to analyze this repository. (y/N) ' for a single author", async () => {
    const out = captureOutput();
    await promptConfirmScan([{ email: "you@example.com", count: 1378 }], ["you@example.com"], {
      input: lineInput("y"),
      output: out.stream,
    });
    expect(out.text()).toBe(
      "Scan 1,378 commits by you@example.com? This confirms you're authorized to analyze this repository. (y/N) "
    );
  });

  it("prints singular commit wording for one commit", async () => {
    const out = captureOutput();
    await promptConfirmScan([{ email: "you@example.com", count: 1 }], ["you@example.com"], {
      input: lineInput("y"),
      output: out.stream,
    });
    expect(out.text()).toBe(
      "Scan 1 commit by you@example.com? This confirms you're authorized to analyze this repository. (y/N) "
    );
  });

  it("sums commit counts and lists every selected email for a multi-identity selection", async () => {
    const out = captureOutput();
    await promptConfirmScan(
      [
        { email: "a@example.com", count: 3 },
        { email: "b@example.com", count: 5 },
      ],
      ["a@example.com", "b@example.com"],
      { input: lineInput("y"), output: out.stream }
    );
    expect(out.text()).toContain("Scan 8 commits by a@example.com, b@example.com?");
  });

  it("Enter (empty answer) DECLINES — the user must type y", async () => {
    const result = await promptConfirmScan([{ email: "you@example.com", count: 1 }], ["you@example.com"], {
      input: lineInput(""),
      output: sinkOutput(),
    });
    expect(result).toBe(false);
  });

  it("accepts only on an explicit y/Y", async () => {
    const result = await promptConfirmScan([{ email: "you@example.com", count: 1 }], ["you@example.com"], {
      input: lineInput("y"),
      output: sinkOutput(),
    });
    expect(result).toBe(true);
  });

  it("declines on an explicit n", async () => {
    const result = await promptConfirmScan([{ email: "you@example.com", count: 1 }], ["you@example.com"], {
      input: lineInput("n"),
      output: sinkOutput(),
    });
    expect(result).toBe(false);
  });
});

describe("promptAddToProfile — Y/n confirmation, Y default (console-UX overhaul)", () => {
  it("prints exactly 'Add this to your Redential profile? (Y/n) '", async () => {
    const out = captureOutput();
    await promptAddToProfile({ input: lineInput(""), output: out.stream });
    expect(out.text()).toBe("Add this to your Redential profile? (Y/n) ");
  });

  it("accepts on Enter (empty answer), defaulting to yes", async () => {
    const result = await promptAddToProfile({ input: lineInput(""), output: sinkOutput() });
    expect(result).toBe(true);
  });

  it("declines on an explicit n", async () => {
    const result = await promptAddToProfile({ input: lineInput("n"), output: sinkOutput() });
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

  it("prints singular commit wording for one commit", async () => {
    const out = captureOutput();
    await promptUseGitIdentity(
      { email: "you@example.com", count: 1 },
      { input: lineInput(""), output: out.stream }
    );
    expect(out.text()).toBe("Found 1 commit authored by you@example.com. Use this identity? (Y/n) ");
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

describe("promptAuthors — single candidate: taken directly, no prompt at all (console-UX overhaul)", () => {
  const only = { email: "user@example.com", count: 250 };

  it("returns the sole candidate's email without asking anything", async () => {
    const out = captureOutput();
    // No input at all is provided/consumed — if this ever tried to read
    // from `input`, the test would hang instead of resolving.
    const result = await promptAuthors([only], { input: endedInput(), output: out.stream });
    expect(result).toEqual(["user@example.com"]);
    expect(out.text()).toBe("");
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

  it("an empty answer returns [] when no preselected emails are given (byte-identical to before)", async () => {
    const result = await promptAuthors(candidates, { input: lineInput(""), output: sinkOutput() });
    expect(result).toEqual([]);
  });
});

describe("promptAuthors — 2+ candidates with a preselected saved selection", () => {
  const candidates = [
    { email: "a@example.com", count: 3 },
    { email: "b@example.com", count: 1 },
    { email: "c@example.com", count: 2 },
  ];

  it("prompt text includes '[Enter = <n1>,<n2>]' for the still-present preselected emails", async () => {
    const out = captureOutput();
    await promptAuthors(candidates, { input: lineInput(""), output: out.stream }, [
      "a@example.com",
      "c@example.com",
    ]);
    expect(out.text()).toContain("Enter the numbers, comma-separated (e.g. 1,3) [Enter = 1,3]: ");
  });

  it("an empty answer returns the preselected emails", async () => {
    const result = await promptAuthors(candidates, { input: lineInput(""), output: sinkOutput() }, [
      "a@example.com",
      "c@example.com",
    ]);
    expect(result).toEqual(["a@example.com", "c@example.com"]);
  });

  it("a non-empty answer overrides the preselection", async () => {
    const result = await promptAuthors(candidates, { input: lineInput("2"), output: sinkOutput() }, [
      "a@example.com",
      "c@example.com",
    ]);
    expect(result).toEqual(["b@example.com"]);
  });

  it("falls back to today's behavior when none of the preselected emails are present", async () => {
    const out = captureOutput();
    const result = await promptAuthors(candidates, { input: lineInput(""), output: out.stream }, [
      "gone@example.com",
    ]);
    expect(out.text()).toContain("Enter the numbers, comma-separated (e.g. 1,3): ");
    expect(result).toEqual([]);
  });

  it("falls back to today's behavior when preselectedEmails is absent", async () => {
    const result = await promptAuthors(candidates, { input: lineInput(""), output: sinkOutput() });
    expect(result).toEqual([]);
  });
});

describe("promptUseSavedSelection — Y/n confirmation, Y default", () => {
  it("prints exactly 'Use your saved identity selection: a@example.com, b@example.com? (Y/n) '", async () => {
    const out = captureOutput();
    await promptUseSavedSelection(["a@example.com", "b@example.com"], {
      input: lineInput(""),
      output: out.stream,
    });
    expect(out.text()).toBe("Use your saved identity selection: a@example.com, b@example.com? (Y/n) ");
  });

  it("accepts on Enter (empty answer), defaulting to yes", async () => {
    const result = await promptUseSavedSelection(["a@example.com"], {
      input: lineInput(""),
      output: sinkOutput(),
    });
    expect(result).toBe(true);
  });

  it("declines on an explicit n", async () => {
    const result = await promptUseSavedSelection(["a@example.com"], {
      input: lineInput("n"),
      output: sinkOutput(),
    });
    expect(result).toBe(false);
  });
});
