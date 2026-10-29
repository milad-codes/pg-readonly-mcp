import type pg from 'pg';
import { Catalog } from '../../src/db/catalog.js';
import { QueryFailedError } from '../../src/db/errors.js';
import { ALLOWED, hasDatabase, seed } from './setup.js';

describe.skipIf(!hasDatabase)('Catalog (PostgreSQL)', () => {
  let pool: pg.Pool;
  let catalog: Catalog;

  beforeAll(async () => {
    pool = await seed();
    catalog = new Catalog(pool, { allowedSchemas: ALLOWED, statementTimeoutMs: 2_000 });
  });
  afterAll(async () => {
    await pool.end();
  });

  it('lists tables of the allowed schemas only', async () => {
    const tables = await catalog.listTables();
    expect(tables.map((t) => `${t.schema}.${t.name}`)).toEqual([
      'public.customers',
      'public.users',
      'sales.orders',
    ]);
    expect(tables.find((t) => t.name === 'orders')).toMatchObject({ kind: 'table', estimatedRows: 20_000 });
    expect(tables.find((t) => t.name === 'customers')?.comment).toBe('Customers of the shop');
  });

  it('filters by schema and refuses others', async () => {
    expect((await catalog.listTables('sales')).map((t) => t.name)).toEqual(['orders']);
    await expect(catalog.listTables('secret')).rejects.toThrow(/not readable here/);
  });

  it('runs one query at a time on a client (node-postgres 9 drops queueing on a busy client)', async () => {
    const connect = pool.connect.bind(pool);
    let overlapping = 0;
    const spy = vi.spyOn(pool, 'connect').mockImplementation((async () => {
      const client = await connect();
      const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
      let busy = 0;
      (client as unknown as { query: (...args: unknown[]) => Promise<unknown> }).query = (...args) => {
        if (busy > 0) overlapping += 1;
        busy += 1;
        return query(...args).finally(() => {
          busy -= 1;
        });
      };
      return client;
    }) as typeof pool.connect);
    try {
      await catalog.describeTable('sales.orders');
    } finally {
      spy.mockRestore();
    }
    expect(overlapping).toBe(0);
  });

  it('describes columns, keys, constraints and indexes', async () => {
    const orders = await catalog.describeTable('sales.orders');
    expect(orders.columns.map((c) => `${c.name}:${c.type}:${c.nullable}`)).toEqual([
      'id:bigint:false',
      'customer_id:integer:false',
      'total:numeric(10,2):false',
      'status:text:false',
      'created_at:timestamp with time zone:false',
    ]);
    expect(orders.primaryKey).toEqual(['id']);
    expect(orders.foreignKeys[0]?.definition).toMatch(/REFERENCES (public\.)?customers\(id\)/);
    expect(orders.checkConstraints[0]?.definition).toMatch(/total >= /);
    expect(orders.indexes.map((i) => i.name).sort()).toEqual(['orders_customer_idx', 'orders_pkey']);
  });

  it('finds unqualified names in the allowed schemas', async () => {
    expect((await catalog.describeTable('orders')).schema).toBe('sales');
    expect((await catalog.describeTable('customers')).uniqueConstraints).toHaveLength(1);
  });

  it('reports missing, invalid and forbidden tables', async () => {
    await expect(catalog.describeTable('nope')).rejects.toBeInstanceOf(QueryFailedError);
    await expect(catalog.describeTable('a.b.c')).rejects.toThrow(/not a valid table name/);
    await expect(catalog.describeTable('secret.api_keys')).rejects.toThrow(/not readable here/);
  });
});
