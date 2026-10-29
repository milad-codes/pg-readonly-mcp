#!/usr/bin/env node
// Speaks MCP over stdio to this server, the way Claude Desktop or Cursor would, against the synthetic shop database.
//   docker compose -f examples/docker-compose.yml up -d   # PostgreSQL 16 on :5433 with examples/shop.sql
//   npm run demo                                          # builds, then runs this script
// DATABASE_URL defaults to the read-only demo role created by examples/shop.sql.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['dist/cli.js'],
  env: {
    ...process.env,
    DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://mcp_reader:mcp_reader@localhost:5433/shop',
    PG_MCP_SCHEMAS: 'public,sales',
    PG_MCP_STATEMENT_TIMEOUT_MS: '1000',
    LOG_LEVEL: 'error',
  },
  stderr: 'inherit',
});
const client = new Client({ name: 'pg-readonly-mcp-demo', version: '1.0.0' });
await client.connect(transport);

let failures = 0;
async function call(title, name, args, { expectError = false, show = (r) => r } = {}) {
  const result = await client.callTool({ name, arguments: args });
  const ok = Boolean(result.isError) === expectError;
  if (!ok) failures += 1;
  console.log(`\n${ok ? '✓' : '✗'} ${title}`);
  const text = result.content?.find((c) => c.type === 'text')?.text ?? '';
  if (result.isError) console.log(`  → ${text}`);
  else console.log(show(result.structuredContent ?? text));
}
const rows = (r) => r.rows.map((row) => `  ${JSON.stringify(row)}`).join('\n');

const { tools } = await client.listTools();
console.log(`tools: ${tools.map((t) => t.name).join(', ')}`);

await call(
  'list_tables',
  'list_tables',
  {},
  {
    show: (r) =>
      r.tables.map((t) => `  ${t.schema}.${t.name} (~${t.estimatedRows ?? t.rows ?? '?'} rows)`).join('\n'),
  },
);
await call(
  'describe_table sales.orders',
  'describe_table',
  { table: 'sales.orders' },
  {
    show: (r) =>
      `  columns: ${r.columns.map((c) => c.name).join(', ')}\n  foreign keys: ${JSON.stringify(r.foreignKeys)}`,
  },
);
await call(
  'customers with the most refunded orders',
  'run_query',
  {
    sql: `SELECT c.name, count(*) AS refunded
            FROM sales.orders o JOIN customers c ON c.id = o.customer_id
           WHERE o.status = $1 GROUP BY c.name ORDER BY refunded DESC, c.name LIMIT 3`,
    params: ['refunded'],
  },
  { show: rows },
);
await call(
  'password hashes are masked by column name',
  'run_query',
  { sql: 'SELECT id, email, password_hash FROM users LIMIT 2' },
  {
    show: (r) => `${rows(r)}\n  masked: ${r.redactedColumns.join(', ')}`,
  },
);
await call(
  'query plan with an index hint',
  'explain_query',
  { sql: 'SELECT * FROM sales.orders WHERE total > 480' },
  {
    show: (r) => r.summary.warnings.map((w) => `  ${w}`).join('\n') || '  no warnings',
  },
);
await call(
  'a write is refused before it reaches the database',
  'run_query',
  { sql: 'DELETE FROM sales.orders' },
  { expectError: true },
);
await call(
  'a schema outside PG_MCP_SCHEMAS is refused',
  'run_query',
  { sql: 'SELECT * FROM secret.api_keys' },
  { expectError: true },
);
await call(
  'SQL hidden in a string argument is refused',
  'run_query',
  { sql: "SELECT word FROM ts_stat('SELECT to_tsvector(key) FROM secret.api_keys')" },
  { expectError: true },
);
await call(
  'a slow query is cancelled by the statement timeout (1 s here)',
  'run_query',
  {
    sql: 'SELECT count(*) FROM generate_series(1, 1e9)',
  },
  { expectError: true },
);

await client.close();
if (failures) {
  console.error(`\n${failures} step(s) did not behave as expected`);
  process.exit(1);
}
