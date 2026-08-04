ALTER TABLE indicator_snapshots ADD COLUMN IF NOT EXISTS oi_change_1h numeric;
ALTER TABLE indicator_snapshots ADD COLUMN IF NOT EXISTS funding_change_4h numeric;
ALTER TABLE indicator_snapshots ADD COLUMN IF NOT EXISTS funding_change_z numeric;
ALTER TABLE indicator_snapshots ADD COLUMN IF NOT EXISTS warmup_ready boolean NOT NULL DEFAULT false;
ALTER TABLE indicator_snapshots ADD COLUMN IF NOT EXISTS scan_run_id uuid;

CREATE TABLE IF NOT EXISTS scan_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  closed_at timestamptz NOT NULL UNIQUE,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  btc_regime text,
  btc_context jsonb NOT NULL DEFAULT '{}'::jsonb,
  asset_count integer NOT NULL DEFAULT 0,
  success_count integer NOT NULL DEFAULT 0,
  failure_count integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'RUNNING',
  error text
);

DO $$ BEGIN
  ALTER TABLE indicator_snapshots ADD CONSTRAINT indicator_snapshots_scan_run_fk
    FOREIGN KEY (scan_run_id) REFERENCES scan_runs(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS heatmap_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id uuid NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  strategy_id uuid NOT NULL REFERENCES strategies(id) ON DELETE CASCADE,
  direction text NOT NULL CHECK(direction IN ('LONG','SHORT')),
  region_price numeric NOT NULL,
  region_low numeric NOT NULL,
  region_high numeric NOT NULL,
  intensity numeric NOT NULL,
  entered_at timestamptz NOT NULL,
  confirm_after timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'ARMED' CHECK(status IN ('ARMED','CONFIRMED','INVALIDATED')),
  invalid_reason text,
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS heatmap_one_armed_candidate
  ON heatmap_candidates(asset_id, strategy_id, direction) WHERE status='ARMED';

CREATE TABLE IF NOT EXISTS positions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  platform_position_id text UNIQUE,
  asset_id uuid NOT NULL REFERENCES assets(id),
  direction text NOT NULL CHECK(direction IN ('LONG','SHORT')),
  quantity numeric NOT NULL,
  entry_price numeric NOT NULL,
  take_profit numeric,
  stop_loss numeric,
  unrealized_pnl numeric,
  realized_pnl numeric,
  opened_at timestamptz NOT NULL,
  closed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  raw_platform_state jsonb
);

CREATE TABLE IF NOT EXISTS fills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  position_id uuid REFERENCES positions(id) ON DELETE SET NULL,
  platform_fill_id text NOT NULL UNIQUE,
  side text NOT NULL,
  price numeric NOT NULL,
  quantity numeric NOT NULL,
  fee numeric,
  realized_pnl numeric,
  filled_at timestamptz NOT NULL,
  raw_platform_state jsonb
);

CREATE TABLE IF NOT EXISTS notification_preferences (
  event_type text PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO notification_preferences(event_type) VALUES
  ('signal'),('order_created'),('order_failed'),('entry_filled'),('closed_tp'),
  ('closed_sl_or_liquidated'),('system_error'),('variational_session_lost'),
  ('margin_pause_resume'),('service_recovered')
ON CONFLICT(event_type) DO NOTHING;

CREATE TABLE IF NOT EXISTS metric_baselines (
  asset_id uuid NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  metric text NOT NULL CHECK(metric IN ('OI_RAW','CVD_15M','FUNDING_RAW')),
  observed_at timestamptz NOT NULL,
  value numeric NOT NULL,
  source text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(asset_id, metric, observed_at)
);

CREATE INDEX IF NOT EXISTS indicator_snapshots_asset_closed_idx ON indicator_snapshots(asset_id, closed_at DESC);
CREATE INDEX IF NOT EXISTS positions_asset_open_idx ON positions(asset_id, closed_at) WHERE closed_at IS NULL;
CREATE INDEX IF NOT EXISTS fills_order_idx ON fills(order_id, filled_at DESC);
CREATE INDEX IF NOT EXISTS metric_baselines_lookup_idx ON metric_baselines(asset_id, metric, observed_at DESC);

CREATE TABLE IF NOT EXISTS asset_signal_cursors (
  asset_id uuid PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
  closed_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO app_state(key,value) VALUES('signal_cursor','{"closedAt":null}') ON CONFLICT(key) DO NOTHING;
