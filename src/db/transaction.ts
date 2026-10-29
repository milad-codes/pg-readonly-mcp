import pg from 'pg';

export interface TransactionLimits {
  allowedSchemas: readonly string[];
  statementTimeoutMs: number;
}

/**
 * Runs `work` in a READ ONLY, REPEATABLE READ transaction that is always rolled back. Writes are refused by
 * PostgreSQL itself, whatever SQL reaches it, and every statement is bounded by statement and lock timeouts.
 * search_path is limited to the allowed schemas so unqualified names cannot resolve elsewhere.
 */
export async function inReadOnlyTransaction<T>(
  pool: pg.Pool,
  limits: TransactionLimits,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const timeout = Math.trunc(limits.statementTimeoutMs);
    await client.query(`SET LOCAL statement_timeout = ${timeout}`);
    await client.query(`SET LOCAL lock_timeout = ${Math.min(timeout, 2000)}`);
    await client.query(`SET LOCAL idle_in_transaction_session_timeout = ${timeout + 5000}`);
    await client.query(
      `SET LOCAL search_path = ${limits.allowedSchemas.map((s) => client.escapeIdentifier(s)).join(', ')}`,
    );
    return await work(client);
  } finally {
    try {
      await client.query('ROLLBACK');
    } catch (error) {
      broken = error as Error;
    }
    client.release(broken);
  }
}
