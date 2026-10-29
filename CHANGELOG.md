# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning: [SemVer](https://semver.org/).

## [Unreleased]

### Added

- `npm run demo` with a synthetic shop database (`examples/`): an MCP client walkthrough that CI also runs

### Changed

- README rewritten around the problem, scope, layers and their trade-offs, setup, troubleshooting and limitations;
  SECURITY.md states that the database role, not this server, is the security boundary; package description no longer
  claims "safe" access

### Fixed

- `describe_table` sent three queries to one client at once; node-postgres 8.23 warns about this and version 9 removes
  it. The catalog queries now run one after another

### Security

- Functions that run SQL passed as text (`ts_stat`, `ts_rewrite`, `crosstab`, `connectby`) could read schemas outside
  `PG_MCP_SCHEMAS`; the guard now rejects them like the `query_to_xml` family (#7)

## [0.1.0] — 2026-10-29

### Added

- Parser-based SQL guard using the PostgreSQL 18 parser (#4)
- Read-only executor with timeouts, cursor row cap, masking; catalog queries; plan summaries (#5)
- MCP server with `list_tables`, `describe_table`, `run_query`, `explain_query` over stdio; container image; docs

[0.1.0]: https://github.com/milad-codes/pg-readonly-mcp/releases/tag/v0.1.0
