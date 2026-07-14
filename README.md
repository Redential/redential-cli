# Redential CLI

[![npm version](https://img.shields.io/npm/v/%40redential%2Fcli.svg)](https://www.npmjs.com/package/@redential/cli)
[![CI](https://github.com/Redential/redential-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/Redential/redential-cli/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)

Your best work is probably under an NDA.

Turn private work into an NDA-safe developer credential. Your code never
leaves your machine.

```bash
npx @redential/cli scan
```

<!-- TODO: Add demo GIF: scan → review bundle → public Attested credential -->
_Demo video coming soon: scan locally → review the exact bundle → claim your
public credential._

## What you get

The CLI is the private-work capture layer for Redential. It analyzes git
history and implementation patterns locally, then turns bounded evidence
from repositories you cannot connect into an **Attested capability profile**
you can share.

Your profile grows over time as you keep building and submit new evidence.

Code is analyzed locally. Only the bounded metadata bundle can leave your
machine, and only after explicit confirmation.

<!-- TODO: Add screenshot of a public profile showing Attested private-work capabilities -->
_Public profile screenshot coming soon._

**Attested** means the evidence was derived locally from user-controlled
repository data. It is reproducible and clearly separated from independently
verified tiers. Local repository data can be manipulated, so the CLI never
labels it as Verified.

## Try it

```bash
npx @redential/cli scan
```

No login, no config, nothing installed globally. `scan` makes zero network
calls and shows you a local summary; the exact JSON it would upload is one
flag away (`--json`) and always shown in full before any upload. If you
like what you see:

```bash
npx @redential/cli login    # device flow, one time
npx @redential/cli submit   # scans again, shows you the bundle, asks before uploading
npx @redential/cli logout   # deletes the locally stored session
```

Prefer a persistent install:

```bash
npm install -g @redential/cli
redential scan
```

Supported platforms: macOS, Linux, and Windows, on Node.js 20 and 22 —
every release is verified against all six by CI.

## What `scan` looks like

On a real terminal, `scan` prints a short, human-readable summary — not the
raw JSON. It's assembled entirely from fields already in the bundle (see
[docs/schema.md](docs/schema.md) for every field, and
[docs/scan.md](docs/scan.md) for the full layout): capabilities detected
(structural findings, like a verified webhook-handling flow, called out
first; everything else grouped by category), top languages and categories,
ownership and signed-commit ratios, and a closing block restating what
leaves the machine and what never does:

```
  PRIVATE WORK, LOCALLY DERIVED
  1 year · 1,378 authored commits · 78% ownership

  CAPABILITIES DETECTED

  Payment webhook flow     4 commits   STRUCTURAL · DIRECT

  Payments
    Stripe                12 commits

  TOP LANGUAGES
  .ts   ████████████████████   62%
  .sql  █████░░░░░░░░░░░░░░░   14%

  TOP CATEGORIES
  Backend  ████████████████████   51%
  Testing  ███████░░░░░░░░░░░░░   18%

  Ownership       78% of this repo's commits are yours
  Signed commits  45% of your commits are cryptographically signed

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

The exact JSON is one flag away, never hidden: `redential scan --json` (or
`redential scan | jq`, or any piped/redirected stdout) prints **only** the
literal bundle, byte for byte what `submit` would send — and `redential
submit` always shows you that same exact JSON in full, immediately before
asking you to confirm the upload, on every path, unskippably. The summary
above is a terminal-only convenience derived from that same bundle, never a
second source of data.

This is the payload shape (`redential scan --json`) — what's actually
reviewed before any upload:

```
{
  "schema_version": "1.2.0",
  "runner": "local",
  "tool_version": "0.3.0",
  "created_at": "2026-07-09T14:32:01.000Z",
  "repo": { "host_type": "github", "age_days": 742, "repo_fingerprint": "a3f9…" },
  "identity": { "author_identity_hashes": ["9c1e…"], "other_contributors_count": 3 },
  "commits": { "user_total": 1847, "first_at": "2024-06-02T09:14:00Z", "last_at": "2026-07-08T21:05:00Z", "span_days": 767, "hour_histogram": [...], "weekday_histogram": [...] },
  "signed": { "count": 831, "ratio": 0.45, "key_types": ["ssh"] },
  "languages": [ { "extension": ".ts", "share": 0.62 }, { "extension": ".sql", "share": 0.14 } ],
  "categories": [ { "name": "backend", "commit_count": 902, "churn_share": 0.51 }, { "name": "testing", "commit_count": 340, "churn_share": 0.18 } ],
  "detected_skills": [ { "slug": "payments/stripe", "commit_count": 12, "first_seen": "2024-09-01T10:00:00Z", "last_seen": "2025-11-20T18:30:00Z" }, { "slug": "payments/payment-webhook-flow", "commit_count": 4, "first_seen": "2024-09-03T08:00:00Z", "last_seen": "2024-09-03T08:00:00Z", "evidence": "structural", "confidence": "direct" } ],
  "ownership": { "user_commit_ratio": 0.78 },
  "integrity": { "merkle_root": "7be2…", "algorithm": "sha256", "date_forensics": { "author_span_days": 767, "committer_span_days": 763, "mismatch_ratio": 0.06, "committer_burst_ratio": 0.02 } },
  "attestation": { "authorized_confirmation": true, "confirmed_at": "2026-07-09T14:32:01.000Z" }
}
```

Full command reference: [docs/scan.md](docs/scan.md).

## Trust model

| Never leaves your machine | Only travels after you run `submit`, and only this |
|---|---|
| Source code, diffs, snippets | The bundle `scan` prints with `--json` (and `submit` always shows in full before upload) — byte for byte |
| File and directory names | An extension (`.ts`) and an inferred category (`backend`) |
| Commit messages | Aggregate cadence: hour/weekday histograms |
| Other contributors' names or emails | An aggregate count of other contributors |
| The remote URL | Only the host *kind* (`github`, `gitlab`, …), never the URL |
| Secrets of any kind | Nothing — a secret-scan runs over the bundle and blocks output on any match |

Every row on the left is backed by an [executable test](test/privacy/), per
[docs/privacy-tests.md](docs/privacy-tests.md) — not just a policy
statement. `scan` itself makes zero network calls; `login` and `submit` are
the only two commands that touch the network at all, and `submit` uploads
nothing without your explicit confirmation. Full rationale:
[docs/principles.md](docs/principles.md).

### Verifying the package itself

Every release is published from GitHub Actions on a tagged commit with npm
provenance (`npm publish --provenance`) — never from anyone's laptop.
Verify any installed version was built from this exact source:

```bash
npm audit signatures
```

See [docs/releasing.md](docs/releasing.md) for the full release process
and what the provenance attestation actually proves.

## FAQ

**Can't I just import a bunch of libraries to inflate my skills list?**
No — a bare import alone rarely tags a skill. Most signatures require
either a distinctive, unambiguous import specifier (not a generic package
name shared across ecosystems) or an actual API-call shape from your own
diffs (`stripe.checkout`, not just `import Stripe`). See
[docs/signatures.md](docs/signatures.md) for the exact detection rules and
the discipline behind them. But the honest answer is bigger than detection
accuracy: this CLI only ever produces the **Attested** tier — the weakest
one on Redential, explicitly labeled as unverified metadata. Padding your
skills list gets you a slightly longer list on the weakest tier; it does
nothing for Proven or Verified, which require live code or a defended
session. Gaming metadata to look impressive on a tier that's already
labeled "take this with a grain of salt" isn't much of a prize.

**Can't I replay someone else's git history into a new repo and claim it?**
You could fabricate commit timestamps in a fresh repo — that's exactly why
local data is explicitly the *weakest* tier, not the strongest. A replayed
history still has to survive several partial anchors: signed commits (a
GPG/SSH signature can't be forged retroactively without the key), a
behavioral fingerprint (the hour/weekday cadence is compared against your
own verified public activity as a soft consistency check), a rewrite-
forensics signal (`integrity.date_forensics` — git's author date is easy to
forge, but a script replaying years of fabricated history in one sitting
also leaves every commit's *committer* date clustered in that same
sitting; a heuristic server-side signal, not a local verdict — see
[docs/schema.md](docs/schema.md#date_forensics-measurement-contract)), and
— above all — the bundle only ever earns **Attested**, metadata only. Anything
above that requires an NDA-safe defense: a short recorded session where
you answer questions generated from your own bundle, live. Faking a git
history is cheap; defending fabricated experience under questioning, in
real time, is not. That gap is the actual security boundary, not the
detection heuristics.

**What exactly leaves my machine?**
The bundle — byte for byte the JSON `redential scan --json` prints and
`submit` always shows in full before asking for your confirmation, nothing
added or enriched afterward. That's not a promise you have to take on
faith:
[`test/privacy/submit-guardrail.test.ts`](test/privacy/submit-guardrail.test.ts)
asserts the literal string sent over HTTP by `submit` is `===` the string
it printed before your confirmation, not a re-serialization of a parsed
object. Every field is
documented in [docs/schema.md](docs/schema.md), and the schema itself
(`schema/bundle.v1.json`) sets `additionalProperties: false` everywhere —
an unlisted field makes the bundle invalid by construction, not just by
convention.

**Why should I trust a CLI with my employer's code?**
Because it never touches your employer's code in any form that leaves your
laptop. It's local-only (`scan` is structurally network-free, not merely
network-free by default), fully open source under Apache-2.0 so you can
read every line before running it, and its privacy claims are
[executable tests](test/privacy/) you run yourself (`npm test`) rather
than a page of prose. There's no telemetry, no analytics, no background
process — the only two network calls this CLI ever makes are the `login`
device flow and the `submit` upload, both requiring your explicit action.
And every published release carries a Sigstore-signed provenance
attestation you can verify (`npm audit signatures`), proving it was built
from this exact repository, not from someone's laptop.

**What does "Attested" actually prove?**
Honestly, not that much on its own — and that's by design, not an
oversight. "Attested" means: this person's local git history shows this
pattern of activity, self-reported and falsifiable, with partial anchors
(signed commits, behavioral fingerprint, server-side consistency checks)
but no independent verification of the underlying code. It is never
labeled or visually mixed with Proven or Verified, which require either
connecting a readable repository (via the GitHub App) or defending the
claim live. Think of Attested as "worth a follow-up question," not
"verified" — the CLI's whole design exists to keep that distinction
honest instead of letting a metadata bundle borrow credibility it hasn't
earned. See [docs/principles.md](docs/principles.md) (principle 6,
"Honest about trust") for the full reasoning.

## Docs

- [docs/principles.md](docs/principles.md) — the six non-negotiable rules
- [docs/privacy-tests.md](docs/privacy-tests.md) — which test proves which rule
- [docs/scan.md](docs/scan.md) — full `scan` command reference
- [docs/login-submit.md](docs/login-submit.md) — `login`, `submit`, `logout`
- [docs/schema.md](docs/schema.md) — every bundle field, explained
- [docs/signatures.md](docs/signatures.md) — how skill detection works
- [docs/releasing.md](docs/releasing.md) — how a release is built and verified

If the repo you're scanning is your own and connectable, `scan` isn't the
better tool — the [GitHub App](https://redential.com) reads the actual code
and grants stronger tiers than local metadata ever can.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) — most contributions are a
one-line addition to a signature map. Bug reports and security issues:
[SECURITY.md](SECURITY.md).

## License

Apache-2.0
