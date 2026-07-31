<h1 align="center">Redential CLI</h1>

<div align="center">

<p><img src="docs/assets/icon-pixel.svg?v=2" alt="Redential logo" height="88"></p>

<p><img src="docs/assets/wordmark.svg?v=4" alt="REDENTIAL" height="44"></p>

<p><picture>
<source media="(prefers-color-scheme: dark)" srcset="docs/assets/tagline-dark.svg?v=2">
<img src="docs/assets/tagline-light.svg?v=2" alt="private work into evidence." height="16">
</picture></p>

[![npm version](https://img.shields.io/npm/v/%40redential%2Fcli.svg)](https://www.npmjs.com/package/@redential/cli)
[![CI](https://github.com/Redential/redential-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/Redential/redential-cli/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)

**English** · [Español](docs/i18n/README.es.md) · [Português (BR)](docs/i18n/README.pt-BR.md) · [Français](docs/i18n/README.fr.md) · [Italiano](docs/i18n/README.it.md)

Your best work is probably under an NDA.

Turn private work into an NDA-safe developer credential. Your code never
leaves your machine.

<img src="docs/assets/demo.gif" alt="npx redential scan running in a terminal: capabilities detected locally, nothing uploaded" width="100%">

[Website](https://redential.com) · [Trust model](#trust-model) · [FAQ](#faq) · [Docs](#docs)

</div>

## How it works

```bash
npx redential scan
```

No login, no config, no global install. `scan` runs entirely locally and
makes zero network calls.

Redential CLI analyzes git history and implementation patterns locally,
then produces a bounded metadata bundle describing the skills and
capabilities detected in repositories you cannot connect.

You review the exact bundle before anything is uploaded. If you choose to
submit it, Redential adds that evidence to an
[**Attested capability profile**](docs/faq.md#what-does-attested-actually-prove) you
can share.

Your source code never leaves your machine.

<!-- TODO: Add screenshot of a public profile showing Attested private-work capabilities -->

## Run it

When you want the result on your Redential profile:

```bash
npx redential login    # device flow, one time
npx redential submit   # scans again, shows you the bundle, asks before uploading
npx redential logout   # deletes the locally stored session
```

Prefer a persistent install:

```bash
npm install -g redential
redential scan
```

(`redential` is an alias of
[`@redential/cli`](https://www.npmjs.com/package/@redential/cli), the
canonical package — see [Verifying the package itself](#verifying-the-package-itself).)

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
  "tool_version": "0.5.0",
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
| — | Your private label: free text *you* type yourself (never derived from your code), sent alongside — never inside — the bundle, shown before you confirm upload, mandatory, owner-visible only ([docs/private-label.md](docs/private-label.md)) |

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

- [How does anyone know I actually did this work?](docs/faq.md#how-does-anyone-know-i-actually-did-this-work)
- [Can't I just import a bunch of libraries to inflate my skills list?](docs/faq.md#cant-i-just-import-a-bunch-of-libraries-to-inflate-my-skills-list)
- [Can't I replay someone else's git history into a new repo and claim it?](docs/faq.md#cant-i-replay-someone-elses-git-history-into-a-new-repo-and-claim-it)
- [What exactly leaves my machine?](docs/faq.md#what-exactly-leaves-my-machine)
- [Why should I trust a CLI with my employer's code?](docs/faq.md#why-should-i-trust-a-cli-with-my-employers-code)
- [What does "Attested" actually prove?](docs/faq.md#what-does-attested-actually-prove)
- [Is this just a funnel for your SaaS?](docs/faq.md#is-this-just-a-funnel-for-your-saas)
- [What about pair-programmed or AI-assisted commits?](docs/faq.md#what-about-pair-programmed-or-ai-assisted-commits)

## Docs

- [docs/faq.md](docs/faq.md) — straight answers to the hard questions
- [docs/principles.md](docs/principles.md) — the six non-negotiable rules
- [docs/privacy-tests.md](docs/privacy-tests.md) — which test proves which rule
- [docs/scan.md](docs/scan.md) — full `scan` command reference
- [docs/exit-codes.md](docs/exit-codes.md) — exit codes for CI and shell scripts
- [docs/login-submit.md](docs/login-submit.md) — `login`, `submit`, `logout`
- [docs/identity-selection-memory.md](docs/identity-selection-memory.md) — how `scan`/`submit` remember your per-repo identity selection
- [docs/private-label.md](docs/private-label.md) — the mandatory private label: what it is, why it travels outside the bundle
- [docs/schema.md](docs/schema.md) — every bundle field, explained
- [docs/signatures.md](docs/signatures.md) — how skill detection works
- [docs/releasing.md](docs/releasing.md) — how a release is built and verified

If the repo you're scanning is your own and connectable, `scan` isn't the
better tool — the [GitHub App](https://redential.com) reads the actual code
and grants stronger tiers than local metadata ever can.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) — most contributions are a
one-line addition to a signature map, and starter issues are labeled
[`up-for-grabs`](https://github.com/Redential/redential-cli/labels/up-for-grabs). The contribution we want most:
**help harden the evidence** — red-team the signals, propose stronger
structural patterns, improve the forgery forensics — always within the
NDA-safe premise (evidence leaves the machine only as bounded metadata).
Bug reports and security issues: [SECURITY.md](SECURITY.md).

## License

Apache-2.0
