/*
 * Hand-written ambient declarations for the exact Node.js surface `src/`
 * uses. CLAUDE.md permits zero dependencies beyond commander + vitest, so
 * this repo deliberately does not depend on @types/node.
 */

declare var process: {
  argv: string[];
  exitCode: number | undefined;
  env: Record<string, string | undefined>;
  platform: string;
  stdin: unknown;
  stdout: unknown;
  stderr: unknown;
  exit(code?: number): never;
};

declare var console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
};

interface ImportMeta {
  url: string;
}

declare module "node:fs" {
  export function existsSync(path: string): boolean;
  export function readFileSync(path: string | URL, encoding: "utf8"): string;
  export function writeFileSync(
    path: string,
    data: string,
    options?: { mode?: number }
  ): void;
  export function mkdirSync(
    path: string,
    options?: { recursive?: boolean }
  ): void;
  export function unlinkSync(path: string): void;
}

declare module "node:path" {
  export function join(...parts: string[]): string;
  export function resolve(...parts: string[]): string;
  export function extname(path: string): string;
}

declare module "node:os" {
  export function homedir(): string;
}

declare module "node:crypto" {
  export interface Hash {
    update(data: string): Hash;
    digest(encoding: "hex"): string;
  }
  export function createHash(algorithm: string): Hash;
  export function randomBytes(size: number): { toString(encoding: string): string };
}

declare module "node:child_process" {
  export function execFileSync(
    command: string,
    args: string[],
    options?: { cwd?: string; encoding?: string; stdio?: unknown }
  ): string;
  export interface ChildProcess {
    on(event: "error", listener: (err: Error) => void): ChildProcess;
    unref(): ChildProcess;
  }
  export function spawn(
    command: string,
    args: string[],
    options?: { detached?: boolean; stdio?: unknown }
  ): ChildProcess;
}

declare module "node:readline/promises" {
  export interface Interface {
    question(prompt: string): Promise<string>;
    close(): void;
    once(event: "close", listener: () => void): Interface;
  }
  export function createInterface(options: {
    input: unknown;
    output: unknown;
  }): Interface;
}
