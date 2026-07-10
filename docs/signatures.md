# Skill detection: two tiers

`scan` fills `detected_skills` (schema/bundle.v1.json) by matching the
selected author's own commits — ADDED diff lines only, read locally via
`git show`, batched across ~200 commits per process for huge-repo
performance (`src/git.ts`'s `getCommitsAddedLines`; see
[docs/scan.md](scan.md#huge-repositories-and---since)) — against two layers
of local, versioned, public data. Zero network, no LLMs, per
docs/principles.md principle 3 ("Bounded output"): the only content-derived
value that can ever leave the machine is a slug from the closed vocabulary
in `taxonomy.json`.

## Tier 1 — generic import detection

For most technology, "this commit imported package X" is already enough to
say "this commit used X." `src/import-detect.ts` parses added lines for
import statements across five language families (JS/TS `import`/`require`/
dynamic `import()`, Python `import`/`from`, Go `import` including blocks,
Ruby `require`/Gemfile `gem`, PHP `composer.json`'s `require` and, more
loosely, `use` namespace statements — see "PHP scope" below), normalizes
each to a package name (`stripe/webhooks` → `stripe`, `@org/pkg/sub` →
`@org/pkg`, a Go path's trailing `/v9` stripped, …), and looks it up in
`signatures/package-map.json` — a flat `{"package-name": "taxonomy-slug"}`
map, 400+ entries.

Deliberately regex-based, not a real parser per language (a dependency per
language is a supply-chain surface CLAUDE.md's policy doesn't allow without
written justification). The tradeoff is bounded false positives, not
perfect syntax handling — every extractor is anchored to reject the three
near-miss classes that actually show up in practice: a line inside a `//`/
`#`/block comment, an import-shaped string embedded in an unrelated string
literal (checked via a same-line quote-parity count), and documentation
files (`.md`/`.mdx`/`.txt`/`.rst` are never scanned for imports at all,
regardless of content). See `test/import-detect.test.ts` for the exact
cases this is tested against, per language.

**Why a flat map is safe as pure data, not code**: every entry is a
`"string": "string"` pair — no regex, no code, nothing executed. A
malicious or malformed entry can do nothing worse than mis-tag a commit
with the wrong (but still taxonomy-valid) slug; it cannot inject a pattern,
run anything, or name a slug outside `taxonomy.json` (enforced at load
time — see "Closed vocabulary" below). This is the whole reason Tier 1 can
scale to hundreds of entries without hundreds of regexes to audit.

### PHP scope, honestly

`composer.json`'s `require` block is parsed as structured JSON — exact,
no ambiguity. Parsing PHP `use Vendor\Sub\Class;` statements is NOT
mechanical, though: PHP namespaces don't map 1:1 to composer package names
(Guzzle's namespace is `GuzzleHttp`, its package is `guzzlehttp/guzzle`).
Rather than guess, `use`-statement extraction only takes the FIRST
namespace segment, lowercased (`Illuminate\Http\Request` → `illuminate`),
which is enough for framework-level detection (Laravel app code routinely
does `use Illuminate\...;`) but deliberately doesn't attempt
vendor/package-accurate resolution for arbitrary third-party libraries.

## Tier 2 — config-file and API-usage signatures

A bare import isn't always enough:

- **No import exists at all.** Docker, Terraform, Kubernetes manifests, and
  GitHub Actions workflows are defined by files, not imports — detected by
  `configFilePatterns` (a regex against the touched file's PATH) alone.
- **The import is ambiguous.** `@supabase/supabase-js` serves both
  `auth/supabase-auth` and `db/supabase` — a flat map entry can't express
  "depends on how it's used," so both stay Tier 2 signatures, disambiguated
  by API-call shape (`.auth.*` vs `.from()`/`.rpc()`). Same story for
  `ai/whisper` vs `ai/huggingface` (both can use `@xenova/transformers`;
  only the ASR-specific pipeline call — `pipeline("automatic-speech-recognition", ...)`
  — is safe to key on) and Tailwind (detected by `tailwind.config.*` and the
  `@tailwind` CSS directive, not a JS import — CSS files aren't parsed by
  Tier 1 at all).
- **Detection is by inheritance, not declaration.** Rails' Active Record and
  Laravel's Eloquent are bundled with their framework, not separately
  declared in a Gemfile/composer.json the way a real dependency would be —
  `db/activerecord` matches `class X < ApplicationRecord`/`< ActiveRecord::Base`;
  `db/eloquent` matches the specific `use Illuminate\Database\Eloquent\Model;`
  import (never a bare `extends Model`, which is too generic — see "Pattern
  discipline" below).
- **`ai/vector-search`** is a deliberate, intentional overlap with
  per-vendor Tier 1 entries (`ai/pinecone`, `ai/weaviate`, `ai/chroma`): a
  generic multi-vendor fallback (`.similaritySearch(`, `new PineconeClient(`)
  that fires alongside the more specific per-vendor detection, not instead
  of it.

Signature file format (unchanged from before this refactor):

```json
{
  "slug": "payments/stripe",
  "importPatterns": ["from\\s+[\"']stripe[\"']"],
  "apiPatterns": ["\\bstripe\\.(checkout|customers)\\b"],
  "configFilePatterns": [],
  "fixtures": {
    "positive": [{ "path": "src/lib/stripe.ts", "diff": "..." }],
    "negative": [{ "path": "README.md", "diff": "..." }]
  }
}
```

`importPatterns`/`apiPatterns`/`configFilePatterns` may each be `[]`, but at
least one must have a pattern. `configFilePatterns` match the file PATH,
not content; the other two match the commit's ADDED lines (capped at 2000
characters per line — minified/generated noise, not hand-authored code).

**Most Tier 2 signatures add importPatterns the map can't express** — a
config file, an ambiguous package, or protocol-level usage with no import
at all — rather than re-deriving a fact the map already covers. Two
signatures are a partial exception, and intentionally so:
`auth/supabase-auth`'s importPatterns list `@supabase/ssr` and
`@supabase/auth-helpers-nextjs` (both already map entries for this same
slug) alongside `@supabase/supabase-js` (deliberately NOT a map entry,
since it's shared with `db/supabase` — see above); `auth/oauth-oidc`'s
importPatterns for `openid-client`/`oauth4webapi` duplicate map entries
outright, because the same file also needs to catch hand-rolled OAuth/OIDC
flows with no import of either library, via its `apiPatterns`
(`grant_type=authorization_code`, `code_verifier`, …). The overlap is
harmless, not just tolerated: `detectSkills` runs Tier 1 first per commit
and skips a signature check once a commit is already matched to that slug
(see the loop in `src/skill-detect.ts`), so a redundant importPattern never
produces a second, duplicate tag — it only matters for the fixture tests
below, which require every pattern to be exercised by some fixture.

## Pattern discipline (both tiers, but especially Tier 2's `apiPatterns`)

A regex like `app.get(`/`new Pool(`/`.query(`/`.upsert(`/`toMatchSnapshot(`
looks distinctive until you remember how much unrelated code shares that
exact vocabulary — Fastify/Koa/Hono all have `app.get(`; every SQL driver
has something shaped like `.query(sql)`; Vitest's snapshot API is
byte-identical to Jest's. A real review pass on an earlier version of this
detector found 11 such false positives shipped this way and had to narrow
every one of them to the library's actual DISTINCTIVE import specifier or a
genuinely unique class/function name — never a generic verb shared across
an entire ecosystem. `test/skill-detect.test.ts`'s "every negative fixture
must be a genuine near-miss mentioning the library by name" check exists
specifically to keep that discipline from eroding on future contributions.

## Contributing

**A single import unambiguously identifies the technology** (the common
case): add one line to `signatures/package-map.json`:
```json
"some-new-package": "category/slug"
```
If `category/slug` doesn't exist yet, add it to `taxonomy.json` first — a
map entry (or signature) naming a slug outside `taxonomy.json` fails to
load; `detectSkills` throws before it can ever reach matching, let alone
the bundle (the closed-vocabulary rule, enforced in code, not just
documented — see `test/package-map.test.ts` and
`test/privacy/skill-detection-taxonomy.test.ts`, which exercises this via
the real `runScan` path, not a reimplementation of the check).

**Import alone is ambiguous, or there's no import at all**: write a
Tier 2 signature file at `signatures/<category>/<name>.json` (see the
format above), with `fixtures.positive` (≥1) and `fixtures.negative` (≥1).
The generic test in `test/skill-detect.test.ts` loads every signature file
automatically and enforces: every positive fixture matches, no negative
fixture matches, every declared pattern is exercised by at least one
positive fixture (catches a dead/typo'd pattern), and at least one negative
fixture genuinely mentions the library by name (a near-miss, not just
unrelated text) — nothing else to wire up.

Either way: `npm test` picks up a new map entry or signature file
automatically, run it before opening the PR, and add a line to
`CHANGELOG.md` under `[Unreleased]`.

## Closed vocabulary and privacy, restated for this tier split

Both tiers are checked against `taxonomy.json` inside `detectSkills` itself
— the function `runScan` actually calls, not a standalone helper a future
refactor could unwire without failing a test:
`test/privacy/skill-detection-taxonomy.test.ts` proves a hostile signature
(or, equally, a hostile map entry) naming a slug outside the taxonomy makes
`runScan` throw before a bundle is ever constructed. Every code path in
`src/skill-detect.ts` and `src/import-detect.ts` that can fail builds its
error message from a file path or slug name only — never diff content, a
matched line, or a raw regex/import string.
