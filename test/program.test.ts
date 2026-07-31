import {describe, expect, it } from "vitest";
import {createProgram} from "../src/program.js"
import { readFileSync } from "node:fs";
import { CommanderError } from "commander";

const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8")
) as { version: string };

const expectedVersion = pkg.version;

describe("--version", ()=>{
    it("prints the package version", ()=>{
        let output = "";
        const program = createProgram();
        program.exitOverride().configureOutput({
            writeOut: (str) => {
                output+= str;
            },
        });
        let caught: unknown;
        try {
          program.parse(["--version"], { from: "user" })
        } catch (err) {
           caught = err;
        }
        expect(caught).toBeInstanceOf(CommanderError);
        expect((caught as CommanderError).code).toBe("commander.version");
        expect(output.trim()).toBe(expectedVersion);
    }),
    it("prints the package version with -V", ()=>{
        let output = "";
        const program = createProgram();
        program.exitOverride().configureOutput({
            writeOut: (str) => {
                output+= str;
            },
        });
        let caught: unknown;
        try {
          program.parse(["-V"], { from: "user" })
        } catch (err) {
           caught = err;
        }
        expect(caught).toBeInstanceOf(CommanderError);
        expect((caught as CommanderError).code).toBe("commander.version");
        expect(output.trim()).toBe(expectedVersion);
    })
})