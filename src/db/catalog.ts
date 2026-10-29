import type pg from 'pg';
import { QueryFailedError } from './errors.js';
import { inReadOnlyTransaction, type TransactionLimits } from './transaction.js';

export interface TableSummary {
  schema: string;
  name: string;
  kind: 'table' | 'view' | 'materialized view' | 'partitioned table' | 'foreign table';
  /** Planner estimate (pg_class.reltuples); null if the table was never analyzed. */
  estimatedRows: number | null;
  totalSize: string;
  comment: string | null;
}

export interface TableDescription extends TableSummary {
  columns: {
    name: string;
    type: string;
    nullable: boolean;
    default: string | null;
    comment: string | null;
  }[];
  primaryKey: string[];
  foreignKeys: { name: string; definition: string }[];
  uniqueConstraints: { name: string; definition: string }[];
  checkConstraints: { name: string; definition: string }[];
  indexes: { name: string; definition: string; unique: boolean; primary: boolean; size: string }[];
}

const KINDS: Record<string, TableSummary['kind']> = {
  r: 'table',
  v: 'view',
  m: 'materialized view',
  p: 'partitioned table',
  f: 'foreign table',
};

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/;

/** Schema metadata from pg_catalog. These queries are fixed, so they run without the SQL guard but still read-only. */
export class Catalog {
  constructor(
    private readonly pool: pg.Pool,
    private readonly limits: TransactionLimits,
  ) {}

  async listTables(schema?: string): Promise<TableSummary[]> {
    const schemas = schema ? [this.allowedSchema(schema)] : [...this.limits.allowedSchemas];
    return inReadOnlyTransaction(this.pool, this.limits, async (client) => {
      const { rows } = await client.query<{
        schema: string;
        name: string;
        relkind: string;
        reltuples: number;
        total_size: string;
        comment: string | null;
      }>(
        `SELECT n.nspname AS schema, c.relname AS name, c.relkind::text AS relkind, c.reltuples::float8 AS reltuples,
                pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size, obj_description(c.oid, 'pg_class') AS comment
           FROM pg_catalog.pg_class c
           JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = ANY($1::text[]) AND c.relkind IN ('r', 'v', 'm', 'p', 'f') AND NOT c.relispartition
          ORDER BY n.nspname, c.relname`,
        [schemas],
      );
      return rows.map((r) => ({
        schema: r.schema,
        name: r.name,
        kind: KINDS[r.relkind] ?? 'table',
        estimatedRows: r.reltuples < 0 ? null : Math.round(r.reltuples),
        totalSize: r.total_size,
        comment: r.comment,
      }));
    });
  }

  /** `table` may be "name" (searched in the allowed schemas, in order) or "schema.name". */
  async describeTable(table: string): Promise<TableDescription> {
    const [first, second, ...rest] = table.split('.');
    if (rest.length || !first || (second !== undefined && !second)) {
      throw new QueryFailedError(`"${table}" is not a valid table name; use "name" or "schema.name".`, null);
    }
    const name = second ?? first;
    const schemas = second ? [this.allowedSchema(first)] : [...this.limits.allowedSchemas];
    if (!IDENTIFIER.test(name)) throw new QueryFailedError(`"${name}" is not a valid table name.`, null);

    return inReadOnlyTransaction(this.pool, this.limits, async (client) => {
      const found = await client.query<{
        oid: number;
        schema: string;
        relkind: string;
        reltuples: number;
        total_size: string;
        comment: string | null;
      }>(
        `SELECT c.oid::int AS oid, n.nspname AS schema, c.relkind::text AS relkind, c.reltuples::float8 AS reltuples,
                pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size, obj_description(c.oid, 'pg_class') AS comment
           FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relname = $1 AND n.nspname = ANY($2::text[]) AND c.relkind IN ('r', 'v', 'm', 'p', 'f')
          ORDER BY array_position($2::text[], n.nspname::text) LIMIT 1`,
        [name, schemas],
      );
      const rel = found.rows[0];
      if (!rel)
        throw new QueryFailedError(`Table "${table}" not found in schemas: ${schemas.join(', ')}.`, '42P01');

      // One client runs one query at a time: node-postgres deprecates queueing on a busy client (removed in pg 9).
      const columns = await client.query<{
        name: string;
        type: string;
        nullable: boolean;
        default: string | null;
        comment: string | null;
      }>(
        `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable,
                  pg_get_expr(d.adbin, d.adrelid) AS default, col_description(a.attrelid, a.attnum) AS comment
             FROM pg_catalog.pg_attribute a
             LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
            WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped
            ORDER BY a.attnum`,
        [rel.oid],
      );
      const constraints = await client.query<{
        name: string;
        type: string;
        definition: string;
        columns: string[];
      }>(
        `SELECT con.conname AS name, con.contype::text AS type, pg_get_constraintdef(con.oid) AS definition,
                  ARRAY(SELECT a.attname FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord)
                         JOIN pg_catalog.pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
                         ORDER BY k.ord)::text[] AS columns
             FROM pg_catalog.pg_constraint con
            WHERE con.conrelid = $1
            ORDER BY con.conname`,
        [rel.oid],
      );
      const indexes = await client.query<{
        name: string;
        definition: string;
        unique: boolean;
        primary: boolean;
        size: string;
      }>(
        `SELECT ic.relname AS name, pg_get_indexdef(i.indexrelid) AS definition, i.indisunique AS unique,
                  i.indisprimary AS primary, pg_size_pretty(pg_relation_size(i.indexrelid)) AS size
             FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
            WHERE i.indrelid = $1
            ORDER BY ic.relname`,
        [rel.oid],
      );
      const byType = (type: string) =>
        constraints.rows
          .filter((c) => c.type === type)
          .map((c) => ({ name: c.name, definition: c.definition }));
      return {
        schema: rel.schema,
        name,
        kind: KINDS[rel.relkind] ?? 'table',
        estimatedRows: rel.reltuples < 0 ? null : Math.round(rel.reltuples),
        totalSize: rel.total_size,
        comment: rel.comment,
        columns: columns.rows,
        primaryKey: constraints.rows.find((c) => c.type === 'p')?.columns ?? [],
        foreignKeys: byType('f'),
        uniqueConstraints: byType('u'),
        checkConstraints: byType('c'),
        indexes: indexes.rows,
      };
    });
  }

  private allowedSchema(schema: string): string {
    if (!this.limits.allowedSchemas.includes(schema)) {
      throw new QueryFailedError(
        `Schema "${schema}" is not readable here. Allowed schemas: ${this.limits.allowedSchemas.join(', ')}.`,
        null,
      );
    }
    return schema;
  }
}
