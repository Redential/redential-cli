#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";
import { runScan, listAuthors, ScanError } from "./scan.js";
import { promptAuthors, promptConfirmAttestation } from "./prompt.js";

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
    const repoPath = resolve(options.repo);
    try {
      let authors = options.author;
      if (authors.length === 0) {
        const candidates = listAuthors(repoPath);
        if (candidates.length === 0) {
          throw new ScanError("This repository has no commits yet — nothing to scan.");
        }
        authors = await promptAuthors(candidates);
      }

      let confirmed = options.yes;
      if (!confirmed) {
        confirmed = await promptConfirmAttestation();
      }

      const bundle = runScan({ repoPath, authors, confirmed, toolVersion: getToolVersion() });
      console.log(JSON.stringify(bundle, null, 2));
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
