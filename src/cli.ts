#!/usr/bin/env node
import { isNodeVersionSupported, MIN_SUPPORTED_NODE_MAJOR } from "./node-version.js";

// Runs BEFORE anything else in this file is loaded (see node-version.ts's
// own comment on why it has zero imports): on a too-old Node, every other
// module here is only reachable via the dynamic import below, so a version
// mismatch never gets far enough to hit a version-sensitive crash (e.g.
// `ReferenceError: fetch is not defined`, missing on Node < 18) — instead
// it's a single clean message on stderr and a clean exit 1, matching the
// repo's error policy of never surfacing a raw stack trace to the user.
if (!isNodeVersionSupported(process.version)) {
  process.stderr.write(
    `redential requires Node.js ${MIN_SUPPORTED_NODE_MAJOR} or newer. You are running ${process.version}. Please upgrade Node.js.\n`
  );
  process.exit(1);
}

// Invoked without a top-level `await`: identical runtime behavior (Node
// keeps the process alive until this promise settles either way, and any
// rejection here is a genuine bug — commander's own .action() handlers are
// the ones responsible for catching and reporting command errors, see
// program.ts's `run()`), but esbuild's CommonJS output target
// (scripts/build-sea.mjs, the Node SEA binary build) doesn't support
// top-level await, and this repo ships one source tree for both the
// published ESM package and the bundled SEA binary.
async function main(): Promise<void> {
  const { createProgram } = await import("./program.js");
  createProgram().parse();
}

void main();
