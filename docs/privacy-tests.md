# Privacy tests → principles map

Every principle in [docs/principles.md](principles.md) maps to at least one
executable test below. Per CLAUDE.md: a PR that breaks one of these tests is
wrong, not the test.

## 1. Local

| Test | Proves |
|---|---|
| `test/privacy/zero-network.test.ts` → "never touches http/https across listAuthors, the guardrail check, and runScan" | `node:http`/`node:https`/global `fetch` are never invoked while running the full scan path (author enumeration, the public-host guardrail, `runScan`) — verified by mocking all three and asserting zero calls, not just by inspection. |
| `test/privacy/zero-network.test.ts` → "has no reference to fetch/http/https network APIs outside the allowlisted files" | Static backstop: no file under `src/` mentions `fetch(`, `node:http`, or `node:https` **except** the three files principle 1 explicitly permits to (`http-client.ts`, `login.ts`, `submit.ts`) — an allowlist, not an enumeration of scan's files, so a new file added to `src/` is network-free by default unless explicitly opted in. |

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
| `test/privacy/skill-detection-taxonomy.test.ts` → "rejects before producing a bundle when a signature names a slug not in taxonomy.json" | Exercises the REAL `runScan` path (via `skillDetectOptions`' override, not a standalone unit test of `detectSkills`): a signature naming a slug outside the closed vocabulary makes `runScan` throw before a bundle is ever constructed — the check lives inside the call path itself, so a future refactor can't silently unwire it without failing this test. See [docs/signatures.md](signatures.md). |
| `test/skill-detect.test.ts` → "every signature's slug is a member of taxonomy.json" | Structural backstop, independent of the runtime check above: every shipped `signatures/*.json` file is statically verified against the real `taxonomy.json` at test time, so a bad slug is caught in CI before it ever ships. |

## 4. User-reviewed

| Test | Proves |
|---|---|
| `test/scan.test.ts` → single-commit / multiple-author cases (implicit) | `runScan` is a pure function of its inputs (repo state + explicit `now`): given the same repository and the same `now`, it returns byte-identical JSON on every call — there is no hidden enrichment step between what a caller inspects and what `submit` would later send, since both would come from calling the same function on the same reviewed bundle. |
| `test/privacy/submit-guardrail.test.ts` → "the request body equals the exact string logged before the upload confirmation" | Closes the gap noted below: `submit` prints the bundle via the same `buildBundleInteractively` path `scan` uses, then uploads that **exact printed string** (`postRawJson`, never a re-serialization of the parsed object) — proven by asserting the mock server's received request body is `===` the printed line, not just deep-equal after re-parsing. |

_Gap closed: `submit` now exists (see [login-submit.md](login-submit.md))_
_and sends the exact bytes `scan`'s bundle-building path printed, verified_
_by the test above._

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

**Implemented, `submit` milestone:** `src/submit.ts`'s `checkVisibilityGate`
is the real, network-backed check described above — an anonymous HTTP
`HEAD` request made directly to the remote URL itself, never to
`SITE_URL`. See [login-submit.md](login-submit.md) for the full behavior.

| Test | Proves |
|---|---|
| `test/submit.test.ts` → "refuses and never uploads when the visibility gate confirms a public remote" | A confirmed `2xx`/`3xx` HEAD response blocks `submit` before any bundle upload request is made — `server.requests` stays empty. |
| `test/submit.test.ts` → "proceeds when the visibility gate finds the remote is not publicly reachable" | A `4xx` HEAD response (private/gated) does not block the upload. |
| `test/privacy/submit-guardrail.test.ts` → "does not call probeFn when the remote URL embeds credentials..." / "...for a self-hosted remote" | The HEAD probe only ever fires for `isKnownPublicHost`-shaped remotes with no embedded credentials or token — it can never turn into an authenticated request the user didn't ask for, and never probes an arbitrary self-hosted URL. |
| `test/privacy/public-remote-guardrail.test.ts` (existing) | `isKnownPublicHost`/`publicHostWarning` themselves stay pure and local — `checkVisibilityGate` only adds a real check on top when they say "known public host", it doesn't change what `scan` does. |

## Guardrail: no token or bundle content in a thrown error

`login`/`submit` are the first commands with anything worth leaking through
an error message — a bearer token, or the full bundle. `src/http-client.ts`
builds every `NetworkError` from the request's host and HTTP status only,
never from response headers or body.

| Test | Proves |
|---|---|
| `test/privacy/submit-guardrail.test.ts` → "a failed upload's error message names the host and status, never the token or bundle" | A `500` from the submit endpoint produces a `NetworkError` whose message contains the status code but neither the stored access token nor any bundle field (`schema_version` as a proxy for "the whole bundle got interpolated in"). |
| `test/login.test.ts` (all cases, implicit) | `login`'s errors (`AuthError` for denied/expired/timed-out) are static, fixed strings — never built from the device code or any server response field, so there's no path for the code to end up in an error either. |
