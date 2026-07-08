# Privacy tests → principles map

Every principle in [docs/principles.md](principles.md) maps to at least one
executable test below. Per CLAUDE.md: a PR that breaks one of these tests is
wrong, not the test.

## 1. Local

| Test | Proves |
|---|---|
| `test/privacy/zero-network.test.ts` → "never touches http/https across listAuthors, the guardrail check, and runScan" | `node:http`/`node:https` are never invoked while running the full scan path (author enumeration, the public-host guardrail, `runScan`) — verified by mocking both modules and asserting zero calls, not just by inspection. |
| `test/privacy/zero-network.test.ts` → "has no reference to fetch/http/https network APIs anywhere in src/" | Static backstop: no file under `src/` even mentions `fetch(`, `node:http`, or `node:https`, so the property can't regress silently as new code is added. |

## 2. Explicit

| Test | Proves |
|---|---|
| `test/scan.test.ts` → "requires explicit confirmation before producing a bundle" | `runScan` throws unless `confirmed` is explicitly `true` — `--author` alone (non-interactive identity selection) never implies authorization. |
| `test/prompt.test.ts` (both cases) | If the interactive attestation/author prompt hits EOF (closed stdin) before an answer, the CLI fails loudly (throws) instead of silently proceeding — no confirmation can be assumed by default. |

## 3. Bounded output

| Test | Proves |
|---|---|
| `test/privacy/bundle-boundaries.test.ts` | A repo salted with fake secrets, a revealing path, a revealing remote URL, and a confidential commit message produces a bundle containing NONE of that text — only extensions, closed-vocabulary category names, `host_type`, and salted hashes survive. |
| `test/privacy/secret-scan.test.ts` (all cases) | `assertNoSecrets`/`findSecretPatterns` catch AWS-key-shaped, PEM-key-shaped, `api_key=`-shaped, and `.env`-shaped strings in a serialized payload, throw before anything is printed, and never echo the matched secret in the error message — the regression guard mandated by principle 3, wired into `runScan` itself. |
| `test/scan.test.ts` → detected_skills always `[]` in this milestone | The closed-vocabulary skill field can't yet contain anything outside the (empty) set, since signature matching hasn't landed. |

## 4. User-reviewed

| Test | Proves |
|---|---|
| `test/scan.test.ts` → single-commit / multiple-author cases (implicit) | `runScan` is a pure function of its inputs (repo state + explicit `now`): given the same repository and the same `now`, it returns byte-identical JSON on every call — there is no hidden enrichment step between what a caller inspects and what `submit` would later send, since both would come from calling the same function on the same reviewed bundle. |

_Gap, tracked for the `submit` milestone: once `submit` exists, it must send_
_the exact bytes `scan` printed rather than re-deriving the bundle, and that_
_equality needs its own test at that point._

## 5. NDA-safe by construction

| Test | Proves |
|---|---|
| `test/privacy/bundle-boundaries.test.ts` | Same hostile fixture as principle 3: the employer/company name, the proprietary file path, and the source code comment ("proprietary formula") never appear anywhere in the bundle — only an aggregate `other`/`backend`/etc. category and an extension do. |

## 6. Honest about trust

| Test | Proves |
|---|---|
| `test/scan.test.ts` (all `runScan` cases assert `bundle.runner`) via schema validation | Every bundle produced locally is tagged `runner: "local"` — never `"ci"` — via `validateAgainstSchema`'s `const` check on the schema. This is the field the server uses to apply the weakest ("Attested") tier; getting it wrong would let a local scan masquerade as a stronger CI-anchored one. The tier *labeling* itself (Attested vs Proven/Verified) is a server/UI concern outside this repo — this CLI's only contribution is tagging its own output honestly. |

## Guardrail: known-public-host warning (anti-cannibalization)

Not a principle by itself, but enforces CLAUDE.md's guardrail: if the
repo's remote looks like a known public host, `scan` suggests the GitHub
App as an alternative — as an informational warning, never by refusing to
scan.

**Design correction (this is the second iteration of this guardrail):**
the first version made `scan` exit without producing a bundle whenever the
remote matched a known public host. That's a bug, not a stricter
guardrail: *known host != publicly accessible*, and `scan` has no network
access to tell the two apart. The CLI's PRIMARY use case is a **private**
employer repo hosted on `github.com` — blocking on host alone breaks the
main product, not just an edge case. The fix: `publicHostWarning` always
returns a message-or-null, printed to stderr (never stdout, so `scan | jq`
or any bundle consumer never has to skip a leading non-JSON line), and
then **continues** to produce the bundle regardless.

| Test | Proves |
|---|---|
| `test/privacy/public-remote-guardrail.test.ts` → `isKnownPublicHost` cases | Pure, local function of the remote URL string — recognizes github.com/gitlab.com/bitbucket.org, rejects URLs with embedded credentials or tokens, exercised via a fixture repo whose remote is set with plain local `git remote add` (no network call, no reachability check). |
| `test/privacy/public-remote-guardrail.test.ts` → `publicHostWarning` cases | Returns a message for a known public host, `null` for anything else, and the message text never claims verified public accessibility. |
| `test/privacy/public-remote-guardrail.test.ts` → "scan continues after a known-public-host warning (never blocks)" | The warning is logged AND a valid bundle is still produced afterward, for both a known-public-host remote and a self-hosted one — the regression test for the bug above. |

**Naming note:** the function and warning message deliberately say "known
public host", not "publicly accessible" — this is a heuristic on the remote
URL's shape, not a verified accessibility check (that would require a
network call, which `scan` never makes). A `github.com` URL without
embedded credentials usually means a public repo, but the CLI cannot and
does not claim certainty — so it can only ever inform, never block.

**TODO, tracked for the `submit` milestone:** the only way to actually
verify "is this remote publicly accessible" is a network request, which is
inviolable-forbidden inside `scan` but is fine at `submit` time (`submit`
already makes network calls to Redential). Plan: an anonymous HTTP `HEAD`
request made directly to the remote URL itself (e.g.
`https://github.com/<org>/<repo>`) — this request target is the *remote*,
never Redential's servers, so the remote URL never travels to Redential.
A 2xx/3xx response is real evidence of public accessibility; a 404/auth
challenge is real evidence it's private. This replaces the local heuristic
with an actual check, still without ever sending the remote URL itself
anywhere except back to the host it already came from. See the `TODO`
comment in `src/public-remote.ts`.
