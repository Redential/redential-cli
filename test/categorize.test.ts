import { describe, expect, it } from "vitest";

import { categorize } from "../src/categorize.js";

describe("categorize", () => {
  it("classifies JS/TS test files as testing", () => {
    expect(categorize("src/Button.test.tsx")).toBe("testing");
    expect(categorize("__tests__/foo.ts")).toBe("testing");
  });

  it("classifies Go, Python and Ruby test files as testing", () => {
    expect(categorize("pkg/foo_test.go")).toBe("testing");
    expect(categorize("app/test_user.py")).toBe("testing");
    expect(categorize("lib/user_spec.rb")).toBe("testing");
  });

  it("does not misclassify non-test source files", () => {
    expect(categorize("src/api/users.go")).toBe("backend");
    expect(categorize("src/latest.go")).toBe("backend");
    expect(categorize("src/contest.py")).toBe("backend");
  });
});
