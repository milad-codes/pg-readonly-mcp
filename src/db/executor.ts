import pg from 'pg';
import Cursor from 'pg-cursor';
import { assertReadOnlySelect } from '../sql/guard.js';
import { QueryFailedError, translateDatabaseError } from './errors.js';
import { inReadOnlyTransaction } from './transaction.js';
import { toJsonValue } from './values.js';

export interface ExecutorOptions {
  allowedSchemas: readonly string[];
  maxRows: number;
  statementTimeoutMs: number;
  redactColumns: RegExp;
  allowExplainAnalyze: boolean;
}

export type QueryParam = string | number | boolean | null;

export interface QueryResult {
  columns: { name: string; type: string }[];
  rows: Record<string, unknown>[];
  rowCount: number;
  /** True when more rows existed than were returned. */
  truncated: boolean;
  redactedColumns: string[];
  durationMs: number;
}

export interface PlanSummary {
  totalCost: number;
  estimatedRows: number;
  actualTimeMs: number | null;
  nodeTypes: Record<string, number>;
  sequentialScans: {
    relation: string;
    estimatedRows: number;
    tableRows: number | null;
    filter: string | null;
  }[];
  warnings: string[];
}

export interface ExplainResult {
  summary: PlanSummary;
  plan: unknown;
}

/** Above this many estimated rows a sequential scan is worth pointing out. */
const LARGE_SEQ_SCAN_ROWS = 10_000;

interface PlanNode {
  'Node Type': string;
  'Total Cost': number;
  'Plan Rows': number;
  'Relation Name'?: string;
  Schema?: string;
  Filter?: string;
  'Actual Total Time'?: number;
  Plans?: PlanNode[];
}

/**
 * Reduces a JSON plan to what an assistant needs. `tableRows` (planner row estimates per relation) lets it tell
 * a selective filter over a large table, which an index could serve, from a scan that legitimately reads everything.
 */
export function summarizePlan(
  root: PlanNode,
  executionTimeMs: number | null,
  tableRows: ReadonlyMap<string, number> = new Map(),
): PlanSummary {
  const nodeTypes: Record<string, number> = {};
  const sequentialScans: PlanSummary['sequentialScans'] = [];
  const visit = (node: PlanNode) => {
    nodeTypes[node['Node Type']] = (nodeTypes[node['Node Type']] ?? 0) + 1;
    if (node['Node Type'] === 'Seq Scan' && node['Relation Name']) {
      const relation = node.Schema ? `${node.Schema}.${node['Relation Name']}` : node['Relation Name'];
      sequentialScans.push({
        relation,
        estimatedRows: node['Plan Rows'],
        tableRows: tableRows.get(relation) ?? null,
        filter: node.Filter ?? null,
      });
    }
    node.Plans?.forEach(visit);
  };
  visit(root);
  const n = (value: number) => Math.round(value).toLocaleString('en-US');
  const warnings = sequentialScans
    .filter((s) => s.filter !== null && (s.tableRows ?? s.estimatedRows) >= LARGE_SEQ_SCAN_ROWS)
    .map(
      (s) =>
        `Sequential scan on ${s.relation} reads ~${n(s.tableRows ?? s.estimatedRows)} rows to return ~${n(s.estimatedRows)} ` +
        `(filter: ${s.filter}); an index on the filtered columns may help.`,
    );
  return {
    totalCost: root['Total Cost'],
    estimatedRows: root['Plan Rows'],
    actualTimeMs: executionTimeMs,
    nodeTypes,
    sequentialScans,
    warnings,
  };
}

export class ReadOnlyExecutor {
  private readonly typeNames = new Map<number, string>();

  constructor(
    private readonly pool: pg.Pool,
    private readonly options: ExecutorOptions,
  ) {}

  /** Validates, then runs a SELECT and returns at most `limit` (≤ maxRows) rows. */
  async query(sql: string, params: QueryParam[] = [], limit = this.options.maxRows): Promise<QueryResult> {
    await assertReadOnlySelect(sql, { allowedSchemas: this.options.allowedSchemas });
    const max = Math.max(1, Math.min(limit, this.options.maxRows));
    const started = performance.now();
    try {
      return await inReadOnlyTransaction(this.pool, this.options, async (client) => {
        const cursor = client.query(new Cursor(sql, params));
        const { rows, fields } = await new Promise<{
          rows: Record<string, unknown>[];
          fields: pg.FieldDef[];
        }>((resolve, reject) =>
          cursor.read(max + 1, (error, readRows, result) =>
            error
              ? reject(error)
              : resolve({ rows: readRows as Record<string, unknown>[], fields: result.fields }),
          ),
        );
        await cursor.close();
        const types = await this.resolveTypes(
          client,
          fields.map((f) => f.dataTypeID),
        );
        const redacted = fields.map((f) => f.name).filter((name) => this.options.redactColumns.test(name));
        const truncated = rows.length > max;
        return {
          columns: fields.map((f) => ({
            name: f.name,
            type: types.get(f.dataTypeID) ?? String(f.dataTypeID),
          })),
          rows: rows
            .slice(0, max)
            .map((row) =>
              Object.fromEntries(
                Object.entries(row).map(([key, value]) => [
                  key,
                  redacted.includes(key) && value !== null ? '[redacted]' : toJsonValue(value),
                ]),
              ),
            ),
          rowCount: Math.min(rows.length, max),
          truncated,
          redactedColumns: redacted,
          durationMs: Math.round(performance.now() - started),
        };
      });
    } catch (error) {
      if (error instanceof QueryFailedError) throw error;
      throw translateDatabaseError(error, this.options.statementTimeoutMs);
    }
  }

  /** EXPLAIN (FORMAT JSON) of a validated SELECT. ANALYZE executes the query, so it is opt-in. */
  async explain(sql: string, params: QueryParam[] = [], analyze = false): Promise<ExplainResult> {
    if (analyze && !this.options.allowExplainAnalyze) {
      throw new QueryFailedError(
        'EXPLAIN ANALYZE is disabled on this server (PG_MCP_ALLOW_EXPLAIN_ANALYZE).',
        null,
      );
    }
    await assertReadOnlySelect(sql, { allowedSchemas: this.options.allowedSchemas });
    try {
      return await inReadOnlyTransaction(this.pool, this.options, async (client) => {
        const options = analyze ? 'FORMAT JSON, VERBOSE, ANALYZE, BUFFERS' : 'FORMAT JSON, VERBOSE';
        const result = await client.query<{ 'QUERY PLAN': { Plan: PlanNode; 'Execution Time'?: number }[] }>(
          `EXPLAIN (${options}) ${sql}`,
          params,
        );
        const document = result.rows[0]!['QUERY PLAN'][0]!;
        const scanned = summarizePlan(document.Plan, null).sequentialScans.map((s) => s.relation);
        const sizes = await client.query<{ relation: string; rows: number }>(
          `SELECT n.nspname || '.' || c.relname AS relation, c.reltuples::float8 AS rows
             FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname || '.' || c.relname = ANY($1::text[])`,
          [scanned],
        );
        const tableRows = new Map(sizes.rows.filter((r) => r.rows >= 0).map((r) => [r.relation, r.rows]));
        return {
          summary: summarizePlan(document.Plan, document['Execution Time'] ?? null, tableRows),
          plan: document.Plan,
        };
      });
    } catch (error) {
      throw translateDatabaseError(error, this.options.statementTimeoutMs);
    }
  }

  private async resolveTypes(client: pg.PoolClient, oids: number[]): Promise<Map<number, string>> {
    const missing = [...new Set(oids)].filter((oid) => !this.typeNames.has(oid));
    if (missing.length) {
      const { rows } = await client.query<{ oid: number; name: string }>(
        'SELECT oid::int AS oid, format_type(oid, NULL) AS name FROM pg_catalog.pg_type WHERE oid = ANY($1::oid[])',
        [missing],
      );
      for (const row of rows) this.typeNames.set(row.oid, row.name);
    }
    return this.typeNames;
  }
}
