import type { CategoryName } from "./types.js";

// filePath here is always a git-reported path (from `git log --numstat` /
// `git show`), which git always emits "/"-separated regardless of the host
// OS — never a filesystem path built with node:path, and never backslashes
// even on Windows. Hardcoding "/" below is therefore correct on every
// platform, not a Windows bug.
//
// Order matters: first matching rule wins.
const RULES: Array<[RegExp, CategoryName]> = [
  // Recognise test files across languages: a `test/` or `spec/` directory, the
  // JS/TS `.test.`/`.spec.` infix, the `_test.`/`_spec.` suffix used by Go
  // (`foo_test.go`), Ruby (`foo_spec.rb`) and others, and the Python `test_`
  // prefix (`test_foo.py`). Previously only the JS/TS forms were matched, so
  // `foo_test.go` and `test_foo.py` fell through to "backend".
  [
    /(^|\/)(__tests__|tests?|specs?)(\/|$)|[._](test|spec)\.[a-z0-9]+$|(^|\/)test_[^/]+\.[a-z0-9]+$/i,
    "testing",
  ],
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
