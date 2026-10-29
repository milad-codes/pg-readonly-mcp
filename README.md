# pg-readonly-mcp

[![CI](https://github.com/milad-codes/pg-readonly-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/milad-codes/pg-readonly-mcp/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/milad-codes/pg-readonly-mcp)](https://github.com/milad-codes/pg-readonly-mcp/releases)
[![License: MIT](https://img.shields.io/github/license/milad-codes/pg-readonly-mcp)](LICENSE)

A [Model Context Protocol](https://modelcontextprotocol.io) server that lets an AI assistant explore a PostgreSQL database and answer questions with SQL. It is read-only, and it keeps the assistant inside the schemas you choose.

```text
You:        Which customers had the most refunded orders last quarter?
Assistant:  list_tables → describe_table(sales.orders) → run_query(SELECT … GROUP BY …) → answer with numbers
```

## The problem

Handing an assistant a connection string is risky in both directions. It might run a `DELETE` or a query that scans a large table for minutes. It might also wander into tables it shouldn't see. Prompt instructions ("only run SELECT") don't enforce anything.

This server puts checks in front of the database that don't depend on the model behaving:

- PostgreSQL's own parser decides whether a query is a single, plain `SELECT`.
- Execution happens in a read-only transaction with time and row limits.
- A database role you control has the final say.

**In scope:** schema discovery, read-only queries with parameters, query plans with simple index hints. All of it runs over stdio for local MCP clients.
**Out of scope:** writes of any kind, other databases, HTTP transport, multiple users with different permissions.

## Tools

| Tool             | Returns                                                                                                                      |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `list_tables`    | tables and views in the allowed schemas, with kind, estimated rows, size and comment                                         |
| `describe_table` | columns, primary key, foreign keys, unique and check constraints, indexes                                                    |
| `run_query`      | rows of one `SELECT` (`$1 …` parameters), column types, a truncation flag, masked columns, duration                          |
| `explain_query`  | the JSON plan and a summary: node types, sequential scans with table size and filter, index hints; `analyze` only if enabled |

The tools carry MCP `readOnlyHint` annotations and return structured content that is checked against output schemas. When a query is refused, the assistant gets an explanation it can act on, for example "Only SELECT queries are allowed; got DELETE" or "Allowed schemas: public, sales".

## Layers and their trade-offs

| Layer                                               | Stops                                                                                                                                                                                                                                                                                                                             | Trade-off                                                                                                               |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 1. PostgreSQL's parser (`libpg-query`, WebAssembly) | anything but one `SELECT`; data-modifying CTEs; `SELECT INTO`; `FOR UPDATE`/`FOR SHARE`; schemas outside the allowlist; side-effecting functions (`pg_*` except size helpers, `dblink`, `lo_*`, `set_config`) and functions that run SQL passed as text (`query_to_xml` family, `ts_stat`, `ts_rewrite`, `crosstab`, `connectby`) | Functions are **denied by name**, and a deny list can't be complete. It doesn't see inside your own functions or views. |
| 2. `BEGIN … READ ONLY`, always rolled back          | any write that slips past layer 1 (tested by sending `DELETE` straight to this layer)                                                                                                                                                                                                                                             | none worth noting                                                                                                       |
| 3. `SET LOCAL statement_timeout` and `lock_timeout` | runaway queries and lock waits                                                                                                                                                                                                                                                                                                    | long legitimate queries need a higher limit                                                                             |
| 4. `SET LOCAL search_path` to the allowed schemas   | unqualified names resolving to other schemas                                                                                                                                                                                                                                                                                      | none worth noting                                                                                                       |
| 5. Server-side cursor fetching `max + 1` rows       | huge result sets, without rewriting the SQL                                                                                                                                                                                                                                                                                       | sorting large sets still costs time on the server                                                                       |
| 6. Column masking by name pattern                   | casual exposure of `password_hash`, tokens and similar                                                                                                                                                                                                                                                                            | **not a security control**: an alias like `SELECT password_hash AS x` avoids it                                         |
| 7. **Your database role**                           | everything else                                                                                                                                                                                                                                                                                                                   | none: this is the real boundary, so set it up as below                                                                  |

### Recommended database role

```sql
CREATE ROLE mcp_reader LOGIN PASSWORD '…';
ALTER ROLE mcp_reader SET default_transaction_read_only = on;
GRANT CONNECT ON DATABASE app TO mcp_reader;
GRANT USAGE ON SCHEMA public TO mcp_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO mcp_reader;
-- tables with secrets: grant only the safe columns
REVOKE SELECT ON public.users FROM mcp_reader;
GRANT SELECT (id, email, created_at) ON public.users TO mcp_reader;
```

Don't grant `EXECUTE` on functions that write through `dblink` or similar: the parser can't see inside them.

## Try it with the demo database

You need Node 22.12 or newer and Docker for the demo database.

```bash
npm ci
docker compose -f examples/docker-compose.yml up -d   # PostgreSQL 16 on :5433 with synthetic data
npm run demo                                          # builds, then talks MCP over stdio as a client would
```

[`examples/shop.sql`](examples/shop.sql) creates 200 invented customers and 20,000 generated orders, plus a `secret` schema. It also creates the `mcp_reader` role from above, and the demo connects as that role. The demo:

- lists the tables and describes `sales.orders`
- answers a question with a parameterised query
- shows masked password hashes and an index hint from the plan
- is refused a `DELETE`, the `secret` schema, SQL hidden in a function argument, and a query that runs past the 1-second limit

CI runs the same demo against PostgreSQL 16 on every change.

## Use it with an MCP client

```bash
npm ci && npm run build
```

Claude Desktop (`claude_desktop_config.json`), Cursor (`.cursor/mcp.json`) and other clients that start stdio servers take:

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

You can also run it as a container. Build it with `docker build -t pg-readonly-mcp .`, then use `"command": "docker", "args": ["run", "-i", "--rm", "-e", "DATABASE_URL", "pg-readonly-mcp"]`.

### Configuration

| Variable                       | Default                                                              |                                                |
| ------------------------------ | -------------------------------------------------------------------- | ---------------------------------------------- |
| `DATABASE_URL`                 | —                                                                    | required                                       |
| `PG_MCP_SCHEMAS`               | `public`                                                             | comma-separated schemas the assistant may read |
| `PG_MCP_MAX_ROWS`              | `200`                                                                | hard cap per query                             |
| `PG_MCP_STATEMENT_TIMEOUT_MS`  | `5000`                                                               | per statement                                  |
| `PG_MCP_ALLOW_EXPLAIN_ANALYZE` | `false`                                                              | `EXPLAIN ANALYZE` executes the query           |
| `PG_MCP_REDACT_COLUMNS`        | `password\|passwd\|secret\|token\|api_?key\|ssn\|iban\|credit_?card` | regular expression for masked result columns   |

Logs go to stderr, because stdout carries the protocol.

## Development

```bash
npm test                                         # unit tests; integration tests run when DATABASE_URL is set
DATABASE_URL=postgresql://…/scratch npm test     # ⚠ drops and recreates schemas in that database
```

- The guard has allow and deny cases for each rule.
- Integration tests run real queries, timeouts and plans against PostgreSQL. They include an attack through `ts_stat` and a `DELETE` sent past the parser.
- MCP tests use the SDK client over an in-memory transport.

CI runs lint, the format check, typecheck, all tests against PostgreSQL 16 and the demo. It also builds the image and talks MCP to it over stdio (`initialize`, `tools/list`, a query and a refused `DROP`).

```text
src/
  sql/guard.ts          parser-based statement checks
  db/transaction.ts     read-only transaction envelope
  db/executor.ts        run_query / explain_query
  db/catalog.ts         list_tables / describe_table
  server.ts, cli.ts     MCP tools and stdio entry point
examples/               synthetic demo database
scripts/demo.mjs        MCP client walkthrough
```

## Troubleshooting

| Symptom                                           | Cause and fix                                                                                                                                       |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| The client shows no tools                         | The server didn't start. Run the configured command in a terminal and read stderr: usually `DATABASE_URL` is missing or the build step was skipped. |
| `Invalid configuration: DATABASE_URL …`           | Set a `postgres://` or `postgresql://` URL in the client's `env` block.                                                                             |
| `password authentication failed` / `ECONNREFUSED` | Wrong credentials, or the database isn't reachable from where the client starts the server.                                                         |
| `permission denied for table …`                   | The role lacks `SELECT` on that table. That is the role working as intended; grant it if the assistant should see it.                               |
| `Schema "x" is not readable here`                 | Add the schema to `PG_MCP_SCHEMAS`, and grant the role `USAGE` on it.                                                                               |
| `The query exceeded the … ms time limit`          | Add filters or a `LIMIT`, check the plan with `explain_query`, or raise `PG_MCP_STATEMENT_TIMEOUT_MS`.                                              |
| The demo can't connect                            | Start the demo database first: `docker compose -f examples/docker-compose.yml up -d`. It listens on port 5433.                                      |

## Limitations

- The function deny list stops the cases that are known and tested. Your own functions, views and future PostgreSQL functions are outside its view. Rely on the role.
- Masking matches result column names only. Use column privileges for real protection.
- One query per call: no scripts and no temporary tables.
- Row estimates and index hints come from planner statistics, so they are only as fresh as the last `ANALYZE`.
- The server has no authentication of its own. Anyone who can start it with a connection string has that role's access.

Changes are listed in [CHANGELOG.md](CHANGELOG.md), and releases are on the [releases page](https://github.com/milad-codes/pg-readonly-mcp/releases).

## Security and licence

See [SECURITY.md](SECURITY.md) for private reporting and deployment advice. Released under the [MIT licence](LICENSE).
