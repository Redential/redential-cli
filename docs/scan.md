# `redential scan`

Reads git history from a local repository and prints the exact proof bundle
that `submit` would upload later — nothing is sent anywhere by `scan` itself.

```bash
redential scan --repo <path>              # interactive author + confirmation
redential scan --author you@example.com --yes   # non-interactive
```

## How it works

1. **Enumerate authors.** `git log` is read locally (`git show`/`git diff`
   never leave the machine) to list distinct author emails and their commit
   counts.
2. **Select identity.** With a single candidate, a Y/n confirmation ("Found
   1 identity: you@example.com (12 commits). Is this you? (Y/n)", Y is the
   default — pressing Enter accepts). With 2+ candidates, a numbered list
   instead — there's no single obvious default to pick for those.
   Non-interactively, pass `--author <email>` (repeatable) for every email
   that's yours.
3. **Confirm authorization.** You must explicitly confirm "I am authorized
   to analyze this repository" — interactively via a prompt, or
   non-interactively via `--yes`. This is a separate step from author
   selection on purpose: `--author` only answers "which emails are mine",
   not "I'm allowed to scan this repo". Both are required before a bundle
   is produced.
4. **Compute the bundle.** Every field in `schema/bundle.v1.json` is derived
   from `git log --numstat` filtered to your selected commits: volume, span,
   hourly/weekday cadence, signed-commit ratio, churn share by file
   extension and by technical category (heuristic path/extension matching,
   `signatures/*.json`-based skill detection lands in a later milestone —
   `detected_skills` is always `[]` for now), and ownership share against
   the repo's total commits.
5. **Print it.** The JSON printed IS the bundle — byte for byte what
   `submit` would send later.

## Design notes

- **Device salt.** `repo_fingerprint` and `author_identity_hashes` are
  salted with a random value generated once and persisted at
  `~/.config/redential/salt` (0600), the same pattern as
  `credentials.json` (see [login-submit.md](login-submit.md)). The salt is
  device-local, not account-anchored — it survives `redential logout` and
  its only job is preventing rainbow-table lookups, independent of any
  session.
- **Empty / unmatched repos fail loudly.** A repository with zero commits,
  or a `--author` that matches no commits, raises an error and exits
  non-zero rather than fabricating a bundle with meaningless dates.
- **No JSON-Schema library at runtime.** The CLI builds the bundle from a
  strongly-typed `Bundle` interface (`src/types.ts`) that mirrors the
  schema; actual conformance against `schema/bundle.v1.json` is verified by
  the test suite (`test/support/schema-validate.ts`), not by shipping a
  schema validator in the published package.
