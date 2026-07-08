#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";
import { ScanError } from "./errors.js";
import { executeScanCommand } from "./scan-command.js";

function getToolVersion(): string {
  const pkgUrl = new URL("../package.json", import.meta.url);
  const pkg = JSON.parse(readFileSync(pkgUrl, "utf8")) as { version: string };
  return pkg.version;
}

function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
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
  .action(async (options: { repo: string; author: string[]; yes: boolean }) => {
    try {
      await executeScanCommand({
        repoPath: resolve(options.repo),
        author: options.author,
        yes: options.yes,
        toolVersion: getToolVersion(),
      });
    } catch (err) {
      if (err instanceof ScanError) {
        console.error(`Error: ${err.message}`);
        process.exitCode = 1;
        return;
      }
      throw err;
    }
  });

program.parse();
