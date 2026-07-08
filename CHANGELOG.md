# Changelog

All notable changes to this project will be documented in this file.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: strict [semver](https://semver.org/) — bundle schema changes
always bump at least minor; breaking schema changes bump major.

## [Unreleased]

### Added
- Repo scaffolding: principles, schema draft (bundle v1), contributing and
  security policies.
- `detected_skills` field in the bundle v1 draft schema: array of
  `{slug, commit_count, first_seen, last_seen}` (may be empty, always
  present). Skills are detected locally by deterministic signature matching
  (`signatures/*.json`) over diff contents — zero network calls during
  `scan`, no LLMs.
- Initial `taxonomy.json`: the closed public vocabulary of skill slugs. A
  slug outside this list invalidates the bundle. Placeholder set (~38
  slugs), to be expanded.

### Changed
- Principle 3 renamed from "Metadata-only" to "Bounded output": the CLI DOES
  read diff contents locally for skill detection; what leaves the machine is
  bounded to aggregates, salted hashes, and the closed vocabulary of
  `taxonomy.json` (see `docs/principles.md`).
