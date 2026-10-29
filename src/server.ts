import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Catalog } from './db/catalog.js';
import { QueryFailedError } from './db/errors.js';
import type { ReadOnlyExecutor } from './db/executor.js';
import { QueryRejectedError } from './sql/guard.js';

export const SERVER_NAME = 'pg-readonly-mcp';
export const SERVER_VERSION = '0.1.0';

export interface ServerDeps {
  executor: Pick<ReadOnlyExecutor, 'query' | 'explain'>;
  catalog: Pick<Catalog, 'listTables' | 'describeTable'>;
  maxRows: number;
  allowedSchemas: readonly string[];
  /** Diagnostics go to stderr: stdout belongs to the MCP protocol on the stdio transport. */
  log?: (message: string) => void;
}

/** Counts requests that have arrived but not been answered; `idle()` resolves once all are answered. */
export class InFlight {
  private running = 0;
  private waiters: (() => void)[] = [];

  start(): void {
    this.running += 1;
  }

  end(): void {
    this.running -= 1;
    if (this.running === 0) this.waiters.splice(0).forEach((resolve) => resolve());
  }

  idle(): Promise<void> {
    return this.running === 0 ? Promise.resolve() : new Promise((resolve) => this.waiters.push(resolve));
  }
}

const param = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const tableSummary = z.object({
  schema: z.string(),
  name: z.string(),
  kind: z.string(),
  estimatedRows: z.number().nullable(),
  totalSize: z.string(),
  comment: z.string().nullable(),
});

const nameDefinition = z.object({ name: z.string(), definition: z.string() });

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export function createServer(deps: ServerDeps): McpServer {
  const log = deps.log ?? ((message: string) => process.stderr.write(`${message}\n`));
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions: [
        `Read-only access to PostgreSQL (schemas: ${deps.allowedSchemas.join(', ')}).`,
        'Start with list_tables, then describe_table for the tables you need, then write one SELECT per run_query call.',
        `Results are capped at ${deps.maxRows} rows; use WHERE, aggregates and LIMIT.`,
        'Use $1, $2 … placeholders with params instead of inlining values. Use explain_query for slow queries.',
      ].join(' '),
    },
  );

  /** Expected failures become tool errors the assistant can read and correct; anything else is logged. */
  const run = async <T extends Record<string, unknown>>(
    tool: string,
    work: () => Promise<T>,
  ): Promise<CallToolResult> => {
    try {
      const result = await work();
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    } catch (error) {
      if (error instanceof QueryRejectedError || error instanceof QueryFailedError) {
        return { isError: true, content: [{ type: 'text', text: error.message }] };
      }
      log(`[${SERVER_NAME}] ${tool} failed: ${(error as Error).stack ?? String(error)}`);
      return {
        isError: true,
        content: [{ type: 'text', text: `Internal error in ${tool}; see the server log.` }],
      };
    }
  };

  server.registerTool(
    'list_tables',
    {
      title: 'List tables',
      description: 'Lists tables and views with their kind, approximate row count, total size and comment.',
      inputSchema: {
        schema: z.string().optional().describe('Only this schema (must be one of the allowed schemas)'),
      },
      outputSchema: { tables: z.array(tableSummary) },
      annotations: READ_ONLY,
    },
    async ({ schema }) => run('list_tables', async () => ({ tables: await deps.catalog.listTables(schema) })),
  );

  server.registerTool(
    'describe_table',
    {
      title: 'Describe table',
      description:
        'Columns (type, nullability, default, comment), primary key, foreign keys, unique and check constraints, and indexes of one table.',
      inputSchema: { table: z.string().min(1).describe('"table" or "schema.table"') },
      outputSchema: {
        ...tableSummary.shape,
        columns: z.array(
          z.object({
            name: z.string(),
            type: z.string(),
            nullable: z.boolean(),
            default: z.string().nullable(),
            comment: z.string().nullable(),
          }),
        ),
        primaryKey: z.array(z.string()),
        foreignKeys: z.array(nameDefinition),
        uniqueConstraints: z.array(nameDefinition),
        checkConstraints: z.array(nameDefinition),
        indexes: z.array(
          z.object({
            name: z.string(),
            definition: z.string(),
            unique: z.boolean(),
            primary: z.boolean(),
            size: z.string(),
          }),
        ),
      },
      annotations: READ_ONLY,
    },
    async ({ table }) =>
      run('describe_table', async () => ({ ...(await deps.catalog.describeTable(table)) })),
  );

  server.registerTool(
    'run_query',
    {
      title: 'Run a read-only query',
      description:
        `Runs one SELECT (WITH, VALUES, UNION allowed) in a read-only transaction with a time limit and returns at most ${deps.maxRows} rows. ` +
        'Writes, DDL, locking clauses, system catalogs and side-effecting functions are refused with an explanation.',
      inputSchema: {
        sql: z.string().min(1).max(20_000).describe('A single SELECT statement; use $1, $2 … for values'),
        params: z.array(param).max(100).optional().describe('Values for $1, $2 …'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(deps.maxRows)
          .optional()
          .describe(`Maximum rows to return (≤ ${deps.maxRows})`),
      },
      outputSchema: {
        columns: z.array(z.object({ name: z.string(), type: z.string() })),
        rows: z.array(z.record(z.string(), z.unknown())),
        rowCount: z.number(),
        truncated: z.boolean(),
        redactedColumns: z.array(z.string()),
        durationMs: z.number(),
      },
      annotations: READ_ONLY,
    },
    async ({ sql, params, limit }) =>
      run('run_query', async () => ({
        ...(await deps.executor.query(sql, params ?? [], limit ?? deps.maxRows)),
      })),
  );

  server.registerTool(
    'explain_query',
    {
      title: 'Explain a query',
      description:
        'Shows the PostgreSQL execution plan of a SELECT with a summary (node types, sequential scans, index suggestions). ' +
        'analyze=true executes the query and is only available if the server enables it.',
      inputSchema: {
        sql: z.string().min(1).max(20_000),
        params: z.array(param).max(100).optional(),
        analyze: z.boolean().optional().describe('Execute the query to get actual timings (if enabled)'),
      },
      outputSchema: {
        summary: z.object({
          totalCost: z.number(),
          estimatedRows: z.number(),
          actualTimeMs: z.number().nullable(),
          nodeTypes: z.record(z.string(), z.number()),
          sequentialScans: z.array(
            z.object({
              relation: z.string(),
              estimatedRows: z.number(),
              tableRows: z.number().nullable(),
              filter: z.string().nullable(),
            }),
          ),
          warnings: z.array(z.string()),
        }),
        plan: z.unknown(),
      },
      annotations: READ_ONLY,
    },
    async ({ sql, params, analyze }) =>
      run('explain_query', async () => ({
        ...(await deps.executor.explain(sql, params ?? [], analyze ?? false)),
      })),
  );

  return server;
}
