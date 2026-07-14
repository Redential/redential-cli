# Principles

These are the non-negotiable rules of the Redential CLI. Every principle maps
to executable tests in `test/privacy/`. If a change breaks one of these tests,
the change is wrong — not the test.

## 1. Local

All analysis runs on the user's machine. The CLI never sends source code,
diffs, or file contents anywhere. The only network calls are `login` (device
flow) and `submit` (upload of the reviewed bundle).

`scan` makes ZERO network calls. Skill detection is deterministic matching
of diff contents against a versioned, public signature database
(`signatures/*.json` in this repo: imports, config files, per-library API
patterns). No LLMs, no remote inference, no exceptions.

## 2. Explicit

Nothing is uploaded without the user running `redential submit` and
confirming. There is no daemon, no watch mode, no background process, no
telemetry. One-shot by design: git is already the journal, a retroactive scan
reconstructs everything.

## 3. Bounded output

Be precise about what this principle guarantees, because it is the one most
often misread. The CLI DOES read the content of diffs — locally, via
`git show`/`git diff` — because that is how skills are detected. The
guarantee is not "the CLI never looks at code"; it is that what LEAVES the
machine is BOUNDED: every value in the bundle is an aggregate, a salted
hash, or a member of a closed public vocabulary. Nothing free-form derived
from code content can appear in the output.

Concretely, for skills: the only content-derived values in the bundle are
skill slugs, and a slug is valid ONLY if it appears in `taxonomy.json`
(public, versioned in this repo). A slug outside that list invalidates the
whole bundle — the vocabulary is the ceiling of what detection can ever say
about your code. Reading is local and unbounded; output is public and
enumerable.

The bundle NEVER contains:

- Source code or snippets, in any form — including in skill evidence: no
  matched lines, no excerpts, only slug + counts + dates
- File or directory names (only extension + inferred category + salted hash)
- Names or emails of OTHER contributors (only an aggregate count)
- The remote URL (only the host type, e.g. "github"; the employer name is a
  separate user claim made in the UI, never inferred)
- Secrets of any kind — a secret-scan runs over the final payload before
  output, and blocks submit on any match

## 4. User-reviewed

What the user reviews is always the exact payload, never a paraphrase of
it. `redential submit` ALWAYS prints the exact byte-for-byte JSON
immediately before the upload confirmation — on every code path,
unskippably: there is no flag, no mode, and no default that lets `submit`
ask for upload consent without having just shown the literal bytes it's
about to send. `redential scan` makes that same exact JSON available too —
via `--json`, and via piped/non-TTY output — byte-identical to what
`submit` would send for the same repository state. On a real terminal with
no `--json`, `scan`'s default output is a human-readable summary derived
only from fields already inside that bundle (never a second, independent
data source), with an explicit pointer to `redential scan --json` for
anyone who wants the literal payload on screen instead. Whichever form is
in front of you, the guarantee is the same: no hidden fields, no
enrichment after review, ever.

## 5. NDA-safe by construction

The bundle is designed so that possessing it reveals nothing about the
employer's codebase: no architecture, no naming, no business logic. What it
proves is the shape of the user's own activity: volume, span, cadence,
languages, technical categories, signed commits, ownership share.

## 6. Honest about trust

Everything local is falsifiable (git dates can be forged). The resulting tier
is therefore the WEAKEST in Redential: "Attested" (metadata only) or
"Attested + defended" (metadata + NDA-safe audio defense). It is never called
Proven or Verified, and is never visually mixed with them. Partial anchors:
signed commits (GPG/SSH), behavioral fingerprint, server-side heuristics.
