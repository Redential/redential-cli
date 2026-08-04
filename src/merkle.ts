import { createHash } from "node:crypto";

// Domain-separation prefixes (RFC 6962 / Certificate Transparency): leaves and
// internal nodes are hashed under different one-byte tags, so an internal node
// can never be presented as a leaf.
const LEAF_PREFIX = Buffer.from("00", "hex"); // 0x00
const NODE_PREFIX = Buffer.from("01", "hex"); // 0x01

function sha256hex(...parts: Array<Buffer | string>): string {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest("hex");
}

/**
 * RFC 6962 Merkle Tree Hash over the user's commit shas.
 *
 * Leaves are `SHA256(0x00 || leaf)` and internal nodes `SHA256(0x01 || left ||
 * right)` over the raw child digests. Two properties this buys over a plain
 * pairwise-sha256 root:
 *
 *  - Domain separation: the leaf/node prefixes make an internal node
 *    unforgeable as a leaf (second-preimage resistance).
 *  - Non-malleable odd levels: the tree splits at the largest power of two, so
 *    a lone node is carried up, never hashed against a duplicate of itself. The
 *    old `right = left` duplication made `[A, B, C]` and `[A, B, C, C]` hash to
 *    the same root; they no longer collide.
 */
export function merkleRoot(leaves: string[]): string {
  if (leaves.length === 0) return sha256hex(""); // empty tree
  return mth(leaves);
}

// Merkle Tree Hash of a non-empty leaf list, returned as hex.
function mth(leaves: string[]): string {
  if (leaves.length === 1) return sha256hex(LEAF_PREFIX, leaves[0]);
  let k = 1;
  while (k * 2 < leaves.length) k *= 2; // largest power of two strictly < n
  const left = Buffer.from(mth(leaves.slice(0, k)), "hex");
  const right = Buffer.from(mth(leaves.slice(k)), "hex");
  return sha256hex(NODE_PREFIX, left, right);
}