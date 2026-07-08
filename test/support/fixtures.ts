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

export function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}
