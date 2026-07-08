import type { CategoryName } from "./types.js";

// Order matters: first matching rule wins.
const RULES: Array<[RegExp, CategoryName]> = [
  [/(^|\/)(__tests__|tests?|specs?)(\/|$)|\.(test|spec)\.[jt]sx?$/i, "testing"],
  [/(^|\/)(claude\.md|agents\.md|\.cursor|\.aider|copilot)/i, "ai-workflow"],
  [
    /(^|\/)(\.github\/workflows|dockerfile|docker-compose|terraform|k8s|kubernetes|infra)(\/|$|\.)/i,
    "infra",
  ],
  [/(^|\/)(auth|authn|authz|session|oauth|login)(\/|$|[._-])/i, "auth"],
  [/(^|\/)(pay|payments?|billing|checkout|stripe)(\/|$|[._-])/i, "payments"],
  [/(^|\/)(migrations?|models?|schema)(\/|$)/i, "data"],
  [/\.(md|mdx)$|(^|\/)docs(\/|$)/i, "docs"],
  [
    /(^|\/)(components?|pages|views|public|styles)(\/|$)|\.(tsx|jsx|css|scss|vue|svelte)$/i,
    "frontend",
  ],
  [/(^|\/)(server|api|controllers?|services)(\/|$)|\.(go|rb|java|rs|py)$/i, "backend"],
];

export function categorize(filePath: string): CategoryName {
  for (const [pattern, name] of RULES) {
    if (pattern.test(filePath)) return name;
  }
  return "other";
}
