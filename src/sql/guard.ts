import { parse } from 'libpg-query';

export type RejectionReason =
  | 'syntax'
  | 'multiple_statements'
  | 'not_select'
  | 'data_modifying_cte'
  | 'select_into'
  | 'row_locking'
  | 'forbidden_function'
  | 'forbidden_relation';

/** A query the server refuses to run. The message is written for the assistant: what is wrong and what to do instead. */
export class QueryRejectedError extends Error {
  override readonly name = 'QueryRejectedError';
  constructor(
    readonly reason: RejectionReason,
    message: string,
  ) {
    super(message);
  }
}

export interface GuardOptions {
  /** Schemas a query may reference explicitly. */
  allowedSchemas: readonly string[];
}

export interface GuardResult {
  /** Relations referenced by the query, as written (schema-qualified when the query qualified them). */
  relations: string[];
  functions: string[];
}

/** Size and type helpers that only read metadata. Every other pg_* function is refused. */
const SAFE_PG_FUNCTIONS = new Set([
  'pg_size_pretty',
  'pg_relation_size',
  'pg_total_relation_size',
  'pg_table_size',
  'pg_indexes_size',
  'pg_column_size',
  'pg_typeof',
]);

/** Functions that act outside the transaction, read server files, change settings or run SQL passed as text. */
const DENIED_FUNCTIONS = new Set([
  'set_config',
  'nextval',
  'setval',
  'query_to_xml',
  'query_to_xmlschema',
  'query_to_xml_and_xmlschema',
  'cursor_to_xml',
  'cursor_to_xmlschema',
  'table_to_xml',
  'table_to_xmlschema',
  'table_to_xml_and_xmlschema',
  'schema_to_xml',
  'schema_to_xmlschema',
  'schema_to_xml_and_xmlschema',
  'database_to_xml',
  'database_to_xmlschema',
  'database_to_xml_and_xmlschema',
]);
const DENIED_PREFIXES = ['dblink', 'lo_'];

const MODIFYING_STATEMENTS = new Set(['InsertStmt', 'UpdateStmt', 'DeleteStmt', 'MergeStmt']);

const STATEMENT_NAMES: Record<string, string> = {
  InsertStmt: 'INSERT',
  UpdateStmt: 'UPDATE',
  DeleteStmt: 'DELETE',
  MergeStmt: 'MERGE',
  ExplainStmt: 'EXPLAIN',
  CopyStmt: 'COPY',
  DoStmt: 'DO',
  CallStmt: 'CALL',
  VariableSetStmt: 'SET',
  VariableShowStmt: 'SHOW',
  TransactionStmt: 'transaction control',
  CreateStmt: 'CREATE TABLE',
  DropStmt: 'DROP',
  TruncateStmt: 'TRUNCATE',
  AlterTableStmt: 'ALTER TABLE',
  GrantStmt: 'GRANT',
};

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Visits every parse-tree node: libpg-query encodes nodes as `{ NodeType: { ...fields } }`. */
function* nodes(value: Json): Generator<[string, { [key: string]: Json }]> {
  if (Array.isArray(value)) {
    for (const item of value) yield* nodes(item);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (/^[A-Z]/.test(key) && child !== null && typeof child === 'object' && !Array.isArray(child)) {
      yield [key, child];
    }
    yield* nodes(child);
  }
}

const strings = (list: Json | undefined): string[] =>
  Array.isArray(list)
    ? list.flatMap((item) => {
        const str = (item as { String?: { sval?: string } } | null)?.String?.sval;
        return typeof str === 'string' ? [str] : [];
      })
    : [];

/**
 * Throws QueryRejectedError unless `sql` is exactly one plain SELECT that cannot modify data, lock rows,
 * call side-effecting functions or reach relations outside the allowed schemas.
 * This is the first line of defence; execution additionally runs in a read-only transaction.
 */
export async function assertReadOnlySelect(sql: string, options: GuardOptions): Promise<GuardResult> {
  if (sql.trim() === '') throw new QueryRejectedError('multiple_statements', 'The query is empty.');
  let tree: { stmts?: { stmt: Json }[] };
  try {
    tree = (await parse(sql)) as { stmts?: { stmt: Json }[] };
  } catch (error) {
    throw new QueryRejectedError('syntax', `SQL syntax error: ${(error as Error).message}`);
  }
  const statements = tree.stmts ?? [];
  if (statements.length !== 1) {
    throw new QueryRejectedError(
      'multiple_statements',
      statements.length === 0 ? 'The query is empty.' : 'Send exactly one SELECT statement per call.',
    );
  }

  const root = statements[0]!.stmt as { [key: string]: Json };
  const rootType = Object.keys(root)[0] ?? 'unknown';
  if (rootType !== 'SelectStmt') {
    const name = STATEMENT_NAMES[rootType] ?? rootType.replace(/Stmt$/, '');
    throw new QueryRejectedError(
      'not_select',
      `Only SELECT queries are allowed; got ${name}. This server is read-only.`,
    );
  }

  const allowed = new Set(options.allowedSchemas.map((s) => s.toLowerCase()));
  const relations: string[] = [];
  const functions: string[] = [];

  for (const [type, node] of nodes(root)) {
    if (MODIFYING_STATEMENTS.has(type)) {
      throw new QueryRejectedError(
        'data_modifying_cte',
        `The query contains ${STATEMENT_NAMES[type]} inside a WITH clause; this server is read-only.`,
      );
    }
    if (type === 'SelectStmt') {
      if (node.intoClause)
        throw new QueryRejectedError('select_into', 'SELECT … INTO creates a table; use a plain SELECT.');
      if (node.lockingClause) {
        throw new QueryRejectedError(
          'row_locking',
          'Row locking clauses (FOR UPDATE / FOR SHARE) are not allowed.',
        );
      }
    }
    if (type === 'FuncCall') {
      const parts = strings(node.funcname).map((s) => s.toLowerCase());
      const name = parts.at(-1) ?? '';
      const schema = parts.length > 1 ? parts[0]! : null;
      functions.push(parts.join('.'));
      const denied =
        DENIED_FUNCTIONS.has(name) ||
        DENIED_PREFIXES.some((prefix) => name.startsWith(prefix)) ||
        (name.startsWith('pg_') && !SAFE_PG_FUNCTIONS.has(name)) ||
        (schema !== null && schema !== 'pg_catalog' && !allowed.has(schema));
      if (denied) {
        throw new QueryRejectedError(
          'forbidden_function',
          `The function ${parts.join('.')}() is not allowed by this server.`,
        );
      }
    }
    if (type === 'RangeVar') {
      const schema = typeof node.schemaname === 'string' ? node.schemaname.toLowerCase() : null;
      const relname = String(node.relname ?? '').toLowerCase();
      relations.push(schema ? `${schema}.${relname}` : relname);
      if (schema !== null && !allowed.has(schema)) {
        throw new QueryRejectedError(
          'forbidden_relation',
          `Schema "${schema}" is not readable here. Allowed schemas: ${[...allowed].join(', ')}.`,
        );
      }
      if (schema === null && relname.startsWith('pg_')) {
        throw new QueryRejectedError(
          'forbidden_relation',
          `System catalog "${relname}" is not readable here; use list_tables or describe_table for metadata.`,
        );
      }
    }
  }
  return { relations: [...new Set(relations)], functions: [...new Set(functions)] };
}
