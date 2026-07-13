# `redential scan`

Reads git history from a local repository and prints the exact proof bundle
that `submit` would upload later — nothing is sent anywhere by `scan` itself.

```bash
redential scan --repo <path>              # interactive author + confirmation
redential scan --author you@example.com --yes   # non-interactive
redential scan --repo <path> --json       # force JSON-only, even in a terminal
redential scan --since 2years             # limit analysis to the last 2 years
redential scan --debug --repo <path>      # verbose diagnostics on stderr
```

## How it works

1. **Enumerate authors.** `git log` is read locally (`git show`/`git diff`
   never leave the machine) to list distinct author emails and their commit
   counts.
2. **Select identity.** With 2+ candidates, and the repo's own
   `git config user.email` matching one of them, that one is offered FIRST
   as a fast default: "Found your git identity: you@example.com (12
   commits). Use it? (Y/n)", Y is the default. Declining — or no match at
   all — falls through unchanged to the flow below: a single candidate
   gets its own Y/n confirmation ("Found 1 identity: you@example.com (12
   commits). Is this you? (Y/n)"); 2+ candidates get a numbered list
   instead (skipping the git-identity pre-selection specifically to avoid
   asking the same yes/no question twice in a row for a repo with exactly
   one contributor). Declining the git-identity pre-selection shows the
   FULL list, including the declined entry — "no" often means "that one
   plus others" for a multi-identity repo, not "not that one at all".
   Non-interactively, pass `--author <email>` (repeatable) for every email
   that's yours — this skips identity selection entirely, unaffected by
   any of the above.
3. **Confirm authorization.** You must explicitly confirm "I am authorized
   to analyze this repository" — interactively via a prompt, or
   non-interactively via `--yes`. This is a separate step from author
   selection on purpose: `--author` only answers "which emails are mine",
   not "I'm allowed to scan this repo". Both are required before a bundle
   is produced.
4. **Compute the bundle.** Every field in `schema/bundle.v1.json` is derived
   from `git log --numstat` filtered to your selected commits: volume, span,
   hourly/weekday cadence, signed-commit ratio, churn share by file
   extension and by technical category (heuristic path/extension matching),
   ownership share against the repo's total commits, and detected skills
   (deterministic local matching of your commits' diffs against
   `signatures/*.json` — see [docs/signatures.md](signatures.md); zero
   network, closed vocabulary, `detected_skills` may be empty if nothing
   matched).
5. **Print it.** The JSON printed IS the bundle — byte for byte what
   `submit` would send later.

## The consent summary

When stdout is an interactive terminal, `scan` prints a short human-readable
**consent summary** BEFORE the exact JSON bundle — a boxed block, same
visual language as the "wrapped" summary below (Unicode box-drawing
characters + ANSI on rich terminals, the same ASCII fallback on plain
Windows `conhost` via `shouldUsePlainOutput`), listing:

- **What IS uploaded** — the commit count and span, the number of detected
  skills with the top 3 skill names, "time patterns, languages and
  categories as aggregates", and "salted fingerprints". Every number in
  this block is read off the actual bundle being printed right below it —
  nothing here is hardcoded or computed separately.
- **What is NEVER uploaded** — source code, file names, commit messages,
  the repo's name, and other contributors' identities.

It's built by `formatConsentSummary` (`src/summary.ts`), pure formatting
over the bundle `scan` already computed: no new data collection, no
network, no schema change — it only restates, in plain language, what's
already in the JSON that follows it.

Right after the block, a header line makes explicit that what follows is
the literal payload:

```
Exact payload (byte-for-byte what `redential submit` would send):
```

("would", since `scan` itself never uploads anything — see
[login-submit.md](login-submit.md#submit-review-then-upload) for the
equivalent header `submit` prints before its own confirmation prompt.)

**Piped stdout and `--json` are unaffected.** `scan | jq` (or any
redirected/piped stdout) still prints **only** the raw JSON, byte-identical
to every prior release; `--json` forces that same JSON-only output even on
a terminal. The consent summary — like the wrapped summary below it — is
strictly a TTY-only addition on top of an unchanged stdout contract.

On a real TTY, the full output order is now: consent summary → "Exact
payload…" header → JSON → wrapped summary (the wrapped summary described
next stays last, unchanged).

## The "wrapped" summary

When stdout is an interactive terminal, `scan` prints the full JSON bundle
(exactly as always, now preceded by the consent summary above), then a
human-readable summary **after** it —
total commits and span, an hour-of-day and weekday cadence, top languages
and categories, detected skills, ownership and signed-commit ratios —
under a divider. It's printed last on purpose: the JSON scrolls up, and
the summary is what's left on screen once the command finishes. It's
rendered with ANSI colors and Unicode box-drawing characters only (no new
dependency), and is derived entirely from the bundle `scan` already
computed: no new data collection, no network, nothing beyond what's
already in the JSON above it.

**Plain-terminal fallback.** Plain Windows `conhost` (`cmd.exe` / classic
PowerShell without Windows Terminal) doesn't reliably render either ANSI
escapes or the Unicode block/box-drawing characters above on a legacy
console codepage. `shouldUsePlainOutput` (`src/summary.ts`) detects this —
`win32` with none of `WT_SESSION`/`TERM_PROGRAM`/`ConEmuANSI=ON` set (all
three mark a modern, UTF-8-and-ANSI-capable wrapper: Windows Terminal, VS
Code's integrated terminal, ConEmu) — and swaps in a pure-ASCII, no-color
theme instead: `#`/`-` bars, `+`/`=`/`|` box corners/edges, `.` through `#`
sparkline levels. Every other platform, and every recognized Windows
terminal, gets the rich theme. Same data either way — this only changes
how it's drawn.

```
{
  "schema_version": "1.2.0",
  ...
}

  ────────────────────────────────────────────────────────────

  ╔════════════════════════════════════════════════════════════╗
  ║                 YOUR PRIVATE REPO, WRAPPED                 ║
  ╚════════════════════════════════════════════════════════════╝

  2 years, 1,847 commits

  COMMITS BY HOUR (UTC)
  0     6     12    18
  ▁····▁▁▃▅█▇▄▃▂▂▁▁▁▁▁····

  COMMITS BY WEEKDAY
  Sun  ██░░░░░░░░░░░░░░░░░░  5
  Mon  ███████████████████░  40
  ...

  TOP LANGUAGES
  .ts    ████████████████████   62%
  ...

  SKILLS DETECTED
  ai/anthropic-api    14 commits
  ...

  Ownership       78% of this repo's commits are yours
  Signed commits  45% of your commits are cryptographically signed

  Nothing left your machine. Verify: github.com/Jppblue/redential-cli

  Want this on a public, verifiable profile?
  → redential login && redential submit
```

If your signed-commit ratio is 0%, one more line appears right under it:

```
  Signed commits  0% of your commits are cryptographically signed
  Tip: sign your commits (git config commit.gpgsign true) — signed history is the strongest anchor for your credential.
```

### Closing next-step hint

Below the "Nothing left your machine" line, the summary closes with a
next-step hint in one of three states — a plain local-state check
(`src/scan-command.ts`'s `nextStepsState`), never a network call:

1. **No stored session** (never logged in, or the stored session is for a
   different `SITE_URL`):
   ```
     Want this on a public, verifiable profile?
     → redential login && redential submit
   ```
2. **Stored session, but this exact bundle hasn't been uploaded yet**
   (nothing recorded locally yet, or the recorded hash doesn't match this
   scan's content — e.g. new commits since the last submit):
   ```
     Want this on a public, verifiable profile?
     → redential submit
   ```
3. **Stored session AND this exact bundle content was already uploaded**:
   no hint at all — re-submitting would send nothing new.

"This exact bundle" is decided by `bundleContentHash`
(`src/submission-record.ts`): a local, unsalted sha256 over the bundle with
the fields derived purely from wall-clock time stripped first
(`created_at`, `attestation.confirmed_at`, `repo.age_days`) — otherwise a
re-scan a moment (or a day) later would never match an otherwise-unchanged
repo. Everything else participates, including `tool_version` and
`detected_skills`: a CLI upgrade can genuinely change what the next
`submit` would upload, so it's deliberately never treated as still
identical. `redential submit` records this hash locally
(`<config dir>/last-submission.json`, alongside `credentials.json` — see
[login-submit.md](login-submit.md#where-the-token-lives)) right after a
successful upload; it's not a secret (just a hash of content you already
reviewed and already chose to upload), so unlike `credentials.json` it
isn't written with restricted file permissions.

This only happens on a real TTY. `scan | jq` (or any redirected/piped
stdout) prints **only** the raw JSON, byte-identical to before this
summary existed — `--json` forces that same JSON-only behavior even on a
terminal, for scripts that run interactively but still want machine
output.

## Huge repositories and `--since`

`scan` walks git history once, streaming the whole way through — it never
buffers a huge repo's full `git log` output in memory, and it never holds
more than one batch's worth of diff content at a time (skill detection
fetches added-line diffs in bounded batches of ~200 commits via a single
`git show` process per batch, not one process per commit). A
programmatically generated 20,000-commit fixture scans in a few seconds
(asserted under 60s in `test/slow/huge-repo.test.ts` — a separate suite
excluded from the default `npm test`, since building and scanning 20,000
commits, while still fast, shouldn't gate every quick local test run; run
it directly with `npm run test:slow`. CI runs it as its own job on
`ubuntu-latest`, see `.github/workflows/ci.yml`).

**Progress.** On a real TTY, `scan` prints a running line to **stderr**
(never stdout) while it walks history:

```
scanning commits... 12,400/80,000
```

throttled to roughly every 200 commits so a huge walk doesn't scroll
thousands of lines, and always finishing at the exact total. Piped or
redirected stdout (`scan | jq`, `--json`) gets **no progress output at
all** — `scan`'s stdout contract (JSON only, byte-identical either way) is
unaffected regardless of how large the repo is; this is covered by a test
(`test/scan-command.test.ts`'s "huge-repo progress" block) that asserts
piped output is identical whether or not a progress reporter would have
fired.

**`--since <spec>` limits the WALK, not the truth.** Pass a relative window
(`2years`, `18months`, `30days` — singular or plural) or an absolute date
(`2024-01-01`, or anything else JavaScript's `Date` parses):

```bash
redential scan --since 2years
redential scan --since 2024-01-01
```

This does **not** add any new field to the bundle. It changes which
commits the existing fields are computed over: `commits.user_total`,
`first_at`/`last_at`/`span_days`, the hour/weekday histograms,
`identity.other_contributors_count`, `ownership.user_commit_ratio`, and
`integrity.date_forensics` all simply reflect the analyzed window instead
of full history — see
[docs/schema.md](schema.md#commits) for the exact field-by-field
breakdown. This is strictly narrower disclosure than a full scan, never a
way to fabricate or hide history: a windowed scan can only ever show
*less* of the repo's real activity, never claim activity that didn't
happen. Two fields are deliberately **exempt** from the window and always
reflect the whole repo: `repo.age_days` and `repo.repo_fingerprint` (both
derived from the repo's true root commit) — otherwise a windowed scan
could misleadingly make an old repo look freshly created. On a TTY, the
wrapped summary states the active window next to the span line (e.g. "2
years, 1,847 commits (last 2 years)"), so it's never ambiguous whether a
window was applied.

If `--since` excludes every commit in the repo (but the repo isn't
actually empty), `scan` fails with a message naming the window rather than
the generic "no commits yet" error, so it's clear the fix is to widen or
drop `--since`, not that the repo has no history at all.

## Shallow clones

`git rev-parse --is-shallow-repository` is checked once per scan
(`src/git.ts`'s `isShallowRepository`). A shallow clone (`git clone
--depth N`, or the default checkout depth of most CI actions) is missing
history before its shallow boundary ENTIRELY — not filtered out like
`--since`, genuinely absent locally — so `commits.user_total`, span, and
`repo.age_days` would all silently understate real activity with no
indication why. `scan`/`submit` print a warning (same "warn, never block"
stance as the public-host note above) naming the remedy (`git fetch
--unshallow`) and continue with whatever history IS available; on a TTY,
the wrapped summary repeats a short note next to the span line too, so
it's visible even if the stderr warning scrolled past.

## `--debug`

```bash
redential scan --debug --repo <path>
redential --debug scan --repo <path>   # either position works
```

A global flag (works on every command). Writes verbose diagnostics to
**stderr only** — git commands run (argv only: shas, dates, flags — never
the repo path, which would reveal an employer/project name if pasted into
a public issue; never diff content or an author's email), phase timings
(commit walk, skill detection), and counts (commits walked, commits
matching the selected author, diff-fetch batches). Piped/redirected
stdout is completely unaffected — `scan --debug | jq` prints
byte-identical JSON to `scan | jq`, covered by a test
(`test/privacy/debug-output.test.ts`), which also asserts the stored
session token and bundle field values (fingerprints, hashes) can never
appear in `--debug` output, even if a future debugLog call got careless
about what it logs.

Implementation note: `src/debug.ts` is module-level mutable state — the
one deliberate exception to this codebase's everywhere-dependency-
injection style (every other cross-cutting concern is threaded explicitly
through an options object). Full DI would mean a `debugLog` parameter on
essentially every function in `git.ts`/`scan.ts`/`skill-detect.ts`; a
settable verbose-flag toggle is the standard CLI idiom instead (cf.
Node's own `util.debuglog`).

## Design notes

- **Device salt.** `repo_fingerprint` and `author_identity_hashes` are
  salted with a random value generated once and persisted at `salt` inside
  the same per-platform config directory as `credentials.json` — see
  [login-submit.md](login-submit.md#where-the-token-lives) for the exact
  path on each OS. The salt is device-local, not account-anchored — it
  survives `redential logout` and its only job is preventing
  rainbow-table lookups, independent of any session.
- **Empty / unmatched repos fail loudly.** A repository with zero commits,
  or a `--author` that matches no commits, raises an error and exits
  non-zero rather than fabricating a bundle with meaningless dates.
- **No JSON-Schema library at runtime.** The CLI builds the bundle from a
  strongly-typed `Bundle` interface (`src/types.ts`) that mirrors the
  schema; actual conformance against `schema/bundle.v1.json` is verified by
  the test suite (`test/support/schema-validate.ts`), not by shipping a
  schema validator in the published package.
