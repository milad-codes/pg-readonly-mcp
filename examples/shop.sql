-- Synthetic data for the demo: invented customers, example.com addresses and generated orders.
-- Loaded automatically by examples/docker-compose.yml (database "shop").

CREATE SCHEMA sales;
CREATE SCHEMA secret;

CREATE TABLE public.customers (
  id serial PRIMARY KEY,
  name text NOT NULL,
  email text UNIQUE,
  country text NOT NULL,
  created_at timestamptz NOT NULL
);
COMMENT ON TABLE public.customers IS 'Customers of the demo shop (synthetic)';

CREATE TABLE public.users (
  id serial PRIMARY KEY,
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL
);

CREATE TABLE sales.orders (
  id bigserial PRIMARY KEY,
  customer_id int NOT NULL REFERENCES public.customers (id),
  total numeric(10, 2) NOT NULL CHECK (total >= 0),
  status text NOT NULL CHECK (status IN ('paid', 'refunded', 'cancelled')),
  created_at timestamptz NOT NULL
);
CREATE INDEX orders_customer_idx ON sales.orders (customer_id);
COMMENT ON TABLE sales.orders IS 'Orders (generated)';

CREATE TABLE secret.api_keys (id int PRIMARY KEY, key text NOT NULL);

INSERT INTO public.customers (name, email, country, created_at)
SELECT 'Customer ' || n, 'customer' || n || '@example.com', (ARRAY['DE', 'AT', 'CH', 'NL', 'FR'])[1 + n % 5],
       timestamptz '2025-01-01' + n * interval '1 day'
  FROM generate_series(1, 200) AS g(n);

INSERT INTO public.users (email, password_hash)
SELECT 'staff' || n || '@example.com', 'demo-hash-not-a-real-secret-' || n FROM generate_series(1, 5) AS g(n);

INSERT INTO sales.orders (customer_id, total, status, created_at)
SELECT 1 + (n * 7) % 200,
       ((n * 37) % 480) + 5.99,
       CASE WHEN n % 13 = 0 THEN 'refunded' WHEN n % 29 = 0 THEN 'cancelled' ELSE 'paid' END,
       timestamptz '2026-01-01' + (n % 300) * interval '1 day'
  FROM generate_series(1, 20000) AS g(n);

INSERT INTO secret.api_keys VALUES (1, 'demo-key-that-must-not-leak');

-- The role the README recommends: read-only by default and no access to the secret schema at all.
CREATE ROLE mcp_reader LOGIN PASSWORD 'mcp_reader';
ALTER ROLE mcp_reader SET default_transaction_read_only = on;
GRANT CONNECT ON DATABASE shop TO mcp_reader;
GRANT USAGE ON SCHEMA public, sales TO mcp_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public, sales TO mcp_reader;

ANALYZE;
