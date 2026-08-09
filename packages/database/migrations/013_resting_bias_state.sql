-- Bias state has to survive a restart. It lives beside the per-asset scan
-- cursor rather than in app_state because it is per-asset and is read and
-- written on exactly the same scan boundary as the cursor itself — one row,
-- one lock, no chance of the two disagreeing about which close they describe.
ALTER TABLE asset_signal_cursors ADD COLUMN IF NOT EXISTS bias_direction text;
ALTER TABLE asset_signal_cursors ADD COLUMN IF NOT EXISTS bias_armed_at timestamptz;
ALTER TABLE asset_signal_cursors ADD COLUMN IF NOT EXISTS bias_armed_until timestamptz;
ALTER TABLE asset_signal_cursors ADD COLUMN IF NOT EXISTS bias_strength numeric NOT NULL DEFAULT 0;

DO $$ BEGIN
  ALTER TABLE asset_signal_cursors ADD CONSTRAINT asset_signal_cursors_bias_direction_check
    CHECK (bias_direction IS NULL OR bias_direction IN ('LONG','SHORT'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Which entry model a strategy actually executes. Defaults to the path that
-- is running today, so applying this migration changes no behaviour: the
-- resting model still records its shadow ledger, but nothing switches over
-- until an operator selects it. This is the rollback lever from spec 3-5.
ALTER TABLE strategies ADD COLUMN IF NOT EXISTS entry_kind text NOT NULL DEFAULT 'MARKET_ON_SIGNAL';
DO $$ BEGIN
  ALTER TABLE strategies ADD CONSTRAINT strategies_entry_kind_check
    CHECK (entry_kind IN ('MARKET_ON_SIGNAL','RESTING_LIMIT'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The dashboard reads working resting orders on every render, and the shadow
-- comparison reads the ledger by asset over a multi-day window.
CREATE INDEX IF NOT EXISTS orders_working_resting_idx ON orders(asset_id) WHERE state='PENDING_ENTRY';
CREATE INDEX IF NOT EXISTS entry_plans_asset_closed_idx ON entry_plans(asset_id, closed_at DESC);
