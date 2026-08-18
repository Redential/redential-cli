# FAQ

Every answer below links to the code and tests that back it.
### How does anyone know I actually did this work?
The CLI doesn't claim to know — that's the whole point of the tier
system. An Attested bundle says: *this machine's git history shows this
activity, claimed by this identity.* Partial anchors back the claim
(your commit emails are checked against your verified account emails,
signed commits can't be forged retroactively without your key, and your
activity cadence is consistency-checked server-side) — but none of that
proves authorship, and the README never pretends it does.

The real answer is what comes after: anyone can *claim* a history, but
on Redential a claim can be challenged — a live defense, where you
answer questions generated from your own bundle's numbers, in real
time. Someone who did the work answers from memory. Someone who copied
a history has nothing to remember. If you couldn't have done the work,
you can't defend it — and an undefended claim stays visibly parked at
the weakest tier, labeled as exactly what it is.

### Can't I just import a bunch of libraries to inflate my skills list?
No — a bare import alone rarely tags a skill. Most signatures require
either a distinctive, unambiguous import specifier (not a generic package
name shared across ecosystems) or an actual API-call shape from your own
diffs (`stripe.checkout`, not just `import Stripe`). See
[docs/signatures.md](signatures.md) for the exact detection rules and
the discipline behind them. But the honest answer is bigger than detection
accuracy: this CLI only ever produces the **Attested** tier — the weakest
one on Redential, explicitly labeled as unverified metadata. Padding your
skills list gets you a slightly longer list on the weakest tier; it does
nothing for Proven or Verified, which require live code or a defended
session. Gaming metadata to look impressive on a tier that's already
labeled "take this with a grain of salt" isn't much of a prize.

### Can't I replay someone else's git history into a new repo and claim it?
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
[docs/schema.md](schema.md#date_forensics-measurement-contract)), and
— above all — the bundle only ever earns **Attested**, metadata only. Anything
above that requires an NDA-safe defense: a short recorded session where
you answer questions generated from your own bundle, live. Faking a git
history is cheap; defending fabricated experience under questioning, in
real time, is not. That gap is the actual security boundary, not the
detection heuristics.

### What exactly leaves my machine?
The bundle — byte for byte the JSON `redential scan --json` prints and
`submit` always shows in full before asking for your confirmation, nothing
added or enriched afterward. That's not a promise you have to take on
faith:
[`test/privacy/submit-guardrail.test.ts`](../test/privacy/submit-guardrail.test.ts)
asserts the literal string sent over HTTP by `submit` is `===` the string
it printed before your confirmation, not a re-serialization of a parsed
object. Every field is
documented in [docs/schema.md](schema.md), and the schema itself
(`schema/bundle.v1.json`) sets `additionalProperties: false` everywhere —
an unlisted field makes the bundle invalid by construction, not just by
convention.

### Why should I trust a CLI with my employer's code?
Because it never touches your employer's code in any form that leaves your
laptop. It's local-only (`scan` is structurally network-free, not merely
network-free by default), fully open source under Apache-2.0 so you can
read every line before running it, and its privacy claims are
[executable tests](../test/privacy/) you run yourself (`npm test`) rather
than a page of prose. There's no telemetry, no analytics, no background
process — the only two network calls this CLI ever makes are the `login`
device flow and the `submit` upload, both requiring your explicit action.
And every published release carries a Sigstore-signed provenance
attestation you can verify (`npm audit signatures`), proving it was built
from this exact repository, not from someone's laptop.

### What does "Attested" actually prove?
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
earned. See [docs/principles.md](principles.md) (principle 6,
"Honest about trust") for the full reasoning.

### Is this just a funnel for your SaaS?
The honest answer: the CLI is the open-source capture layer for
[Redential](https://redential.com), and Redential is a commercial product.
Neither of those facts is hidden — you're reading them right now.

What makes it a tool rather than a funnel: `scan` is fully useful
standalone. No account, no login, no network — it analyzes your
repo and shows you everything it found, locally, forever, for free. The
platform only enters the picture if you decide the result is worth
publishing, and nothing uploads until you've seen the exact payload and
confirmed the prompt. There is no crippled mode, no "unlock full results" — the
local analysis IS the full analysis.

The business model is the credential platform. The CLI's job is to be
trustworthy enough that you'd consider using it — which is why every
privacy claim in this README maps to an executable test instead of a
promise.

### I got `command not found: npx` — what do I do?
`npx` ships with npm, which ships with Node.js — so this means Node isn't
installed (or isn't on your `PATH`). Install it: `brew install node` on
macOS, `winget install OpenJS.NodeJS.LTS` on Windows, or an installer from
[nodejs.org](https://nodejs.org) on Linux/other. git is the only other
requirement. Standalone binaries that need no Node install at all are on
the roadmap, but not available yet. Once Node is installed, `npx redential
scan` (or the `yarn dlx`/`pnpm dlx` equivalents — see the [README](../README.md#how-it-works))
should work.

### What about pair-programmed or AI-assisted commits?
AI-assisted work is never flagged as lesser. The bundle carries honest,
bounded signals about agent involvement (co-authorship counts, tool
presence booleans, never transcripts), so nothing is hidden, and the
defense tests what matters regardless of who typed: whether you can
explain and stand behind the decisions in work shipped under your name.
Pair commits inherit git's one-author-per-commit model: the commit's
author gets the attribution, and the trailer does not transfer skill
credit. That is a real limitation, stated here rather than papered over.
