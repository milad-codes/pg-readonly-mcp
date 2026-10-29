# pg-readonly-mcp

[![CI](https://github.com/milad-codes/pg-readonly-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/milad-codes/pg-readonly-mcp/actions/workflows/ci.yml)
![MCP](https://img.shields.io/badge/MCP-stdio-6E56CF)
![PostgreSQL 16](https://img.shields.io/badge/tested%20on-PostgreSQL%2016-336791)
![License: MIT](https://img.shields.io/badge/license-MIT-blue)

A [Model Context Protocol](https://modelcontextprotocol.io) server that lets AI assistants (Claude, Cursor and other
MCP clients) explore a PostgreSQL database and answer questions with SQL — **read-only, with limits enforced by the
database, not by the model's good behaviour.**

```
You:        Which customers had the most refunded orders last quarter?
Assistant:  list_tables → describe_table(orders) → run_query(SELECT … GROUP BY …) → answer with numbers
```

## Tools

| Tool             | What it returns                                                                                                               |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `list_tables`    | tables/views of the allowed schemas with kind, approximate rows, size, comment                                                |
| `describe_table` | columns (type, nullability, default, comment), primary key, foreign keys, unique and check constraints, indexes               |
| `run_query`      | rows of one `SELECT` (parameters via `$1…`), column types, truncation flag, masked columns, duration                          |
| `explain_query`  | the JSON plan plus a summary: node types, sequential scans with table size and filter, index hints; `analyze` only if enabled |

All tools carry MCP `readOnlyHint` annotations and return structured content validated against output schemas.
Rejections come back as tool errors written for the assistant ("Only SELECT queries are allowed; got DELETE",
"Allowed schemas: public, sales"), so it can correct itself.

## Defence in depth

| Layer                                                      | Stops                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. **PostgreSQL's own parser** (libpg-query, WebAssembly)  | anything but one `SELECT`; data-modifying CTEs; `SELECT INTO`; `FOR UPDATE/SHARE`; `pg_*` functions (except size helpers), `dblink`, `lo_*`, `set_config`, `query_to_xml`-style functions that run SQL from text; system catalogs; schemas outside the allowlist |
| 2. **`BEGIN … READ ONLY` transaction, always rolled back** | any write that slips past layer 1 (tested by sending `DELETE` straight to this layer)                                                                                                                                                                            |
| 3. **`SET LOCAL statement_timeout / lock_timeout`**        | runaway queries and lock waits                                                                                                                                                                                                                                   |
| 4. **`SET LOCAL search_path`** to the allowed schemas      | unqualified names resolving elsewhere                                                                                                                                                                                                                            |
| 5. **Server-side cursor** fetching `max + 1` rows          | huge result sets (without rewriting the SQL)                                                                                                                                                                                                                     |
| 6. **Column masking** by name pattern                      | casual exposure of `password_hash`, tokens… (convenience, not a security boundary)                                                                                                                                                                               |
| 7. **Your database role** (see below)                      | everything else: this is the real boundary                                                                                                                                                                                                                       |

### Recommended database role

```sql
CREATE ROLE mcp_reader LOGIN PASSWORD '…';
ALTER ROLE mcp_reader SET default_transaction_read_only = on;
GRANT CONNECT ON DATABASE app TO mcp_reader;
GRANT USAGE ON SCHEMA public TO mcp_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO mcp_reader;
-- tables with secrets: grant only the safe columns instead of the whole table
REVOKE SELECT ON public.users FROM mcp_reader;
GRANT SELECT (id, email, created_at) ON public.users TO mcp_reader;
```

Do not grant `EXECUTE` on your own functions that write through `dblink` or similar: the parser cannot see inside them.

## Use it

```bash
npm ci && npm run build
```

Claude Desktop (`claude_desktop_config.json`), Cursor (`.cursor/mcp.json`) and other clients that start stdio servers:

```json
{
  "mcpServers": {
    "postgres": {
      "command": "node",
      "args": ["/absolute/path/to/pg-readonly-mcp/dist/cli.js"],
      "env": {
        "DATABASE_URL": "postgresql://mcp_reader:…@localhost:5432/app",
        "PG_MCP_SCHEMAS": "public,sales"
      }
    }
  }
}
```

Or as a container: `"command": "docker", "args": ["run", "-i", "--rm", "-e", "DATABASE_URL", "pg-readonly-mcp"]`
after `docker build -t pg-readonly-mcp .`.

### Configuration

| Variable                       | Default                                                              |                                                |
| ------------------------------ | -------------------------------------------------------------------- | ---------------------------------------------- |
| `DATABASE_URL`                 | —                                                                    | required                                       |
| `PG_MCP_SCHEMAS`               | `public`                                                             | comma-separated schemas the assistant may read |
| `PG_MCP_MAX_ROWS`              | `200`                                                                | hard cap per query                             |
| `PG_MCP_STATEMENT_TIMEOUT_MS`  | `5000`                                                               | per statement                                  |
| `PG_MCP_ALLOW_EXPLAIN_ANALYZE` | `false`                                                              | `EXPLAIN ANALYZE` executes the query           |
| `PG_MCP_REDACT_COLUMNS`        | `password\|passwd\|secret\|token\|api_?key\|ssn\|iban\|credit_?card` | regex for masked result columns                |

Logs go to stderr; stdout is reserved for the protocol.

## Development

```bash
npm test                                         # unit tests; integration tests run when DATABASE_URL is set
DATABASE_URL=postgresql://…/scratch npm test     # ⚠ the integration suite drops and recreates schemas in that database
```

CI runs lint, format check, typecheck and all tests against PostgreSQL 16, then builds the image and talks MCP to it
over stdio (`initialize`, `tools/list`, a query and a rejected `DROP`).

```
src/
  sql/guard.ts          parser-based statement allowlist
  db/transaction.ts     read-only transaction envelope
  db/executor.ts        run_query / explain_query
  db/catalog.ts         list_tables / describe_table
  server.ts, cli.ts     MCP tools and stdio entry point
```

## Limits

- Masking matches result column names; aliases or expressions can avoid it. Use column privileges for real protection.
- One query per call; no multi-statement scripts, no temporary tables.
- Row estimates are planner statistics (`ANALYZE` freshness).

## License

MIT
