import type pg from 'pg';
import { ReadOnlyExecutor } from '../../src/db/executor.js';
import { QueryFailedError } from '../../src/db/errors.js';
import { inReadOnlyTransaction } from '../../src/db/transaction.js';
import { QueryRejectedError } from '../../src/sql/guard.js';
import { ALLOWED, hasDatabase, seed } from './setup.js';

describe.skipIf(!hasDatabase)('ReadOnlyExecutor (PostgreSQL)', () => {
  let pool: pg.Pool;
  const executor = (overrides: Partial<ConstructorParameters<typeof ReadOnlyExecutor>[1]> = {}) =>
    new ReadOnlyExecutor(pool, {
      allowedSchemas: ALLOWED,
      maxRows: 50,
      statementTimeoutMs: 2_000,
      redactColumns: /password|secret|token/i,
      allowExplainAnalyze: false,
      ...overrides,
    });

  beforeAll(async () => {
    pool = await seed();
  });
  afterAll(async () => {
    await pool.end();
  });

  it('returns rows with column types and binds parameters', async () => {
    const result = await executor().query('SELECT id, name, created_at FROM customers WHERE id = $1', [2]);
    expect(result.rows).toEqual([{ id: 2, name: 'Grace', created_at: '2026-01-01T00:00:00.000Z' }]);
    expect(result.columns).toEqual([
      { name: 'id', type: 'integer' },
      { name: 'name', type: 'text' },
      { name: 'created_at', type: 'timestamp with time zone' },
    ]);
    expect(result.truncated).toBe(false);
  });

  it('caps rows with a cursor and reports truncation', async () => {
    const capped = await executor().query('SELECT id FROM sales.orders ORDER BY id');
    expect(capped).toMatchObject({ rowCount: 50, truncated: true });
    expect(capped.rows.at(-1)).toEqual({ id: '50' }); // bigint arrives as text, never as a lossy number
    const smaller = await executor().query('SELECT id FROM sales.orders ORDER BY id', [], 5);
    expect(smaller.rowCount).toBe(5);
    const tooLarge = await executor().query('SELECT id FROM sales.orders', [], 10_000);
    expect(tooLarge.rowCount).toBe(50);
  });

  it('resolves unqualified names only within the allowed schemas', async () => {
    const result = await executor().query('SELECT count(*)::int AS n FROM orders');
    expect(result.rows).toEqual([{ n: 20_000 }]);
  });

  it('masks sensitive columns, including through SELECT *', async () => {
    const result = await executor().query('SELECT * FROM users ORDER BY id');
    expect(result.redactedColumns).toEqual(['password_hash']);
    expect(result.rows[0]).toMatchObject({ email: 'ada@example.com', password_hash: '[redacted]' });
  });

  it('rejects unsafe SQL before it reaches the database', async () => {
    await expect(executor().query('DELETE FROM customers')).rejects.toBeInstanceOf(QueryRejectedError);
    await expect(executor().query('SELECT * FROM secret.api_keys')).rejects.toBeInstanceOf(
      QueryRejectedError,
    );
  });

  it('still refuses writes that bypass the parser (defence in depth)', async () => {
    const error = await inReadOnlyTransaction(
      pool,
      { allowedSchemas: ALLOWED, statementTimeoutMs: 2_000 },
      (client) => client.query('DELETE FROM public.customers'),
    ).catch((e: unknown) => e);
    expect((error as { code?: string }).code).toBe('25006');
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM public.customers');
    expect(rows[0].n).toBe(3);
  });

  it('cancels queries that exceed the time limit', async () => {
    const slow = executor({ statementTimeoutMs: 200 });
    const error = await slow
      .query('SELECT count(*) FROM generate_series(1, 200000000)')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(QueryFailedError);
    expect((error as QueryFailedError).message).toMatch(/exceeded the 200 ms time limit/);
    // the pooled connection is still usable afterwards
    await expect(slow.query('SELECT 1 AS ok')).resolves.toMatchObject({ rows: [{ ok: 1 }] });
  });

  it('turns database errors into actionable messages', async () => {
    const error = await executor()
      .query('SELECT nope FROM customers')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(QueryFailedError);
    expect((error as QueryFailedError).message).toMatch(/column "nope" does not exist/);
  });

  describe('explain', () => {
    it('summarises the plan and flags large sequential scans', async () => {
      const result = await executor().explain("SELECT * FROM sales.orders WHERE status = 'refunded'");
      expect(result.summary.sequentialScans).toEqual([
        expect.objectContaining({
          relation: 'sales.orders',
          tableRows: 20_000,
          filter: expect.stringContaining('refunded'),
        }),
      ]);
      expect(result.summary.warnings.join()).toMatch(/Sequential scan on sales\.orders reads ~20,000 rows/);
      expect(result.summary.actualTimeMs).toBeNull();
    });

    it('uses indexes where they exist', async () => {
      const result = await executor().explain('SELECT * FROM sales.orders WHERE id = $1', [42]);
      expect(Object.keys(result.summary.nodeTypes)).toContain('Index Scan');
      expect(result.summary.warnings).toEqual([]);
    });

    it('allows ANALYZE only when enabled', async () => {
      await expect(executor().explain('SELECT 1', [], true)).rejects.toThrow(/disabled/);
      const analyzed = await executor({ allowExplainAnalyze: true }).explain(
        'SELECT count(*) FROM sales.orders',
        [],
        true,
      );
      expect(analyzed.summary.actualTimeMs).toEqual(expect.any(Number));
    });

    it('validates the explained query too', async () => {
      await expect(executor().explain('DELETE FROM customers')).rejects.toBeInstanceOf(QueryRejectedError);
    });
  });
});
