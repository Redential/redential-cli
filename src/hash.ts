import { createHash } from "node:crypto";

export function saltedHash(salt: string, value: string): string {
  return createHash("sha256").update(salt).update(value).digest("hex");
}
