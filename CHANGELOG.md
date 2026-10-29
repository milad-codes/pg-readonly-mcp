# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning: [SemVer](https://semver.org/).

## [0.1.0] — 2026-10-29

### Added

- Parser-based SQL guard using the PostgreSQL 18 parser (#4)
- Read-only executor with timeouts, cursor row cap, masking; catalog queries; plan summaries (#5)
- MCP server with `list_tables`, `describe_table`, `run_query`, `explain_query` over stdio; container image; docs

[0.1.0]: https://github.com/milad-codes/pg-readonly-mcp/releases/tag/v0.1.0
