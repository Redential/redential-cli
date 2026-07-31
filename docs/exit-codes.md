# Exit codes

Redential uses a small, scriptable exit-code surface. Every command goes
through the same top-level handler in `src/program.ts` (`run()`): domain
failures print `Error: …` on **stderr** and set exit code **1**; everything
else finishes with exit code **0** (Node's default when `process.exitCode` is
never set).

## Summary

| Code | Meaning |
| ---- | ------- |
| **0** | Success — the command completed its work, including intentional no-ops described below. |
| **1** | Expected failure — a `ScanError`, `AuthError`, `SubmitError`, or `NetworkError` (see [errors](#domain-errors-exit-1)). Commander flag/argument mistakes also exit **1** when `parse()` rejects the invocation. |

Unhandled exceptions (bugs, unexpected I/O failures outside those four error
types) may exit with a non-zero code that is **not** part of this contract.

## Domain errors (exit 1)

| Error type | Typical causes |
| ---------- | -------------- |
| `ScanError` | Invalid repo or git state, missing `--author` / `--yes` in non-interactive mode, validation failures (private label, `--since`, secrets in bundle), unsupported `explain` skill, malformed internal signature files. |
| `AuthError` | `submit` without a stored session, wrong site URL on stored credentials, login denied/expired/timed out. |
| `SubmitError` | Upload refused after the remote-visibility gate (confirmed-public repo). |
| `NetworkError` | Login or submit HTTP failures (unreachable host, non-JSON response, unexpected status) after retries where applicable. |

Messages are sanitized user-facing strings only — never tokens or bundle
payloads.

## Success with exit 0 (including no-ops)

These paths are deliberate so CI and shell scripts can treat **0** as "nothing
went wrong," even when no bundle was printed or uploaded:

| Command | Exit 0 when… |
| ------- | -------------- |
| `scan` | A bundle was produced (JSON on stdout when piped/`--json`, or the TTY summary otherwise). |
| `scan` | On a TTY, you answer **n** to "Continue locally?" for a connectable-looking remote — no scan runs ([scan.md](scan.md#how-it-works)). |
| `submit` | You decline the upload prompt (`Aborted — nothing was uploaded.`) — bundle may have been built and printed, but nothing was sent. |
| `submit` | Bundle upload succeeded, even if the follow-up private-label request failed (warning on stderr; see [private-label.md](private-label.md)). |
| `login` / `logout` | Session stored or removed locally. |
| `status` | Local state printed (always read-only, no network). |
| `explain` | Explanation printed for a supported skill (spike command). |

A successful `scan` in a pipeline:

```bash
redential scan --repo . --author you@example.com --yes --json | jq .
test "${PIPESTATUS[0]}" -eq 0
```

Non-interactive upload (all consent flags required):

```bash
redential submit --repo . \
  --author you@example.com \
  --yes \
  --confirm-upload \
  --label "Acme Corp"
```

See [login-submit.md](login-submit.md) for the full `login` / `submit` flow.

## Stability

For scripting and CI, treat this table as part of the CLI's public contract:

- **0** means success and **1** means an expected, documented failure class
  above. Those meanings will not be swapped or narrowed without a **major**
  semver release.
- New legitimate success no-ops may be documented in a **minor** release
  (still exit **0**).
- New failure modes that should fail closed in automation will continue to use
  exit **1** via the four domain error types where possible.

Bundle JSON on stdout is versioned separately ([schema](schema.md)); exit
codes describe process outcome only.
