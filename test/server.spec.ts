import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { QueryFailedError } from '../src/db/errors.js';
import type { ServerDeps } from '../src/server.js';
import { connect } from './mcp-client.js';
import { QueryRejectedError } from '../src/sql/guard.js';

const text = (result: Awaited<ReturnType<Client['callTool']>>) =>
  (result.content as { type: string; text: string }[]).map((c) => c.text).join('\n');

describe('MCP server (protocol level, fake database)', () => {
  const logged: string[] = [];
  const deps: ServerDeps = {
    maxRows: 100,
    allowedSchemas: ['public'],
    log: (m) => logged.push(m),
    catalog: {
      listTables: async () => [
        {
          schema: 'public',
          name: 'customers',
          kind: 'table',
          estimatedRows: 3,
          totalSize: '16 kB',
          comment: null,
        },
      ],
      describeTable: async (table) => {
        throw new QueryFailedError(`Table "${table}" not found in schemas: public.`, '42P01');
      },
    },
    executor: {
      query: async (sql) => {
        if (sql.startsWith('DELETE'))
          throw new QueryRejectedError('not_select', 'Only SELECT queries are allowed; got DELETE.');
        if (sql.includes('boom')) throw new Error('socket hang up');
        return {
          columns: [{ name: 'n', type: 'integer' }],
          rows: [{ n: 1 }],
          rowCount: 1,
          truncated: false,
          redactedColumns: [],
          durationMs: 3,
        };
      },
      explain: async () => {
        throw new QueryFailedError(
          'EXPLAIN ANALYZE is disabled on this server (PG_MCP_ALLOW_EXPLAIN_ANALYZE).',
          null,
        );
      },
    },
  };

  it('advertises four read-only tools and usage instructions', async () => {
    const client = await connect(deps);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'describe_table',
      'explain_query',
      'list_tables',
      'run_query',
    ]);
    for (const tool of tools)
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(tools.find((t) => t.name === 'run_query')?.inputSchema.required).toEqual(['sql']);
    expect(client.getInstructions()).toMatch(/Start with list_tables/);
  });

  it('returns structured results', async () => {
    const client = await connect(deps);
    const result = await client.callTool({ name: 'run_query', arguments: { sql: 'SELECT 1 AS n' } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ rows: [{ n: 1 }], rowCount: 1 });
  });

  it('turns rejected and failed queries into readable tool errors', async () => {
    const client = await connect(deps);
    const rejected = await client.callTool({
      name: 'run_query',
      arguments: { sql: 'DELETE FROM customers' },
    });
    expect(rejected.isError).toBe(true);
    expect(text(rejected)).toMatch(/Only SELECT queries are allowed/);

    const missing = await client.callTool({ name: 'describe_table', arguments: { table: 'nope' } });
    expect(text(missing)).toMatch(/not found/);

    const explain = await client.callTool({
      name: 'explain_query',
      arguments: { sql: 'SELECT 1', analyze: true },
    });
    expect(text(explain)).toMatch(/disabled/);
  });

  it('hides internal errors from the client but logs them', async () => {
    const client = await connect(deps);
    const result = await client.callTool({ name: 'run_query', arguments: { sql: 'SELECT boom' } });
    expect(text(result)).toBe('Internal error in run_query; see the server log.');
    expect(logged.join()).toMatch(/socket hang up/);
  });

  it('validates arguments against the input schema', async () => {
    const client = await connect(deps);
    const result = await client.callTool({ name: 'run_query', arguments: { sql: 'SELECT 1', limit: 5000 } });
    expect(result.isError).toBe(true);
  });
});

describe('InFlight', () => {
  it('resolves idle() once every started call has ended', async () => {
    const { InFlight } = await import('../src/server.js');
    const inFlight = new InFlight();
    await expect(inFlight.idle()).resolves.toBeUndefined();
    inFlight.start();
    inFlight.start();
    let idle = false;
    const waiting = inFlight.idle().then(() => (idle = true));
    inFlight.end();
    await Promise.resolve();
    expect(idle).toBe(false);
    inFlight.end();
    await waiting;
    expect(idle).toBe(true);
  });
});
