import { describe, expect, it } from "vitest";
import {
  GENERATED_FILE_MIN_ADDED_LINES,
  heuristicallyGeneratedPaths,
  isExcludedPath,
} from "../src/churn-exclusions.js";
import type { RawCommit } from "../src/git.js";

describe("isExcludedPath", () => {
  it("excludes known lockfiles regardless of directory", () => {
    expect(isExcludedPath("package-lock.json")).toBe(true);
    expect(isExcludedPath("frontend/package-lock.json")).toBe(true);
    expect(isExcludedPath("yarn.lock")).toBe(true);
    expect(isExcludedPath("pnpm-lock.yaml")).toBe(true);
    expect(isExcludedPath("bun.lockb")).toBe(true);
  });

  it("excludes minified JS", () => {
    expect(isExcludedPath("public/vendor.min.js")).toBe(true);
  });

  it("excludes anything under a build-output directory", () => {
    expect(isExcludedPath("dist/bundle.js")).toBe(true);
    expect(isExcludedPath("packages/app/dist/index.js")).toBe(true);
    expect(isExcludedPath("build/main.js")).toBe(true);
    expect(isExcludedPath(".next/static/chunk.js")).toBe(true);
    expect(isExcludedPath("node_modules/lodash/index.js")).toBe(true);
  });

  it("does not exclude a directory whose name merely contains dist/build as a substring", () => {
    expect(isExcludedPath("redistribute/foo.ts")).toBe(false);
    expect(isExcludedPath("rebuild-tool/index.ts")).toBe(false);
  });

  it("does not exclude ordinary authored source", () => {
    expect(isExcludedPath("src/index.ts")).toBe(false);
    expect(isExcludedPath("src/main.js")).toBe(false);
  });
});

function fakeCommit(sha: string, churn: RawCommit["churn"]): RawCommit {
  return { sha, email: "a@example.com", authorDate: new Date(), signed: false, churn, isMerge: false };
}

describe("heuristicallyGeneratedPaths", () => {
  it("flags a file touched exactly once with a huge add", () => {
    const commits = [fakeCommit("c1", [{ path: "vendor/bundle.js", added: 5000, deleted: 0 }])];
    expect(heuristicallyGeneratedPaths(commits)).toEqual(new Set(["vendor/bundle.js"]));
  });

  it("does not flag a huge add just under the threshold", () => {
    const commits = [
      fakeCommit("c1", [{ path: "vendor/bundle.js", added: GENERATED_FILE_MIN_ADDED_LINES - 1, deleted: 0 }]),
    ];
    expect(heuristicallyGeneratedPaths(commits)).toEqual(new Set());
  });

  it("does not flag a file touched more than once, even with one huge commit", () => {
    const commits = [
      fakeCommit("c1", [{ path: "src/index.ts", added: 5000, deleted: 0 }]),
      fakeCommit("c2", [{ path: "src/index.ts", added: 10, deleted: 2 }]),
    ];
    expect(heuristicallyGeneratedPaths(commits)).toEqual(new Set());
  });

  it("does not flag ordinary small commits", () => {
    const commits = [fakeCommit("c1", [{ path: "src/index.ts", added: 10, deleted: 0 }])];
    expect(heuristicallyGeneratedPaths(commits)).toEqual(new Set());
  });
});
