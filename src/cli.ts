#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";
import { ScanError, AuthError, SubmitError, NetworkError } from "./errors.js";
import { executeScanCommand } from "./scan-command.js";
import { executeSubmitCommand } from "./submit-command.js";
import { runLogin } from "./login.js";
import { runLogout } from "./logout.js";
import { shouldUsePlainOutput } from "./summary.js";

function getToolVersion(): string {
  const pkgUrl = new URL("../package.json", import.meta.url);
  const pkg = JSON.parse(readFileSync(pkgUrl, "utf8")) as { version: string };
  return pkg.version;
}

function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

/** The domain errors every command may throw — never wraps a raw fetch/fs
 * error, so this catch can safely print `err.message` without risking a
 * token or bundle leaking through an unsanitized underlying error. */
function isCliError(err: unknown): err is Error {
  return (
    err instanceof ScanError ||
    err instanceof AuthError ||
    err instanceof SubmitError ||
    err instanceof NetworkError
  );
}

async function run(action: () => Promise<void> | void): Promise<void> {
  try {
    await action();
  } catch (err) {
    if (isCliError(err)) {
      console.error(`Error: ${err.message}`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

const program = new Command();
program.name("redential").description("Local, metadata-only proof bundles from git history.");

program
  .command("scan")
  .description("Scan the local git history and print the proof bundle (nothing is uploaded).")
  .option("--repo <path>", "path to the git repository to scan", ".")
  .option(
    "--author <email>",
    "author email that is yours (repeatable); enables non-interactive mode",
    collect,
    [] as string[]
  )
  .option(
    "--yes",
    "confirm 'I am authorized to analyze this repository' non-interactively",
    false
  )
  .option(
    "--json",
    "force JSON-only output, even on an interactive terminal (default when piped)",
    false
  )
  .option(
    "--since <spec>",
    'limit analysis to commits at/after this date — a relative window ("2years", "18months", "30days") or an absolute date ("2024-01-01"); see docs/scan.md'
  )
  .action(async (options: { repo: string; author: string[]; yes: boolean; json: boolean; since?: string }) => {
    await run(() =>
      executeScanCommand({
        repoPath: resolve(options.repo),
        author: options.author,
        yes: options.yes,
        toolVersion: getToolVersion(),
        isTTY: process.stdout.isTTY === true,
        json: options.json,
        plain: shouldUsePlainOutput(process.platform, process.env),
        since: options.since,
      })
    );
  });

program
  .command("login")
  .description("Authenticate via device flow and store a session token locally.")
  .action(async () => {
    await run(() => runLogin());
  });

program
  .command("logout")
  .description("Delete the locally stored session token.")
  .action(async () => {
    await run(() => runLogout());
  });

program
  .command("submit")
  .description("Scan, review, and upload a proof bundle. Requires a prior `redential login`.")
  .option("--repo <path>", "path to the git repository to scan", ".")
  .option(
    "--author <email>",
    "author email that is yours (repeatable); enables non-interactive mode",
    collect,
    [] as string[]
  )
  .option(
    "--yes",
    "confirm 'I am authorized to analyze this repository' non-interactively",
    false
  )
  .option("--confirm-upload", "confirm the upload itself non-interactively (separate from --yes)", false)
  .action(async (options: { repo: string; author: string[]; yes: boolean; confirmUpload: boolean }) => {
    await run(() =>
      executeSubmitCommand({
        repoPath: resolve(options.repo),
        author: options.author,
        yes: options.yes,
        confirmUpload: options.confirmUpload,
        toolVersion: getToolVersion(),
      })
    );
  });

program.parse();
