# Security

## Reporting a problem

If you find a way around the SQL checks or the read-only transaction, please report it privately: **Security →
Report a vulnerability** in this repository. Please don't post bypasses in public issues. This is a personal project,
so there is no guaranteed response time, but I read every report.

## What this server protects, and what it doesn't

It narrows what an assistant can run and keeps every query read-only and time-limited. It is **not** a replacement for
database permissions: the role in `DATABASE_URL` is the security boundary. Before connecting a real database:

- create a dedicated role as shown in the README, read-only by default, with `SELECT` only on what the assistant may
  read (column-level grants for tables with secrets);
- prefer a replica or a copy over the primary database;
- keep `PG_MCP_ALLOW_EXPLAIN_ANALYZE` off unless you accept that it executes queries.

## Where data goes

Rows returned by the tools go to the MCP client and, through it, usually to an LLM provider. Treat everything the role
can read as shared with that provider. Column masking only hides values in columns whose names match a pattern; it is a
convenience, not a control.

## Scope

A portfolio project maintained by one person. It has not had an external security review.
