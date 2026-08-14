import { afterEach, describe, expect, it, vi } from "vitest";
import { Readable, Writable } from "node:stream";
import {
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
    // Bug fix (owner follow-up, 2026-08): promptUseGitIdentity now
    // delegates straight to promptConfirmScan, so it EOF-rejects with that
    // function's own message ("... authorization was confirmed ..."), not
    // the author-selection one — see promptConfirmScan's own EOF test above
    // for that exact string.
    await expect(
      promptUseGitIdentity({ email: "a@example.com", count: 1 }, { input: endedInput(), output: sinkOutput() })
    ).rejects.toThrow(
      "Input closed before authorization was confirmed. Use --author <email> and --yes for non-interactive runs."
    );
  });

  it("promptUseSavedSelection rejects when input closes before an answer", async () => {
    // Bug fix (owner follow-up, 2026-08): same delegation as
    // promptUseGitIdentity above — now takes `candidates` too (needed for
    // promptConfirmScan's commit-count lookup).
    await expect(
      promptUseSavedSelection(["a@example.com"], [{ email: "a@example.com", count: 1 }], {
        input: endedInput(),
        output: sinkOutput(),
      })
    ).rejects.toThrow(
      "Input closed before authorization was confirmed. Use --author <email> and --yes for non-interactive runs."
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

describe("promptConfirmScan — the CLI's ONE true authorization gate: no default, re-asks until explicit y/n (owner directive, 2026-08)", () => {
  it("prints exactly 'Scan <N> commits by <email>? This confirms you're authorized to analyze this repository. (y/n) ' for a single author", async () => {
    const out = captureOutput();
    await promptConfirmScan([{ email: "you@example.com", count: 1378 }], ["you@example.com"], {
      input: lineInput("y"),
      output: out.stream,
    });
    expect(out.text()).toBe(
      "Scan 1,378 commits by you@example.com? This confirms you're authorized to analyze this repository. (y/n) "
    );
  });

  it("prints singular commit wording for one commit", async () => {
    const out = captureOutput();
    await promptConfirmScan([{ email: "you@example.com", count: 1 }], ["you@example.com"], {
      input: lineInput("y"),
      output: out.stream,
    });
    expect(out.text()).toBe(
      "Scan 1 commit by you@example.com? This confirms you're authorized to analyze this repository. (y/n) "
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

  it("accepts only on an explicit y/Y/yes", async () => {
    for (const answer of ["y", "Y", "yes", "YES"]) {
      const result = await promptConfirmScan([{ email: "you@example.com", count: 1 }], ["you@example.com"], {
        input: lineInput(answer),
        output: sinkOutput(),
      });
      expect(result).toBe(true);
    }
  });

  it("declines on an explicit n/N/no", async () => {
    for (const answer of ["n", "N", "no", "NO"]) {
      const result = await promptConfirmScan([{ email: "you@example.com", count: 1 }], ["you@example.com"], {
        input: lineInput(answer),
        output: sinkOutput(),
      });
      expect(result).toBe(false);
    }
  });

  it("Enter (empty answer) RE-ASKS — neither proceeds nor cancels — until an explicit y or n is given", async () => {
    const out = captureOutput();
    // Two empty answers, then an explicit "y" — the question must be asked
    // (and re-asked) exactly 3 times before resolving.
    const result = await promptConfirmScan([{ email: "you@example.com", count: 1 }], ["you@example.com"], {
      input: multiLineInput("", "", "y"),
      output: out.stream,
    });
    expect(result).toBe(true);
    const askedCount = (
      out.text().match(/Scan 1 commit by you@example\.com\? This confirms you're authorized/g) ?? []
    ).length;
    expect(askedCount).toBe(3);
  });

  it("a non-empty, non-y/n answer also re-asks (never inferred as either)", async () => {
    const result = await promptConfirmScan([{ email: "you@example.com", count: 1 }], ["you@example.com"], {
      input: multiLineInput("maybe", "n"),
      output: sinkOutput(),
    });
    expect(result).toBe(false);
  });

  it("EOF while looping still throws the same closed-input error as a first-attempt EOF", async () => {
    // One empty (re-asked) answer, then the stream ends with no further
    // input — the SAME error as an immediate EOF on the very first ask.
    await expect(
      promptConfirmScan([{ email: "you@example.com", count: 1 }], ["you@example.com"], {
        input: lineInput(""),
        output: sinkOutput(),
      })
    ).rejects.toThrow(
      "Input closed before authorization was confirmed. Use --author <email> and --yes for non-interactive runs."
    );
  });
});

describe("promptUseGitIdentity — delegates to promptConfirmScan (bug fix, owner follow-up 2026-08)", () => {
  const candidate = { email: "you@example.com", count: 42 };

  // Reproduced via pty: this used to print its own separate "Found N
  // commits authored by X. Use this identity? (Y/n)" line, ALWAYS followed
  // by a second, redundant promptConfirmScan call from build-bundle.ts —
  // two questions in a row for the same decision.
  //
  // Consistency fix (owner directive, 2026-08): this question's "yes"
  // GRANTS AUTHORIZATION (same sentence promptConfirmScan itself asks), so
  // it now shares that function's exact no-default/re-ask behavior too —
  // "(y/n)", not "(Y/n)". A Y-default here would let a bare Enter silently
  // grant authorization on the most common repeat-scan path, which is
  // exactly what the owner's rule forbids: ANY question whose yes grants
  // authorization uses the no-default re-ask loop, on every path.
  it("prints the unified 'Scan <N> commits by <email>? ... (y/n)' text, thousands-separated", async () => {
    const out = captureOutput();
    await promptUseGitIdentity(
      { email: "you@example.com", count: 1378 },
      { input: lineInput("y"), output: out.stream }
    );
    expect(out.text()).toBe(
      "Scan 1,378 commits by you@example.com? This confirms you're authorized to analyze this repository. (y/n) "
    );
  });

  it("accepts only on an explicit y/Y/yes", async () => {
    const result = await promptUseGitIdentity(candidate, { input: lineInput("y"), output: sinkOutput() });
    expect(result).toBe(true);
  });

  it("declines on an explicit n/N/no", async () => {
    const result = await promptUseGitIdentity(candidate, { input: lineInput("n"), output: sinkOutput() });
    expect(result).toBe(false);
  });

  it("Enter (empty answer) RE-ASKS — neither grants nor declines authorization — until an explicit y or n", async () => {
    const out = captureOutput();
    const result = await promptUseGitIdentity(candidate, {
      input: multiLineInput("", "", "y"),
      output: out.stream,
    });
    expect(result).toBe(true);
    const askedCount = (
      out.text().match(/Scan 42 commits by you@example\.com\? This confirms you're authorized/g) ?? []
    ).length;
    expect(askedCount).toBe(3);
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

describe("promptUseSavedSelection — delegates to promptConfirmScan (bug fix, owner follow-up 2026-08)", () => {
  const candidates = [
    { email: "a@example.com", count: 3 },
    { email: "b@example.com", count: 5 },
  ];

  // Same bug/fix as promptUseGitIdentity above — was its own separate
  // "Use your saved identity selection: ...? (Y/n)" line, always followed
  // by a redundant second confirmation. Consistency fix (owner directive,
  // 2026-08): this question's "yes" also grants authorization, so it now
  // shares promptConfirmScan's exact no-default/re-ask behavior too.
  it("prints the unified 'Scan <N> commits by <emails>? ... (y/n)' text", async () => {
    const out = captureOutput();
    await promptUseSavedSelection(["a@example.com", "b@example.com"], candidates, {
      input: lineInput("y"),
      output: out.stream,
    });
    expect(out.text()).toBe(
      "Scan 8 commits by a@example.com, b@example.com? This confirms you're authorized to analyze this repository. (y/n) "
    );
  });

  it("declines on an explicit n", async () => {
    const result = await promptUseSavedSelection(["a@example.com"], [{ email: "a@example.com", count: 1 }], {
      input: lineInput("n"),
      output: sinkOutput(),
    });
    expect(result).toBe(false);
  });

  it("accepts on an explicit y", async () => {
    const result = await promptUseSavedSelection(["a@example.com"], [{ email: "a@example.com", count: 1 }], {
      input: lineInput("y"),
      output: sinkOutput(),
    });
    expect(result).toBe(true);
  });

  it("Enter (empty answer) RE-ASKS — neither grants nor declines authorization — until an explicit y or n", async () => {
    const out = captureOutput();
    const result = await promptUseSavedSelection(["a@example.com"], [{ email: "a@example.com", count: 1 }], {
      input: multiLineInput("", "n"),
      output: out.stream,
    });
    expect(result).toBe(false);
    const askedCount = (
      out.text().match(/Scan 1 commit by a@example\.com\? This confirms you're authorized/g) ?? []
    ).length;
    expect(askedCount).toBe(2);
  });
});

describe("promptConfirmUpload — the single merged upload confirmation, Y-default (owner directive, 2026-08)", () => {
  // Owner directive, 2026-08: this is now THE single upload confirmation
  // — `scan`'s old separate "Add this to your Redential profile?" prompt
  // is gone (scan-command.ts continues straight into this same prompt
  // instead), and this text was retargeted accordingly.
  it("prints exactly 'Upload this to your Redential profile? (Y/n) '", async () => {
    const out = captureOutput();
    await promptConfirmUpload({ input: lineInput(""), output: out.stream });
    expect(out.text()).toBe("Upload this to your Redential profile? (Y/n) ");
  });

  it("Enter (empty answer) accepts, defaulting to yes", async () => {
    const result = await promptConfirmUpload({ input: lineInput(""), output: sinkOutput() });
    expect(result).toBe(true);
  });

  it("accepts on an explicit y/Y", async () => {
    const result = await promptConfirmUpload({ input: lineInput("y"), output: sinkOutput() });
    expect(result).toBe(true);
  });

  it("declines on an explicit n", async () => {
    const result = await promptConfirmUpload({ input: lineInput("n"), output: sinkOutput() });
    expect(result).toBe(false);
  });
});
