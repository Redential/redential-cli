# `signatures/*.json` — skill detection format

This is the versioned, public database `scan` matches diffs against to fill
`detected_skills` (schema/bundle.v1.json). See docs/principles.md's
principle 3 ("Bounded output") for why this exists: detection reads diff
content locally, but the only thing that can ever leave the machine is a
slug from the closed vocabulary in `taxonomy.json` — never the matched
line, file name, or any other content.

## How matching works

For every commit by the selected author (`git show <sha> --unified=0`,
locally — `src/git.ts`'s `getCommitAddedLines`), skipping merge commits and
anything already excluded from churn (`src/churn-exclusions.ts`: lockfiles,
minified bundles, build-output directories, single-commit generated
dumps — a vendored bundle's content matching an import pattern would be a
false "you wrote this" signal, not a real one):

- **`importPatterns`** — regex tested against the commit's ADDED lines
  (never removed/context lines). Anchor on the module-specifier line, e.g.
  `from\s+["']stripe["']` or `require\(\s*["']stripe["']\s*\)` — never a
  bare substring match on the library name, which would false-positive on
  comments and prose mentioning it.
- **`apiPatterns`** — same target (added lines), for distinctive API call
  shapes, e.g. `\bstripe\.(checkout|customers)\b`.
- **`configFilePatterns`** — regex tested against the touched file's PATH,
  not its content. Use for tools defined by a config file's mere presence
  (`(^|/)tailwind\.config\.(js|ts|cjs)$`, `(^|/)Dockerfile$`).

A signature matches a commit if ANY of its patterns match. `detected_skills`
aggregates matches per slug: `commit_count` (distinct matching commits),
`first_seen`/`last_seen` (earliest/latest matching commit's author date).

Lines longer than 2000 characters are never tested (minified/generated
noise, not hand-authored imports — also bounds worst-case regex time).

## File format

One file per taxonomy slug, at `signatures/<category>/<name>.json` (e.g.
`taxonomy.json`'s `payments/stripe` → `signatures/payments/stripe.json`):

```json
{
  "slug": "payments/stripe",
  "importPatterns": [
    "from\\s+[\"']stripe[\"']",
    "require\\(\\s*[\"']stripe[\"']\\s*\\)"
  ],
  "apiPatterns": [
    "\\bstripe\\.(checkout|customers|subscriptions|paymentIntents|charges|webhooks|prices|products)\\b"
  ],
  "configFilePatterns": [],
  "fixtures": {
    "positive": [
      {
        "path": "src/lib/stripe.ts",
        "diff": "import Stripe from \"stripe\";\nconst stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);\nconst session = await stripe.checkout.sessions.create({ mode: \"payment\" });"
      },
      { "path": "src/lib/stripe.js", "diff": "const Stripe = require(\"stripe\");" }
    ],
    "negative": [
      {
        "path": "README.md",
        "diff": "We considered using stripe for payments but chose mercadopago instead for LatAm support."
      }
    ]
  }
}
```

`importPatterns`/`apiPatterns`/`configFilePatterns` may each be `[]`, but at
least one must have at least one pattern.

## Contributing a signature (PR checklist)

1. **Add the slug to `taxonomy.json` first**, in the right category (or a
   new one). A signature naming a slug outside `taxonomy.json` fails to
   load — `detectSkills` throws before it can ever reach matching, let
   alone the bundle (the closed-vocabulary rule, enforced in code, not just
   documented).
2. **Write the signature file**, following the format above.
3. **Write `fixtures.positive` (≥1) and `fixtures.negative` (≥1).** A
   generic test (`test/skill-detect.test.ts`) loads every signature file in
   this directory automatically and enforces, for every one:
   - every positive fixture actually matches;
   - no negative fixture matches;
   - **every declared pattern is exercised by at least one positive
     fixture** — a pattern nothing demonstrates is almost always a dead or
     typo'd regex, so this is a hard failure, not a suggestion;
   - **at least one negative fixture mentions the library by name** (a
     substring of the slug's second segment) — proving it's a genuine
     near-miss ("we thought about using X" prose, a comment referencing it)
     and not just unrelated text that trivially wouldn't match anything.
4. **Run `npm test`** — nothing else to wire up. The new signature is
   picked up automatically by both the generic fixture test and real scans.
5. Add a line to `CHANGELOG.md` under `[Unreleased]`.

## Design notes

- **Why fixtures live inside the signature file, not as separate test
  files:** contributing a signature and proving it's correct is one step,
  not two — there's no separate test file to remember to write or to drift
  out of sync with the pattern it's supposed to cover.
- **Why regex, not an AST parser:** no new dependency (CLAUDE.md's
  dependency policy), and it stays auditable — anyone can read a signature
  file and understand exactly what it matches, without needing to
  understand a parser's internals.
- **Known tradeoff:** regex matching on added lines is not perfect. A
  multi-line destructured import, an unusual formatting style, or a
  same-named-but-unrelated identifier can produce a false negative or (more
  rarely, given the near-miss-fixture discipline above) a false positive.
  This is an accepted tradeoff of principle 3: the guarantee is about
  bounded OUTPUT (only closed-vocabulary slugs can ever appear), not
  perfect detection. Worst case, a slug is missing or present when it
  shouldn't be — never a slug outside the vocabulary, and never any
  content beyond the slug itself.
