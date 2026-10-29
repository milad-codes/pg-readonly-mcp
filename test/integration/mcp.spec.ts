import type pg from 'pg';
import { Catalog } from '../../src/db/catalog.js';
import { ReadOnlyExecutor } from '../../src/db/executor.js';
import { connect } from '../mcp-client.js';
import { ALLOWED, hasDatabase, seed } from './setup.js';

describe.skipIf(!hasDatabase)('MCP server end to end (PostgreSQL)', () => {
  let pool: pg.Pool;
  let client: Awaited<ReturnType<typeof connect>>;

  beforeAll(async () => {
    pool = await seed();
    const limits = { allowedSchemas: ALLOWED, statementTimeoutMs: 2_000 };
    client = await connect({
      executor: new ReadOnlyExecutor(pool, {
        ...limits,
        maxRows: 20,
        redactColumns: /password/i,
        allowExplainAnalyze: false,
      }),
      catalog: new Catalog(pool, limits),
      maxRows: 20,
      allowedSchemas: ALLOWED,
    });
  });
  afterAll(async () => {
    await pool.end();
  });

  it('lets an assistant discover the schema and answer a question', async () => {
    const tables = await client.callTool({ name: 'list_tables', arguments: {} });
    expect((tables.structuredContent as { tables: { name: string }[] }).tables.map((t) => t.name)).toContain(
      'orders',
    );

    const orders = await client.callTool({ name: 'describe_table', arguments: { table: 'orders' } });
    expect(orders.structuredContent).toMatchObject({ schema: 'sales', primaryKey: ['id'] });

    const answer = await client.callTool({
      name: 'run_query',
      arguments: {
        sql: `SELECT c.name, count(*)::int AS orders, sum(o.total)::text AS revenue
                FROM sales.orders o JOIN customers c ON c.id = o.customer_id
               WHERE o.status = $1 GROUP BY c.name ORDER BY c.name`,
        params: ['paid'],
      },
    });
    expect(answer.isError).toBeFalsy();
    expect((answer.structuredContent as { rows: unknown[] }).rows).toHaveLength(3);
  });

  it('caps rows and masks secrets over the protocol', async () => {
    const many = await client.callTool({
      name: 'run_query',
      arguments: { sql: 'SELECT id FROM sales.orders' },
    });
    expect(many.structuredContent).toMatchObject({ rowCount: 20, truncated: true });
    const users = await client.callTool({ name: 'run_query', arguments: { sql: 'SELECT * FROM users' } });
    expect(JSON.stringify(users)).not.toContain('$argon2id$secret');
  });

  it('never leaks the forbidden schema', async () => {
    for (const sql of [
      'SELECT * FROM secret.api_keys',
      "SELECT table_to_xml('secret.api_keys', true, false, '')",
    ]) {
      const result = await client.callTool({ name: 'run_query', arguments: { sql } });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain('sk-live');
    }
  });

  it('explains a query with an index suggestion', async () => {
    const result = await client.callTool({
      name: 'explain_query',
      arguments: { sql: "SELECT * FROM sales.orders WHERE status = 'refunded'" },
    });
    expect((result.structuredContent as { summary: { warnings: string[] } }).summary.warnings[0]).toMatch(
      /index/,
    );
  });
});
