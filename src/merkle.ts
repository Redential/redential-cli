import { createHash } from "node:crypto";

function sha256hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Plain pairwise-sha256 Merkle root over the user's commit shas. */
export function merkleRoot(leaves: string[]): string {
  let level = leaves.map(sha256hex);
  if (level.length === 0) return sha256hex("");
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = i + 1 < level.length ? level[i + 1] : left;
      next.push(sha256hex(left + right));
    }
    level = next;
  }
  return level[0];
}
