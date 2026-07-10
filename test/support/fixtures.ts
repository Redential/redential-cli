import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

export interface CommitSpec {
  message: string;
  authorName: string;
  authorEmail: string;
  files: Record<string, string>;
  sign?: boolean;
  authorDate?: string;
}

function run(cwd: string, args: string[], env?: Record<string, string>): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  }).toString();
}

/** Fresh git repo in a tmpdir — never a committed fixture with real history. */
export function createRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "redential-test-"));
  run(dir, ["init", "-q", "-b", "main"]);
  // Without this, a CI runner whose global gitconfig sets core.autocrlf=true
  // (the Windows default) would silently rewrite any CRLF bytes a fixture
  // writes into LF on `git add`, before they ever reach a diff — masking
  // exactly the line-ending bugs these fixtures exist to catch on that one
  // platform. Repo-local, so it can never affect the CLI's own git config.
  run(dir, ["config", "core.autocrlf", "false"]);
  return dir;
}

export function commit(dir: string, spec: CommitSpec): string {
  for (const [file, content] of Object.entries(spec.files)) {
    const filePath = join(dir, file);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, content);
  }
  run(dir, ["add", "-A"]);

  const env: Record<string, string> = {
    GIT_AUTHOR_NAME: spec.authorName,
    GIT_AUTHOR_EMAIL: spec.authorEmail,
    GIT_COMMITTER_NAME: spec.authorName,
    GIT_COMMITTER_EMAIL: spec.authorEmail,
  };
  if (spec.authorDate) {
    env.GIT_AUTHOR_DATE = spec.authorDate;
    env.GIT_COMMITTER_DATE = spec.authorDate;
  }

  const args = ["commit", "-q", "-m", spec.message];
  if (spec.sign) args.push("-S");
  run(dir, args, env);

  return run(dir, ["rev-parse", "HEAD"]).trim();
}

/**
 * Configures ssh-format commit signing with a throwaway key, local to the
 * fixture repo, plus an allowedSignersFile for `signerEmail` — without it,
 * git can't verify the signature and reports `%G?` as "N" (no signature)
 * even though one is embedded in the commit object.
 */
export function setupSshSigning(dir: string, signerEmail: string): void {
  const keyPath = join(dir, ".test-signing-key");
  execFileSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", keyPath], {
    cwd: dir,
    stdio: "ignore",
  });
  run(dir, ["config", "gpg.format", "ssh"]);
  run(dir, ["config", "user.signingkey", keyPath]);

  const publicKey = readFileSync(`${keyPath}.pub`, "utf8");
  const allowedSignersPath = join(dir, ".test-allowed-signers");
  writeFileSync(allowedSignersPath, `${signerEmail} ${publicKey}`);
  run(dir, ["config", "gpg.ssh.allowedSignersFile", allowedSignersPath]);
}

/**
 * Same as setupSshSigning, but the allowedSignersFile lists a DIFFERENT
 * key for `signerEmail` than the one that actually signs — reproduces the
 * "%G? == U" (good signature, unmatched/untrusted key) case, distinct from
 * a genuinely verified "%G? == G" signature.
 */
export function setupSshSigningWithMismatchedTrust(dir: string, signerEmail: string): void {
  const signingKeyPath = join(dir, ".test-signing-key");
  const unrelatedKeyPath = join(dir, ".test-unrelated-key");
  for (const keyPath of [signingKeyPath, unrelatedKeyPath]) {
    execFileSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", keyPath], {
      cwd: dir,
      stdio: "ignore",
    });
  }
  run(dir, ["config", "gpg.format", "ssh"]);
  run(dir, ["config", "user.signingkey", signingKeyPath]);

  const unrelatedPublicKey = readFileSync(`${unrelatedKeyPath}.pub`, "utf8");
  const allowedSignersPath = join(dir, ".test-allowed-signers");
  writeFileSync(allowedSignersPath, `${signerEmail} ${unrelatedPublicKey}`);
  run(dir, ["config", "gpg.ssh.allowedSignersFile", allowedSignersPath]);
}

/** Purely local git config — never dials out, no reachability is implied or checked. */
export function setRemote(dir: string, url: string): void {
  run(dir, ["remote", "add", "origin", url]);
}

/**
 * A repo with `commitCount` commits, built via `git fast-import` instead of
 * one `git commit` invocation per commit — the latter is far too slow to
 * build a huge-repo fixture at test time (thousands of separate git
 * processes just to set up the test, before the thing actually under test
 * even runs). `git fast-import` accepts the whole history as a single
 * stream on stdin and builds it in well under a second even at 20,000
 * commits. Each commit touches one of 50 rotating files (`src/fileN.ts`),
 * one hour apart starting 2020-01-01 — enough file/date spread to exercise
 * churn, language/category, and cadence-histogram code paths, not just
 * commit count. Every 50th commit (the first touch of each rotating file)
 * introduces a fresh `import Stripe from "stripe"` line, so skill
 * detection has real (if sparse — see docs/scan.md) work to do too.
 */
export function createRepoWithGeneratedHistory(commitCount: number): string {
  const dir = mkdtempSync(join(tmpdir(), "redential-huge-"));
  run(dir, ["init", "-q", "-b", "main"]);
  run(dir, ["config", "core.autocrlf", "false"]);

  const startTs = Math.floor(new Date("2020-01-01T00:00:00Z").getTime() / 1000);
  let stream = "";
  for (let i = 0; i < commitCount; i++) {
    const ts = startTs + i * 3600;
    const path = `src/file${i % 50}.ts`;
    const isFirstTouch = i < 50;
    const content = isFirstTouch
      ? `import Stripe from "stripe";\nexport const value${i} = ${i};\n`
      : `export const value${i} = ${i};\n`;
    const message = `commit ${i}\n`;

    stream += `commit refs/heads/main\n`;
    stream += `mark :${i + 1}\n`;
    stream += `author Perf Tester <perf@example.com> ${ts} +0000\n`;
    stream += `committer Perf Tester <perf@example.com> ${ts} +0000\n`;
    stream += `data ${Buffer.byteLength(message, "utf8")}\n${message}`;
    if (i > 0) stream += `from :${i}\n`;
    stream += `M 100644 inline ${path}\n`;
    stream += `data ${Buffer.byteLength(content, "utf8")}\n${content}`;
  }

  execFileSync("git", ["fast-import", "--quiet"], {
    cwd: dir,
    input: stream,
    // Well beyond the default 1MB — the whole generated stream for 20,000
    // commits is only a few MB, but this is test setup, not the code under
    // test, so there's no reason to make it fragile at the edge.
    maxBuffer: 1024 * 1024 * 1024,
  });
  run(dir, ["checkout", "-q", "main"]);
  return dir;
}

export function cleanup(dir: string): void {
  // maxRetries/retryDelay: on Windows, a just-closed git process or an
  // antivirus scanner can hold a brief file lock after this function is
  // called, turning an otherwise-harmless rmSync into a flaky EPERM/EBUSY.
  // A no-op everywhere else — POSIX unlink doesn't fail this way.
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
