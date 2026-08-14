/**
 * Wraps `text` in ANSI dim + bright-black ("dim gray") escape codes when
 * stderr is a real terminal, and returns it unchanged otherwise. Used for
 * calm, informational stderr notices — the local-only privacy line
 * (build-bundle.ts) and the end-of-scan connectable-repo notice
 * (scan-command.ts) — so they read as ambient, reassuring text rather than
 * an alert. Red/orange/warning colors are reserved for real errors only
 * (see program.ts's error-handling path, which never applies color at
 * all today); this file never uses them.
 *
 * Reads `process.stderr.isTTY` directly rather than threading a new
 * injectable option through every caller — every caller here already lets
 * tests fully override `warn` itself (a plain string collector), so no
 * test depends on this styling either way; a piped/redirected/CI stderr
 * never receives escape codes, keeping every existing plain-string
 * assertion in the test suite unaffected.
 */
export function dim(text: string): string {
  if (process.stderr.isTTY !== true) return text;
  return `\x1b[2m\x1b[90m${text}\x1b[0m`;
}
