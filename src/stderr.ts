/**
 * Plain, non-error stderr line — deliberately NOT `console.error`.
 *
 * Bug fix (owner follow-up, 2026-08 — reproduced via pty): Node.js
 * automatically wraps `console.error`/`console.warn` output in red/yellow
 * ANSI codes (`\x1b[31m...\x1b[39m`) whenever the destination stream is a
 * color-capable TTY — this is a Node built-in, not something this codebase
 * ever asked for, and it applied to every informational stderr line in
 * this CLI (the local-only notice, the expectation-setting line, the
 * connectable-repo notice, the shallow-repo/thin-history notices, ...)
 * simply because they all defaulted to `console.error` as their `warn`
 * implementation. Wrapping a line in `dim()` (src/dim.ts) on top of that
 * only nested our own codes INSIDE Node's own red wrapper — it never
 * removed the red.
 *
 * The owner's rule is absolute: red/orange/warning colors are reserved for
 * REAL errors only. `src/program.ts`'s actual `Error: ...` path still uses
 * `console.error` on purpose (that red IS correct there). Every other
 * informational/non-blocking stderr line in this CLI (`warn` in
 * build-bundle.ts/scan-command.ts/submit-command.ts, `log` in
 * version-check.ts) must default to this function instead, so red is never
 * applied by accident.
 */
export function writeStderrLine(message: string): void {
  process.stderr.write(`${message}\n`);
}
