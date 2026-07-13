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
  stdout: { isTTY?: boolean };
  stderr: { isTTY?: boolean; write(chunk: string): boolean };
  exit(code?: number): never;
};

// Minimal surface of Node's global Buffer — added for git.ts's
// readHeadBlobContents (`git cat-file --batch` parsing), which needs
// byte-accurate slicing (a UTF-8 file's declared size in BYTES doesn't
// equal its JS string length whenever it contains multi-byte characters,
// so parsing that protocol correctly requires real binary buffers, not
// string chunks). Same "hand-written, just enough of the real API" policy
// as every other declaration in this file — not a dependency on
// @types/node.
declare class Buffer {
  readonly length: number;
  static alloc(size: number): Buffer;
  static concat(list: Buffer[]): Buffer;
  indexOf(value: string): number;
  slice(start?: number, end?: number): Buffer;
  toString(encoding?: string): string;
}

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
  export interface Dirent {
    name: string;
    isDirectory(): boolean;
    isFile(): boolean;
  }
  export function readdirSync(
    path: string | URL,
    options: { withFileTypes: true }
  ): Dirent[];
}

declare module "node:path" {
  export function join(...parts: string[]): string;
  export function resolve(...parts: string[]): string;
  export function extname(path: string): string;
}

declare module "node:url" {
  export function fileURLToPath(url: string | URL): string;
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
  // Just enough of a Readable stream to consume a spawned process' stdio:
  // encoding-aware "data" events (string chunks once setEncoding is
  // called) for streaming/batched command output, never buffering it all
  // via execFileSync's return value — see git.ts's getAllCommits and
  // getCommitsAddedLines.
  // Two overloads, not a `string | Buffer` union: a stream is string-mode
  // once `setEncoding` was called (every existing call site in this repo)
  // or raw-Buffer-mode when it wasn't (git.ts's readHeadBlobContents, which
  // needs byte-accurate binary parsing — see the Buffer declaration
  // above); overloads let each call site's explicitly-typed callback
  // (`(chunk: string) => …` vs `(chunk: Buffer) => …`) typecheck against
  // the mode it actually uses, rather than forcing every caller to
  // narrow/cast a union on every chunk.
  export interface ReadableStream {
    setEncoding(encoding: string): void;
    on(event: "data", listener: (chunk: string) => void): ReadableStream;
    on(event: "data", listener: (chunk: Buffer) => void): ReadableStream;
  }
  // Just enough of a Writable stream to feed a spawned process' stdin (a
  // batch of paths, one per line) — see git.ts's readHeadBlobContents.
  export interface WritableStream {
    write(chunk: string): boolean;
    end(): void;
  }
  export interface ChildProcess {
    stdout: ReadableStream | null;
    stderr: ReadableStream | null;
    stdin: WritableStream | null;
    on(event: "error", listener: (err: Error) => void): ChildProcess;
    on(event: "close", listener: (code: number | null) => void): ChildProcess;
    unref(): ChildProcess;
  }
  export function spawn(
    command: string,
    args: string[],
    options?: { cwd?: string; detached?: boolean; stdio?: unknown }
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
