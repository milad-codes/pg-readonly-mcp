import pg from 'pg';

export const DATABASE_URL = process.env.DATABASE_URL;
export const hasDatabase = Boolean(DATABASE_URL);

/** Schemas the tests allow; `secret` exists but must stay unreachable. */
export const ALLOWED = ['public', 'sales'];

export const SEED = `
  DROP SCHEMA IF EXISTS sales CASCADE;
  DROP SCHEMA IF EXISTS secret CASCADE;
  DROP SCHEMA IF EXISTS public CASCADE;
  CREATE SCHEMA public;
  CREATE SCHEMA sales;
  CREATE SCHEMA secret;

  CREATE TABLE public.customers (
    id serial PRIMARY KEY,
    name text NOT NULL,
    email text UNIQUE,
    created_at timestamptz NOT NULL DEFAULT '2026-01-01T00:00:00Z'
  );
  COMMENT ON TABLE public.customers IS 'Customers of the shop';
  CREATE TABLE public.users (id serial PRIMARY KEY, email text NOT NULL, password_hash text NOT NULL);
  CREATE TABLE sales.orders (
    id bigserial PRIMARY KEY,
    customer_id int NOT NULL REFERENCES public.customers (id),
    total numeric(10, 2) NOT NULL CHECK (total >= 0),
    status text NOT NULL DEFAULT 'open',
    created_at timestamptz NOT NULL DEFAULT '2026-01-01T00:00:00Z'
  );
  CREATE INDEX orders_customer_idx ON sales.orders (customer_id);
  CREATE TABLE secret.api_keys (id int, key text);

  INSERT INTO public.customers (name, email) VALUES ('Ada', 'ada@example.com'), ('Grace', 'grace@example.com'), ('Linus', NULL);
  INSERT INTO public.users (email, password_hash) VALUES ('ada@example.com', '$argon2id$secret'), ('grace@example.com', '$argon2id$other');
  INSERT INTO sales.orders (customer_id, total, status)
    SELECT 1 + (n % 3), (n % 500) + 0.99, CASE WHEN n % 10 = 0 THEN 'refunded' ELSE 'paid' END
      FROM generate_series(1, 20000) AS g(n);
  INSERT INTO secret.api_keys VALUES (1, 'sk-live-should-never-leak');
  ANALYZE;
`;

export async function seed(): Promise<pg.Pool> {
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
  await pool.query(SEED);
  return pool;
}
