#!/usr/bin/env node
// Minimal launcher: this package is just a bare-name alias for
// @redential/cli. It carries no logic of its own — importing the real
// package's bin executes it immediately (it calls Command#parse(), which
// reads process.argv and sets process.exitCode on error), so argv and exit
// codes are forwarded naturally, with nothing re-implemented here.
import "@redential/cli/dist/cli.js";
