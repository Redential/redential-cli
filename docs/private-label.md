# Private label — a mandatory nickname that travels ALONGSIDE the bundle, never inside it

This document is the prior discussion record CLAUDE.md requires for any
change to WHAT data leaves the machine ("any change to WHAT data leaves
the machine requires: (1) a prior discussion issue, (2) a schema version
bump, (3) an entry in docs/schema.md and CHANGELOG.md"). This repo has a
single owner rather than a public issue tracker for this kind of decision,
so this file plays that role — same as
[docs/schema-change-h7.md](schema-change-h7.md) before it. Unlike H7, this
change does **not** touch `schema/bundle.v1.json` at all (see "Why outside
the bundle" below) — no schema version bump applies here, and that absence
is itself part of the design, not an oversight.

## What travels, and when

Every `redential submit` now sends a **second** HTTP request, made only
after the bundle POST has already succeeded:

1. `POST {SITE_URL}/api/cli/bundles` — unchanged, byte-for-byte the same
   request this CLI has always made (see [docs/login-submit.md](login-submit.md)).
2. `POST {SITE_URL}/api/cli/private-label` — new. Body:
   `{"bundle_id": "<id returned by request 1>", "private_label": "<the
   label>"}`. `Authorization: Bearer <the same device-flow token>`.

The label is a single short string the user types themselves (or passes
via `--label`), collected and validated locally, sent in this second
request's body only — never folded into the bundle JSON, never added as a
header on the bundle POST, never present anywhere in request 1.

## Why OUTSIDE the bundle

The bundle's whole design ceiling is "zero free text derived from your
code" (see [docs/principles.md](principles.md), principle 3, "Bounded
output") — every field is a closed enum, a hash, or a number computed from
git history. A private label is fundamentally different in kind: it is a
**user claim**, typed by the user, about something the CLI has no way to
derive or verify locally (which employer/team/context this repo belongs
to) — the same category as the employer name a user might type into
Redential's own web UI when claiming a credential, not a new category of
repo-derived metadata. Folding it into the bundle would either (a) require
loosening the bundle's zero-free-text ceiling — a real, structural
weakening of the strongest privacy claim this CLI makes — or (b) require
inventing a closed-vocabulary encoding for something that is, by
definition, open-ended (nobody can enumerate every employer/repo name in
`taxonomy.json`). Keeping it as a wholly separate request, to a wholly
separate endpoint, with its own explicit consent line, preserves the
bundle's ceiling exactly as absolute as it was before this feature existed
— the amended trust story (below) says this precisely.

## The honest warning

Users may — and predictably will — type a real employer or client name
into this prompt ("Acme Corp — backend", "ClientCo Q3 contract"). That is
expected and fine, but it is server-side sensitive, owner-only data, not
public metadata: unlike a public profile's Attested capability list, the
private label is never intended to be shown to anyone but the account
owner. This document exists partly to say that plainly rather than let it
be discovered as a surprise: **treat the private label with the same care
you'd give a note-to-self about who you work for, because that is exactly
what it structurally is.**

## Why mandatory, not optional (owner's decision)

The label is required on every `submit`, not an opt-in flag. This was an
explicit owner decision, not a default inherited from anywhere else in the
codebase (every other consent surface in this CLI — the authorization
attestation, the upload confirmation — is also mandatory, but each guards
a yes/no decision; the label is the first mandatory **free-text** input).
The reasoning: a private label only has value if it exists consistently
across submissions — an optional field would mean most users skip it, and
the feature would silently fail to do its job (letting an owner
distinguish "Acme Corp repo #1" from "Acme Corp repo #2" from "ClientCo
repo" on their own dashboard) for the exact users who most need it (anyone
submitting from more than one private repo). Mandatory-by-default is the
only version of this feature that reliably works.

## The fixed contract

This is the exact contract the redence server is built against, held
constant while both sides implement in parallel:

```
POST {SITE_URL}/api/cli/private-label
Authorization: Bearer <the same device-flow token submit already uses>
Body: {"bundle_id": "<id>", "private_label": "<validated label>"}

204  — success, no body
401  — invalid session
404  — bundle not found / not this account's bundle
422  — invalid label
```

### Label validation (shared between `--label` and the interactive prompt)

Exactly one validation function (`src/private-label.ts`'s
`validatePrivateLabel`) gates both entry points, so they can never
diverge on what counts as valid:

- Trimmed first (an all-whitespace answer counts as empty).
- Non-empty after trimming.
- 64 characters or fewer.
- No control characters.
- Runs through `assertNoSecrets` (`src/secret-scan.ts`) — the exact same
  patterns the bundle payload itself is scanned against. **A secret typed
  into the label blocks the whole submit**, exactly like a secret found in
  the bundle: nothing uploads, not even the bundle, even though the
  secret would only ever have appeared in the label request. This is
  deliberately the same bar, not a lighter one, since the label travels to
  the same server the bundle does.

## Mandatory-prompt behavior

- **A real TTY, no `--label`:** interactive prompt — `Private label for
  this repo (only you will ever see it): `. An invalid answer (empty, too
  long, control characters, or secret-shaped) re-asks, up to 2 retries (3
  attempts total); the final failed attempt raises the specific validation
  error and aborts — [exit 1](exit-codes.md), **nothing was uploaded**, not even the
  bundle. This is a deliberate widening of the spec's literal "empty
  answer re-asks" language to cover every validation failure the same way
  (rather than treating an over-long or secret-shaped answer differently
  from an empty one) — one consistent re-ask behavior is easier to reason
  about than three different ones for what is, from the user's point of
  view, the same situation ("that answer doesn't work, try again").
- **Non-TTY, or `--label` simply never given:** there is no way to prompt,
  so this is an immediate, clear error — **before any network call at
  all**, not just before the bundle upload. `submit` requires `--label
  <text>` in this mode; its absence exits 1 with nothing sent anywhere.
- **`--label` given (TTY or not):** validated immediately, same rules,
  same shared function. An invalid value is a hard error before any
  network call — no reason to defer a value already in hand.

### TTY output position

The label sits inside the same consent surface as everything else `submit`
shows before asking for upload consent (principle 4, "User-reviewed" —
"no hidden fields, no enrichment after review"). Full order:

```
short summary
  ↓
identity-corroboration line (if present)
  ↓
WHAT GETS UPLOADED box
  ↓
[interactive label prompt fires here, only if --label wasn't given]
  ↓
"Exact payload (byte-for-byte what gets sent):" + the bundle JSON
  ↓
Plus your private label: «X» (travels alongside the bundle, never inside
it — only you will ever see it)
  ↓
"Upload this bundle? (y/n)"
```

The label line is the last thing printed before the y/n prompt — same
"shown before consent" guarantee the JSON print already has, extended to
cover the one additional thing this milestone adds to what actually
travels.

## Failure semantics (the second request, after the bundle already uploaded)

If the bundle POST fails, nothing about the label matters — `submit` never
reaches the label request at all, same as before this feature existed.

If the bundle POST **succeeds** and the label POST then fails (network
error, 401, 404, 422, or any other unexpected status): `submit` **never
retries the label request and never re-uploads the bundle.** The bundle is
already safely stored server-side; retrying or re-sending it on an
unrelated failure would risk creating duplicate submissions for a problem
that has nothing to do with the bundle itself. Instead:

- A clear warning is printed (stderr), naming what went wrong and
  repeating the label the user typed, plus a note that it can be set later
  from the web (`src/submit.ts`'s `postPrivateLabel` never throws — it
  always resolves to `{ok, message}`, and `submit-command.ts` turns a
  `{ok: false}` into exactly this warning).
- **Exit code stays 0.** This is the deliberate decision this milestone
  makes explicit: the bundle upload — the part of `submit` that actually
  matters most, and the part every existing privacy/guardrail test already
  pins — fully succeeded. A non-zero exit here would tell a scripted
  caller (`redential submit --yes --confirm-upload --label ...`) that the
  whole operation failed, which isn't true; the recovery path (set the
  label from the web) is real and low-stakes, unlike a failed bundle
  upload which has no equivalent recovery. `src/cli.ts`'s `run()` only
  sets `process.exitCode = 1` when a `ScanError`/`AuthError`/
  `SubmitError`/`NetworkError` is thrown; `postPrivateLabel`'s contract of
  never throwing is exactly what makes this exit-0-with-warning behavior
  fall out naturally rather than needing special-casing in `cli.ts`.

## Never stored locally

`last-submission.json` (`src/submission-record.ts`) already exists for
local bookkeeping (letting a later `scan` tell "already submitted, nothing
new" from "not yet submitted" — see [docs/login-submit.md](login-submit.md)).
The private label is deliberately **not** added to it. That file is
written without restricted (`0600`) permissions, on the reasoning that its
contents are just a hash of content the user already reviewed and
uploaded — not a secret. A private label is different: free text a user
may reuse across employers/repos, exactly the kind of thing that
shouldn't accumulate in a local, unprotected file on disk. It is never
read back for anything locally, so there is no functional reason to store
it, and a real reason (this file's unprotected-permissions posture) not to.

## The amended trust story

Every prior claim this CLI makes about what leaves the machine
(`docs/principles.md`, the README's Trust model table) is unchanged and
still absolute — the bundle itself carries zero free text derived from
your code, still, exactly as before. What's new is one additional,
narrowly scoped exception, stated precisely so it can't be mistaken for a
weakening of the rest:

> The CLI transmits no free text derived from your code. It transmits
> exactly one free-text field you type yourself, shown before consent,
> owner-visible only.

That sentence is deliberately the whole amendment — everything else in
`docs/principles.md` still applies unchanged, and this is the only place
in the entire CLI where a user-authored string, rather than something
derived from repository data, ever leaves the machine.
