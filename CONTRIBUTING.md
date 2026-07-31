# Contributing

Thanks for your interest. Read the north star first, then the privacy rule
— both apply to every PR, no exceptions.

## North star

Every contribution should make the credential more solid, trustworthy, or
verifiable. That's the bar for any change, not just a checklist to satisfy:
a detection signature that reduces false positives, a fixture that catches
a real near-miss, a doc that makes a guarantee easier to verify — all of
that moves the needle. A change that makes detection louder without making
it more correct doesn't.

## The privacy rule

Any PR that changes WHAT data leaves the user's machine, or WHERE it is
sent, must start as a discussion issue BEFORE any code is written (use the
"Data boundary change" issue template). This includes: new bundle fields,
changes to hashing/salting, new network calls, and anything in
`src/secret-scan.ts`, `src/public-remote.ts`, `src/submit.ts`,
`src/submit-command.ts`, `src/login.ts`, `src/http-client.ts`, `schema/`,
or `taxonomy.json`. A prior issue isn't paperwork for its own sake: it's
where the schema version bump and the `docs/schema.md`/`CHANGELOG.md`
entries get agreed on before code exists. PRs in these areas without a
prior issue get closed regardless of code quality — sorry, the trust
contract comes first.

Everything else (bug fixes, performance, DX, docs, tests, detection
signatures): PRs welcome directly.

## What's welcome

- **New detection signatures and `signatures/package-map.json` entries.**
  This is the flagship contribution path — see below.
- **Detection improvements**: narrowing a pattern that's producing false
  positives, adding a missed near-miss as a negative fixture, fixing a
  language extractor's edge case.
- **False-positive reports**: even without a fix, a clear report (which
  signature or map entry, what triggered it, why it's wrong) is a useful
  contribution on its own — open an issue.
- **Docs**: clarifying `docs/`, fixing a stale reference, improving an
  example.

## Your first PR, in five steps

1. Pick an issue labeled
   [`up-for-grabs`](https://github.com/Redential/redential-cli/issues?q=is%3Aissue+is%3Aopen+label%3Aup-for-grabs)
   or [`good first issue`](https://github.com/Redential/redential-cli/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22)
   — each one says exactly which files to touch and what "done" means.
2. Comment on the issue to claim it, so two people don't do the same work.
3. Follow "Adding a skill signature" below (or, if you work with an AI
   coding agent, point it at the
   [`add-signature`](.claude/skills/add-signature/SKILL.md) skill — it
   walks the same path).
4. Run `npm test` — new map entries and signature files are picked up
   automatically, nothing to wire.
5. Open the PR with a one-line `CHANGELOG.md` entry under `[Unreleased]`.
   Expect a first response within 24–48 hours.

## Help harden the evidence (the contribution we want most)

The whole point of this project is validating what a developer actually
knows — without their code ever leaving their machine. The most valuable
contribution isn't a new feature: it's making the credential **harder to
fake and more meaningful to trust**. We actively want:

- **Red-team reports.** Found a way to inflate or forge a signal — padded
  imports, a replayed history, fabricated timestamps, a gamed structural
  pattern? "Here's how I'd fake X", with a repro, is as welcome as a PR.
  Open an issue (or use [SECURITY.md](SECURITY.md) if it's sensitive).
- **Stronger structural evidence.** Anchor patterns that separate "used a
  library" from "built the system" — see
  [docs/proof-graph-spike.md](docs/proof-graph-spike.md) for how the
  current payment-flow patterns work and what a new one needs.
- **Better forensics.** Signals in the spirit of the existing
  `date_forensics` heuristics that make forged histories more detectable —
  always as bounded aggregates, never verdicts.

The constraint that makes this problem interesting: every improvement
must keep the NDA-safe premise. Evidence is derived locally and leaves
the machine only as aggregates, salted hashes, or closed-vocabulary
slugs ([docs/principles.md](docs/principles.md)). If your idea needs
richer data to leave the machine, it starts with a
[data-boundary discussion issue](.github/ISSUE_TEMPLATE/data_boundary_change.yml)
— not with code.

## Adding a skill signature (most common contribution)

If a technology's import unambiguously identifies it, this is a one-line
PR — no discussion issue needed, since it only adds a taxonomy-valid slug
to public data, never code:

```json
"some-new-package": "category/slug"
```

added to `signatures/package-map.json`. If `category/slug` doesn't exist
yet, it needs to be added to `taxonomy.json` first, **as a separate PR**
with a short rationale for the new slug — a map entry naming a slug
outside `taxonomy.json` fails to load, and new vocabulary is reviewed on
its own before anything depends on it.

If the import alone is ambiguous, or there's no import at all (a config
file, a framework-inherited API), write a Tier 2 signature file at
`signatures/<category>/<name>.json` instead. Every Tier 2 signature file
must include **at least one positive and one negative fixture**: the
negative fixture has to be a genuine near-miss (mentions the library by
name, doesn't just say something unrelated), not a rubber-stamp. Tier 1
map entries need no fixtures — they are pure data, validated by the
existing load-time tests. Full detection rules and the exact test
contract: [docs/signatures.md](docs/signatures.md).

Either way: run `npm test` (it picks up new map entries and signature
files automatically) and add a line to `CHANGELOG.md` under `[Unreleased]`
before opening the PR.

## Ground rules

- The privacy test suite (`test/privacy/`) is the contract: if your change
  breaks one of those tests, the change is wrong, not the test.
- Tier 2 signature files need both a positive and a negative fixture (see
  above); Tier 1 map entries don't.
- A slug must already exist in `taxonomy.json`; a new slug is a separate
  PR with a rationale, never bundled into the signature PR that needs it.
- No new runtime dependencies without written justification in the PR
  description (what it does, why the existing stack can't do it, what it
  adds to the supply-chain surface).
- No postinstall scripts. No telemetry, analytics, or network calls
  outside `login`/`submit`. Ever.
- Any change to WHAT data leaves the machine requires, in order: a prior
  discussion issue, a schema version bump, and an entry in
  `docs/schema.md` and `CHANGELOG.md` — see "The privacy rule" above.
- English only, in code comments and in docs — this is an international,
  public repo.
- Tests use vitest. Fixtures are git repos created programmatically in a
  tmpdir at test time — never a committed fixture repo with real history.
- Every feature ships with a doc in `docs/` and a `CHANGELOG.md` entry.

## How PRs are reviewed

Every PR gets a review. Reviews are AI-assisted — an automated pass checks
tests, fixtures, and adherence to the rules above — but any change that
touches privacy or security surfaces (the files listed in "The privacy
rule", plus `test/privacy/`) always gets a human maintainer decision
before merge; the automated pass never has the final word there. Expect a
first response within 24–48 hours.

## Dev setup

```bash
npm install
npm run typecheck  # tsc --noEmit
npm test           # unit + privacy suite (creates git fixtures in tmpdir)
npm run build      # tsc to dist/
```

Requires Node.js >= 20.

## Working with an AI agent

If you contribute with an AI coding agent, this repo ships two skills
for it (plain markdown, readable by humans too — agents that support
project skills discover them automatically):

- [`privacy-gate`](.claude/skills/privacy-gate/SKILL.md) — run the same
  privacy review maintainers apply, before opening your PR.
- [`add-signature`](.claude/skills/add-signature/SKILL.md) — the exact
  steps and test contract for a new detection signature.

Agent-assisted PRs are welcome here; PRs that ignore the gates above are
not, however they were written.

## Further reading

- [docs/principles.md](docs/principles.md) — the six non-negotiable rules
  every contribution has to respect
- [docs/privacy-tests.md](docs/privacy-tests.md) — which test proves which
  rule
- [docs/signatures.md](docs/signatures.md) — how skill detection works,
  and the exact contract for a signature PR

## Reporting security issues

Do NOT open a public issue. See [SECURITY.md](SECURITY.md).
