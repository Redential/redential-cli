import { describe, expect, it } from "vitest";

import { merkleRoot } from "../src/merkle.js";

describe("merkleRoot", () => {
  it("is deterministic and order-sensitive", () => {
    expect(merkleRoot(["a", "b", "c"])).toBe(merkleRoot(["a", "b", "c"]));
    expect(merkleRoot(["a", "b", "c"])).not.toBe(merkleRoot(["b", "a", "c"]));
  });

  it("does not collide an odd list with its last element duplicated (CVE-2012-2459)", () => {
    // The old odd-node handling duplicated the lone node (`right = left`), so
    // these two distinct commit sets produced the same root. They must differ.
    expect(merkleRoot(["a", "b", "c"])).not.toBe(merkleRoot(["a", "b", "c", "c"]));
    expect(merkleRoot(["a"])).not.toBe(merkleRoot(["a", "a"]));
  });

  it("keeps distinct leaf sets and tree shapes distinct", () => {
    expect(merkleRoot(["x"])).not.toBe(merkleRoot(["x", "y"]));
    expect(merkleRoot(["a", "b", "c", "d"])).not.toBe(merkleRoot(["a", "b", "c"]));
  });

  it("returns a well-formed sha256 hex root for empty and single-leaf trees", () => {
    expect(merkleRoot([])).toMatch(/^[0-9a-f]{64}$/);
    expect(merkleRoot(["only"])).toMatch(/^[0-9a-f]{64}$/);
  });
});
