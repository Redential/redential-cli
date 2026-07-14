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
 * This text is shown in EVERY mode (TTY and non-TTY/piped) via `warn()` —
 * always non-blocking on its own. In a real interactive terminal, callers
 * (see build-bundle.ts) additionally ask a follow-up "Continue locally?
 * (Y/n)" question after printing this; that question is a separate,
 * TTY-only interactive prompt (prompt.ts's promptContinueLocally), not part
 * of this string, so a piped `scan`/`submit` never has an unanswerable
 * question sitting in its (non-blocking) warning output. Console-UX
 * milestone (2026-07): CLAUDE.md's "warn, never block" convention wording
 * still needs a follow-up edit to describe this TTY-only confirmation —
 * left for phase 3 (docs alignment), which owns CLAUDE.md.
 */
export function publicHostWarning(remoteUrl: string | null): string | null {
  if (!isKnownPublicHost(remoteUrl)) return null;
  return (
    "This repo appears connectable through GitHub.\n\n" +
    "For repos you own, the GitHub App provides stronger evidence.\n" +
    "For employer or NDA-protected repos, continue with the local scan."
  );
}
