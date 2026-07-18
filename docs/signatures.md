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
import statements across ten language families (JS/TS `import`/`require`/
dynamic `import()`, Python `import`/`from`, Go `import` including blocks,
Ruby `require`/Gemfile `gem`, PHP `composer.json`'s `require` and, more
loosely, `use` namespace statements — see "PHP scope" below; Rust `use`/
Cargo.toml, Java `import`, Kotlin `import`, C# `using`/.csproj, Swift
`import`/Package.swift — see "Rust, JVM, and C# scope" and "Swift scope"
below), normalizes each to a package name (`stripe/webhooks` → `stripe`,
`@org/pkg/sub` → `@org/pkg`, a Go path's trailing `/v9` stripped, …), and
looks it up in `signatures/package-map.json` — a flat
`{"package-name": "taxonomy-slug"}` map, 600+ entries.

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

### Rust, JVM, and C# scope, honestly

**Rust.** `.rs` files: the first path segment of a `use` statement
(`use tokio::net::TcpListener;` → `tokio`), skipping `crate`/`self`/
`super`/`std`/`core`/`alloc` (never third-party). `Cargo.toml`: two
section shapes are recognized — a plain `[dependencies]` header, whose
body's `key = ...` lines are read as crate names, and a dotted
`[dependencies.tokio]` header, whose crate name is the header itself (its
body is NOT key-scanned — `version`/`features`/... are Cargo.toml keys,
not crate names, and scanning them would be a real false-positive class).
Anything else — `[target.'cfg(...)'.dependencies]`, a dependency added
under an already-existing header not itself re-shown in the diff — is a
documented miss, same tradeoff class as composer.json's "only reliable
when the diff has enough context." Crate names with a hyphen
(`actix-web`, crates.io convention) are normalized to the underscore form
Rust identifiers actually use (`actix_web`) at BOTH extraction sites, so a
Cargo.toml addition and the `use` statement consuming it resolve to the
same map key.

**Java and Kotlin.** `import [static] a.b.C[.*]` (Kotlin's trailing `;` is
optional). Package roots don't have a fixed useful segment count —
`org.springframework.boot.X` and `org.springframework.web.Y` both want to
collapse to `org.springframework`, one entry covering every Spring
submodule, but `com.google.gson.Gson` and `com.google.inject.Injector`
must NOT collapse to the same `com.google` (Google ships dozens of
unrelated libraries under that root). Rather than hardcode which roots are
"generic" in the CLI, the extractor emits candidate prefixes at every
depth from 1 to 3 and lets map membership decide which one is real — the
same reason slugs themselves are never hardcoded, ecosystem-specific
knowledge belongs in the versioned data file. `test/package-map.test.ts`
enforces the invariant this depends on: no dotted map key is ever a
strict prefix of another dotted key, so one import can never accidentally
credit two slugs at once.

A related trap: the map key must be the library's real IMPORT root, never
its Maven/Gradle groupId when the two differ — Lombok's groupId is
`org.projectlombok` but it's imported as `import lombok.Data;` (key:
`lombok`); Dagger 2's groupId is `com.google.dagger` but it's imported as
`import dagger.Component;` (key: `dagger`). A groupId-shaped key that
never appears in a real `import` statement is a dead key — the same
class the map's own `$comment` already warns about for a PyPI
distribution name that differs from its Python import name.

**C#.** `using [global] [static] [Alias =] a.b.C;`, same multi-depth
candidate emission as Java/Kotlin (`System.Text.Json` needs 3 segments to
stay distinct from `System.Linq`/`System.Net`; `Microsoft.AspNetCore.Mvc`
and `Microsoft.AspNetCore.Http` both correctly collapse to
`Microsoft.AspNetCore` at 2). `.csproj`: `<PackageReference Include="X"/>`
via a regex over the XML attribute — no real XML parser (a dependency
CLAUDE.md's policy doesn't allow without written justification), same
tradeoff as everywhere else in this file. `.csproj`'s own `<!-- ... -->`
comments are stripped before that regex runs (XML-only; never applied to
JS/TS, where `<!--` is rare-but-legal token syntax) — a multi-line
commented-out `<PackageReference>` would otherwise false-positive.

### Swift scope, honestly

`.swift` files: `import ModuleName`, including `@testable import X` and a
submodule import's kind keyword (`import struct Foundation.Date` names
the module `Foundation`, not the keyword `struct`). `Package.swift` (SPM's
manifest — itself a `.swift` file using the PackageDescription DSL,
told apart from ordinary source by filename) reads
`.package(url: "...")`/`.package(name: "...", url: "...")` declarations,
extracting the URL's last path segment as the package name. A repo whose
name literally ends in `.swift` (e.g. `groue/GRDB.swift`) has that suffix
stripped so the URL-derived candidate matches the module's own import name
(`grdb`) instead of becoming a second, needlessly distinct map key —
anchored to a literal `.swift` suffix, not just any name ending in
"swift" (`RxSwift` stays untouched). Some packages' SPM repo name
genuinely doesn't match their module name (Realm's repo is
`realm-swift`, its module is `RealmSwift`); those get two map entries,
one per form, rather than trying to derive one from the other.

### Where Rust's `axum` sits (and why it isn't in the map)

`signatures/backend/axum.json` predates Rust Tier 1 entirely — it's a
Tier 2 signature whose `importPatterns` already matches a bare
`use axum::...;` (Tier 2 patterns are OR'd: any one of
`importPatterns`/`apiPatterns`/`configFilePatterns` matching is enough,
see `matches()` in `src/skill-detect.ts`), making it functionally
equivalent to a Tier 1 map entry today. It's deliberately NOT ALSO added
to `signatures/package-map.json` — `detectSkills` already dedupes a commit
matching the same slug twice, so the overlap would buy nothing while
adding a second place to keep in sync. Every other web-framework-shaped
Rust crate added by this milestone (`actix_web`, `warp`, `rocket`,
`hyper`) goes straight into the map instead, matching the EXISTING
precedent that `express`/`fastify`/`hono`/`@nestjs/*` are already flat
Tier 1 entries in the JS ecosystem, not Tier 2 signatures.

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
