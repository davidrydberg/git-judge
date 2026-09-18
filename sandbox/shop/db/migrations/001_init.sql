CREATE TABLE orders (
  id uuid PRIMARY KEY,
  customer_id uuid NOT NULL,
  legacy_customer_ref text,
  total_cents integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  actor_id uuid NOT NULL,
  action text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
