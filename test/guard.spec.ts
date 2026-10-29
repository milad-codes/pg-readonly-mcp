import { assertReadOnlySelect, QueryRejectedError, type RejectionReason } from '../src/sql/guard.js';

const options = { allowedSchemas: ['public', 'sales'] };

describe('assertReadOnlySelect', () => {
  it.each([
    'SELECT 1',
    'select id, email from users where id = $1',
    'SELECT o.id, c.name FROM sales.orders o JOIN public.customers c ON c.id = o.customer_id ORDER BY o.id LIMIT 10',
    "WITH recent AS (SELECT * FROM orders WHERE created_at > now() - interval '7 days') SELECT count(*) FROM recent",
    'SELECT * FROM orders WHERE id IN (SELECT order_id FROM sales.refunds)',
    'SELECT 1 UNION ALL SELECT 2',
    "VALUES (1, 'a'), (2, 'b')",
    'TABLE customers',
    "SELECT pg_size_pretty(pg_total_relation_size('orders'))",
    'SELECT * FROM generate_series(1, 3) AS g(n)',
    "SELECT pg_catalog.lower('A')",
    'SELECT 1; -- trailing comment only',
  ])('allows %s', async (sql) => {
    await expect(assertReadOnlySelect(sql, options)).resolves.toBeDefined();
  });

  it.each<[string, RejectionReason]>([
    ['SELEC 1', 'syntax'],
    ['', 'multiple_statements'],
    ['-- only a comment', 'multiple_statements'],
    ['SELECT 1; SELECT 2', 'multiple_statements'],
    ['SELECT 1; DELETE FROM users', 'multiple_statements'],
    ['DELETE FROM users', 'not_select'],
    ['UPDATE users SET email = NULL', 'not_select'],
    ['INSERT INTO users (id) VALUES (1)', 'not_select'],
    ['MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN DELETE', 'not_select'],
    ['TRUNCATE users', 'not_select'],
    ['DROP TABLE users', 'not_select'],
    ['CREATE TABLE x (id int)', 'not_select'],
    ['COPY users TO STDOUT', 'not_select'],
    ['EXPLAIN ANALYZE DELETE FROM users', 'not_select'],
    ['DO $$ BEGIN DELETE FROM users; END $$', 'not_select'],
    ['CALL cleanup()', 'not_select'],
    ['SET statement_timeout = 0', 'not_select'],
    ['BEGIN', 'not_select'],
    ['WITH d AS (DELETE FROM users RETURNING *) SELECT * FROM d', 'data_modifying_cte'],
    ["WITH u AS (UPDATE users SET email = 'x' RETURNING id) SELECT count(*) FROM u", 'data_modifying_cte'],
    ['SELECT * INTO backup FROM users', 'select_into'],
    ['SELECT * FROM users FOR UPDATE', 'row_locking'],
    ['SELECT * FROM (SELECT * FROM users FOR SHARE) s', 'row_locking'],
    ['SELECT pg_sleep(10)', 'forbidden_function'],
    ['SELECT pg_terminate_backend(123)', 'forbidden_function'],
    ["SELECT pg_read_file('/etc/passwd')", 'forbidden_function'],
    ["SELECT set_config('search_path', 'secret', false)", 'forbidden_function'],
    ["SELECT nextval('orders_id_seq')", 'forbidden_function'],
    ["SELECT * FROM dblink('host=evil', 'DELETE FROM x') AS t(a int)", 'forbidden_function'],
    ["SELECT lo_import('/etc/passwd')", 'forbidden_function'],
    ["SELECT query_to_xml('DELETE FROM users RETURNING *', true, false, '')", 'forbidden_function'],
    ["SELECT table_to_xml('secret.users', true, false, '')", 'forbidden_function'],
    ["SELECT * FROM ts_stat('SELECT to_tsvector(key) FROM secret.api_keys')", 'forbidden_function'],
    ["SELECT pg_catalog.ts_stat('SELECT to_tsvector(key) FROM secret.api_keys')", 'forbidden_function'],
    [
      "SELECT ts_rewrite('a'::tsquery, 'SELECT to_tsquery(key), ''a''::tsquery FROM secret.api_keys')",
      'forbidden_function',
    ],
    [
      "SELECT * FROM crosstab('SELECT 1, 2, key FROM secret.api_keys') AS t(a int, b text)",
      'forbidden_function',
    ],
    [
      "SELECT * FROM public.connectby('secret.tree', 'id', 'parent', '1', 0) AS t(id text, parent text, level int)",
      'forbidden_function',
    ],
    ['SELECT admin.rotate_keys()', 'forbidden_function'],
    ['SELECT * FROM secret.api_keys', 'forbidden_relation'],
    ['SELECT * FROM information_schema.tables', 'forbidden_relation'],
    ['SELECT * FROM pg_catalog.pg_authid', 'forbidden_relation'],
    ['SELECT query FROM pg_stat_activity', 'forbidden_relation'],
    ['SELECT * FROM orders WHERE id IN (SELECT id FROM secret.audit)', 'forbidden_relation'],
  ])('rejects %j as %s', async (sql, reason) => {
    const error = await assertReadOnlySelect(sql, options).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(QueryRejectedError);
    expect((error as QueryRejectedError).reason).toBe(reason);
  });

  it('reports referenced relations and functions', async () => {
    const result = await assertReadOnlySelect(
      'SELECT count(*), max(o.total) FROM sales.orders o JOIN customers c USING (customer_id)',
      options,
    );
    expect(result.relations.sort()).toEqual(['customers', 'sales.orders']);
    expect(result.functions.sort()).toEqual(['count', 'max']);
  });

  it('explains rejections in terms an assistant can act on', async () => {
    await expect(assertReadOnlySelect('DELETE FROM users', options)).rejects.toThrow(
      /Only SELECT queries are allowed; got DELETE/,
    );
    await expect(assertReadOnlySelect('SELECT * FROM secret.x', options)).rejects.toThrow(
      /Allowed schemas: public, sales/,
    );
  });
});
