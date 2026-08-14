const KNOWN_PUBLIC_HOSTS = [/github\.com/, /gitlab\.com/, /bitbucket\.org/];

/**
 * Heuristic only — NOT a network-verified "is this actually publicly
 * fetchable" check (that would require a request, and `scan` never makes
 * one). True accessibility depends on the repo's own visibility setting on
 * that host, which only the host itself knows. This only recognizes
 * well-known public-hosting domains and rules out URLs carrying embedded
 * credentials (a strong signal of gated, non-public access).
 *
 * Known host != publicly accessible: the CLI's PRIMARY use case is a
 * private employer repo hosted on github.com, so this must never block
 * scanning — see publicHostWarning below and docs/privacy-tests.md.
 *
 * The real, network-backed check lives in submit.ts's checkVisibilityGate:
 * an anonymous HEAD request made directly to the remote URL itself (never
 * to Redential's servers), gated on isKnownPublicHost being true here
 * first. `scan` never calls it — only `submit`, which already makes
 * network calls, may.
 */
export function isKnownPublicHost(remoteUrl: string | null): boolean {
  if (!remoteUrl) return false;
  if (/:\/\/[^/@]+:[^/@]+@/.test(remoteUrl)) return false; // embedded user:pass or token-as-password
  if (/[?&](?:token|access_token)=/i.test(remoteUrl)) return false; // token in the URL itself
  return KNOWN_PUBLIC_HOSTS.some((host) => host.test(remoteUrl));
}

/**
 * Informational only — returns a message to print, or null. Never a
 * reason to skip scanning: this heuristic can say "this MIGHT be
 * connectable", never "this IS public", so blocking on it would break the
 * CLI's main use case (a private employer repo that happens to be hosted
 * on github.com). The user decides; `scan` always proceeds.
 *
 * This is `submit`'s own fallback wording — used only inside
 * `checkVisibilityGate`'s (submit.ts) inconclusive-result branches, never
 * printed pre-emptively by `scan`/`submit` before their own flow starts
 * (see `connectableRepoNotice` below for that). `submit` already has a
 * network-backed, definitive answer for a known-public-host remote (the
 * gate itself), so this longer, multi-line message only surfaces there
 * when the gate genuinely couldn't tell either way.
 */
export function publicHostWarning(remoteUrl: string | null): string | null {
  if (!isKnownPublicHost(remoteUrl)) return null;
  return (
    "This repo appears connectable through GitHub.\n\n" +
    "For repos you own, the GitHub App provides stronger evidence.\n" +
    "For employer or NDA-protected repos, continue with the local scan."
  );
}

/**
 * Console-UX overhaul (2026-08): `scan`'s own connectable-repo notice — a
 * single, non-blocking line printed at the END of `scan`'s output
 * (scan-command.ts), never at the start, and never followed by any
 * question ("Continue locally?" is gone entirely — see docs/scan.md). Same
 * heuristic and the same "never a reason to skip scanning" stance as
 * `isKnownPublicHost`/`publicHostWarning` above; deliberately generic about
 * which known host matched (github.com/gitlab.com/bitbucket.org) rather
 * than echoing any part of the actual remote URL back, so this can never
 * leak an org/repo name into the terminal beyond what `isKnownPublicHost`
 * itself already had to read locally to answer the question.
 */
export function connectableRepoNotice(remoteUrl: string | null): string | null {
  if (!isKnownPublicHost(remoteUrl)) return null;
  return (
    "This repo's remote is on a public git host — the GitHub App can add server-side attestation " +
    "on top of this scan."
  );
}
