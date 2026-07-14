# `redential scan`

Reads git history from a local repository and prints the exact proof bundle
that `submit` would upload later — nothing is sent anywhere by `scan` itself.

```bash
redential scan --repo <path>              # interactive author + confirmation
redential scan --author you@example.com --yes   # non-interactive
redential scan --repo <path> --json       # force JSON-only, even in a terminal
redential scan --repo <path> --details    # TTY summary + hour/weekday histograms
redential scan --since 2years             # limit analysis to the last 2 years
redential scan --debug --repo <path>      # verbose diagnostics on stderr
```

**Output at a glance (phase 2 of the console-UX redesign):**

| stdout is...            | `--json` | output                                                         |
| ------------------------ | -------- | ---------------------------------------------------------------- |
| piped/redirected         | any      | the exact bundle JSON only — byte-identical to every prior release |
| a real terminal (TTY)     | no       | the human-readable summary only (`--details` adds two extra sections) — **no JSON dump** |
| a real terminal (TTY)     | yes      | the exact bundle JSON only, nothing else — suitable for piping even from an interactive shell |

`--json` is treated as "this run is scripted," full stop, even when stdout
happens to be a real terminal: besides forcing JSON-only stdout, it also
skips the connectable-repo notice's interactive "Continue locally?"
follow-up (see below) and the huge-repo progress line, exactly as if stdout
were piped. The connectable-repo *warning* itself (stderr, non-blocking)
still prints either way — only the interactive follow-up question is
skipped.

## How it works

1. **Connectable-repo notice.** If the repo's remote looks like it's hosted
   on a known public host (github.com/gitlab.com/bitbucket.org —
   `isKnownPublicHost`, `src/public-remote.ts`), `scan` prints an
   informational notice before anything else — this is a heuristic, never
   proof the repo is actually public, so it never blocks (the CLI's primary
   use case is a *private* employer repo hosted on github.com):
   ```
   This repo appears connectable through GitHub.

   For repos you own, the GitHub App provides stronger evidence.
   For employer or NDA-protected repos, continue with the local scan.
   ```
   On a real TTY (and no `--json`), a follow-up question appears right after
   it — `Continue locally? (Y/n)`, Y default. Pressing Enter (or `y`)
   continues with the local scan exactly as before; answering `n` exits
   cleanly (exit code 0) without scanning anything, printing a brief note
   suggesting the GitHub App instead. Piped/non-TTY output — and `--json`,
   even on a real TTY — is unaffected: the notice still prints (non-blocking,
   to stderr), but no interactive question is ever asked, the same "warn,
   never block" behavior every prior release had.
2. **Enumerate authors.** `git log` is read locally (`git show`/`git diff`
   never leave the machine) to list distinct author emails and their commit
   counts.
3. **Select identity.** With 2+ candidates, and the repo's own
   `git config user.email` matching one of them, that one is offered FIRST
   as a fast default: "Found 12 commits authored by you@example.com. Use
   this identity? (Y/n)", Y is the default. Declining — or no match at
   all — falls through unchanged to the flow below: a single candidate
   gets the same Y/n confirmation, identical copy ("Found 12 commits
   authored by you@example.com. Use this identity? (Y/n)"); 2+ candidates
   get a numbered list instead (skipping the git-identity pre-selection
   specifically to avoid asking the same yes/no question twice in a row
   for a repo with exactly one contributor). Declining the git-identity
   pre-selection shows the FULL list, including the declined entry — "no"
   often means "that one plus others" for a multi-identity repo, not "not
   that one at all". Non-interactively, pass `--author <email>` (repeatable)
   for every email that's yours — this skips identity selection entirely,
   unaffected by any of the above.
4. **Confirm authorization.** You must explicitly confirm "Confirm you are
   authorized to analyze this repository. (y/N)" — interactively via a
   prompt, or non-interactively via `--yes`. The default flips to N:
   pressing Enter declines, you must type `y` to proceed. This is a
   separate step from author selection on purpose: `--author` only answers
   "which emails are mine", not "I'm allowed to scan this repo". Both are
   required before a bundle is produced.
5. **Compute the bundle.** Every field in `schema/bundle.v1.json` is derived
   from `git log --numstat` filtered to your selected commits: volume, span,
   hourly/weekday cadence, signed-commit ratio, churn share by file
   extension and by technical category (heuristic path/extension matching),
   ownership share against the repo's total commits, and detected skills
   (deterministic local matching of your commits' diffs against
   `signatures/*.json` — see [docs/signatures.md](signatures.md); zero
   network, closed vocabulary, `detected_skills` may be empty if nothing
   matched).
6. **Print it.** Piped/redirected stdout, or `--json` (even on a real
   terminal), prints the JSON — byte for byte what `submit` would send
   later, and nothing else. A real terminal with no `--json` prints the
   human-readable summary instead (see below) — **not** the JSON — so run
   `redential scan --json` whenever you specifically want the exact payload
   on screen or piped into something else (`jq`, a file redirect, etc.).

## `submit`'s own consent summary

`scan` itself no longer prints a "what would get uploaded" consent box —
phase 2 of the console-UX redesign replaced it with the richer summary
below, whose own footer already restates the same guarantees in plain
language and points at `redential scan --json` for the literal payload.
The boxed, itemized consent summary (`formatConsentSummary`,
`src/summary.ts`) still exists and is still shown, unchanged, by
`redential submit` right before its own upload confirmation — see
[login-submit.md](login-submit.md#submit-review-then-upload) for that
command's own output order and copy ("gets" vs. this doc's historical
"would", since `submit` actually uploads).

## The summary (default TTY output)

When stdout is an interactive terminal and `--json` isn't passed, `scan`
prints ONLY this human-readable summary — no JSON dump. It's a short,
shareable overview: span/commits/ownership, detected capabilities
(structural findings first, then grouped by category), top languages and
categories, ownership and signed-commit ratios, and a closing block
restating what does (and never) leaves the machine, followed by pointers to
`--json` (the exact payload) and `--details` (the hour/weekday histograms,
moved out of the default view in phase 2 to keep this shareable core
short). It's rendered with ANSI colors and Unicode block/box-drawing
characters only (no new dependency), and is derived entirely from the
bundle `scan` already computed: no new data collection, no network,
nothing beyond what's already in the JSON `--json` would print.

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
  PRIVATE WORK, LOCALLY DERIVED
  1 year · 1,378 authored commits · 100% ownership

  CAPABILITIES DETECTED

  Payment webhook flow    30 commits   STRUCTURAL · DIRECT

  Frontend
    Next.js              139 commits
    React                113 commits
    Tailwind CSS          80 commits
    Zustand               40 commits
    +1 more

  Backend
    Express               90 commits

  Databases
    PostgreSQL            60 commits

  AI
    Anthropic API         20 commits

  TOP LANGUAGES
  .ts   ████████████████████   62%
  .tsx  ██████░░░░░░░░░░░░░░   20%
  .md   ███░░░░░░░░░░░░░░░░░    8%

  TOP CATEGORIES
  Frontend  ████████████████████   59%
  Backend   ████████░░░░░░░░░░░░   25%
  Testing   ███░░░░░░░░░░░░░░░░░   10%

  Ownership       100% of this repo's commits are yours
  Signed commits  0% of your commits are cryptographically signed
  Tip: signing future commits adds a stronger identity anchor to your attestation.

  ────────────────────────────────────────────────────────────
  Nothing left your machine. Nothing is uploaded unless you run
  `redential submit` — and only the bounded bundle: aggregates,
  salted fingerprints, and closed-vocabulary capability slugs.
  Never code, file names, commit messages, or other contributors.
  Verify: github.com/Redential/redential-cli
  ────────────────────────────────────────────────────────────

  Inspect the exact payload:  redential scan --json
  More detail (hour/weekday histograms):  redential scan --details

  Add this private work to your public Redential profile:
  → redential login && redential submit
```

(Generated from a real fixture bundle via `formatSummary` — the trailing
"More detail..." hint is itself omitted when `--details` is already active,
since the summary is already showing what it would point to.)

**Capabilities are grouped, not a flat list.** Structural findings
(`evidence: "structural"` — see [proof-graph-spike.md](proof-graph-spike.md))
are pulled out and always listed FIRST, each tagged `STRUCTURAL ·
DIRECT`/`INFERRED`; if a scan has none, nothing is printed about their
absence. Every remaining (ordinary import-tier) skill is grouped by its
taxonomy slug prefix (`frontend`, `auth`, `payments`, `db`, `ai`, `backend`,
`queues`, `observability`, `testing`, `email`, `infra`, `storage`,
`realtime`, `data`, humanized to a display name — e.g. `queues` →
"Background jobs & queues" — falling back to a capitalized prefix for
anything not in that fixed list), groups ordered by their own total commit
count descending, entries within a group ordered by commit count and capped
at 4 with an honest `+N more` beyond that. Every label shown — capability
names, group headers, category names — comes from `taxonomy.json`'s own
`label` field (never a raw lowercase slug); a slug with no taxonomy label
(should not normally happen — skill detection already enforces closed
vocabulary) falls back to the bare slug rather than inventing one.
**TOP CATEGORIES** hides the catch-all `other` bucket entirely and any
category under 2% churn share, using this same humanization map.

If your signed-commit ratio is above 0%, the "Tip: signing future
commits..." line is simply omitted — no other change.

### `--details`

Adds two sections right after the header line — the same COMMITS BY
HOUR/WEEKDAY histograms this summary always showed before phase 2 moved
them out of the default view:

```
  COMMITS BY HOUR (UTC)
  0     6     12    18
  ▁····▁▁▃▅█▇▄▃▂▂▁▁▁▁▁····

  COMMITS BY WEEKDAY
  Sun  ██░░░░░░░░░░░░░░░░░░  5
  Mon  ███████████████████░  40
  ...
```

No effect on `--json` or piped output — neither ever rendered histograms,
JSON or otherwise.

### Closing next-step hint

Below the "Inspect the exact payload"/"More detail" hints, the summary
closes with a next-step hint in one of three states — a plain local-state
check (`src/scan-command.ts`'s `nextStepsState`), never a network call:

1. **No stored session** (never logged in, or the stored session is for a
   different `SITE_URL`):
   ```
     Add this private work to your public Redential profile:
     → redential login && redential submit
   ```
2. **Stored session, but this exact bundle hasn't been uploaded yet**
   (nothing recorded locally yet, or the recorded hash doesn't match this
   scan's content — e.g. new commits since the last submit):
   ```
     Add this private work to your public Redential profile:
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

This only happens on a real TTY with no `--json`. `scan | jq` (or any
redirected/piped stdout) prints **only** the raw JSON, byte-identical to
before this summary existed — `--json` forces that same JSON-only behavior
even on a terminal, for scripts that run interactively but still want
machine output.

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
summary states the active window next to the header line (e.g. "2 years ·
1,847 authored commits · 78% ownership (last 2 years)"), so it's never
ambiguous whether a window was applied.

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
stance as the connectable-repo notice above) naming the remedy (`git fetch
--unshallow`) and continue with whatever history IS available; on a TTY,
the summary repeats a short note next to the header line too, so it's
visible even if the stderr warning scrolled past.

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
