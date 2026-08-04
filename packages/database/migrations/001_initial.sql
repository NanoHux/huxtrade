CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  binance_symbol text NOT NULL UNIQUE,
  coinglass_symbol text NOT NULL,
  variational_url text NOT NULL,
  collect_enabled boolean NOT NULL DEFAULT true,
  signal_enabled boolean NOT NULL DEFAULT true,
  trade_enabled boolean NOT NULL DEFAULT false,
  paused boolean NOT NULL DEFAULT false,
  pause_reason text,
  last_updated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS strategies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  logic text NOT NULL CHECK (logic IN ('AND','N_OF_M')),
  required_count integer,
  conditions text[] NOT NULL,
  heatmap_range text NOT NULL DEFAULT '24h',
  max_orders_per_side integer NOT NULL DEFAULT 5,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS one_enabled_strategy ON strategies(enabled) WHERE enabled;

CREATE TABLE IF NOT EXISTS indicator_snapshots (
  id bigserial PRIMARY KEY,
  asset_id uuid NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  closed_at timestamptz NOT NULL,
  price numeric NOT NULL,
  oi_value numeric, oi_z numeric, oi_passed boolean,
  cvd_value numeric, cvd_z numeric, cvd_passed boolean, cvd_direction text,
  funding_value numeric, funding_z numeric, funding_passed boolean,
  heatmap jsonb, heatmap_passed boolean,
  btc_regime text,
  inputs jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(asset_id, closed_at)
);

CREATE TABLE IF NOT EXISTS signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id uuid NOT NULL REFERENCES assets(id),
  strategy_id uuid NOT NULL REFERENCES strategies(id),
  closed_at timestamptz NOT NULL,
  direction text NOT NULL CHECK(direction IN ('LONG','SHORT')),
  executable boolean NOT NULL,
  accepted boolean NOT NULL,
  conditions jsonb NOT NULL,
  rejection_reasons text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(asset_id, strategy_id, closed_at, direction)
);

CREATE TABLE IF NOT EXISTS orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  signal_id uuid REFERENCES signals(id),
  asset_id uuid NOT NULL REFERENCES assets(id),
  strategy_id uuid NOT NULL REFERENCES strategies(id),
  idempotency_key text NOT NULL UNIQUE,
  platform_order_id text UNIQUE,
  direction text NOT NULL CHECK(direction IN ('LONG','SHORT')),
  state text NOT NULL,
  entry_price numeric NOT NULL,
  stop_loss numeric NOT NULL,
  take_profit numeric NOT NULL,
  margin_usdc numeric NOT NULL,
  leverage integer NOT NULL,
  realized_pnl numeric,
  raw_platform_state jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS order_events (
  id bigserial PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  from_state text, to_state text NOT NULL,
  reason text NOT NULL, payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS service_health (
  service text PRIMARY KEY,
  state text NOT NULL,
  last_success_at timestamptz,
  consecutive_failures integer NOT NULL DEFAULT 0,
  error text,
  blocks_trading boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_state (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO app_state(key, value) VALUES
  ('global_pause', '{"paused":false,"reason":null}'),
  ('account_risk', '{"marginUsagePercent":0,"balanceUsdc":0}'),
  ('variational_session', '{"loggedIn":false,"discoveryComplete":false}')
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS outbox (
  id bigserial PRIMARY KEY,
  topic text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS outbox_pending_idx ON outbox(status, available_at);

