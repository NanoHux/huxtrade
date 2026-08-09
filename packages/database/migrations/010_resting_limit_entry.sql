-- Resting limit entry model.
--
-- The signal no longer places the order: it arms a direction bias, and the
-- entry waits at a structural level that is re-validated on every 15-minute
-- close. Orders therefore gain a kind (the old market-on-signal path stays,
-- selectable, so the change is reversible), the timestamp of their last
-- revalidation, a link to whatever order replaced them, and the provenance
-- of the level they sit at.
--
-- Existing rows are all market-on-signal, which is exactly the column default,
-- so no backfill is needed and the whole migration is plain idempotent DDL.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS entry_kind text NOT NULL DEFAULT 'MARKET_ON_SIGNAL';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS revalidated_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS replaced_by uuid;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS entry_provenance jsonb;

DO $$ BEGIN
  ALTER TABLE orders ADD CONSTRAINT orders_entry_kind_check
    CHECK (entry_kind IN ('MARKET_ON_SIGNAL','RESTING_LIMIT'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A replaced order keeps pointing at its replacement for the audit trail; if
-- the replacement is ever deleted the link drops rather than the history.
DO $$ BEGIN
  ALTER TABLE orders ADD CONSTRAINT orders_replaced_by_fk
    FOREIGN KEY (replaced_by) REFERENCES orders(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- One row per asset per scan, in shadow and live alike: the ledger that makes
-- the model auditable before any of it is allowed to trade. KEEP and NONE
-- scans are recorded too — knowing the model deliberately did nothing is what
-- separates a working hysteresis band from a broken candidate search.
--
-- Everything about the level is nullable because CANCEL/NONE rows have no
-- level to record; `decision` and `decision_reason` never are.
CREATE TABLE IF NOT EXISTS entry_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id uuid NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  closed_at timestamptz NOT NULL,
  direction text CHECK(direction IN ('LONG','SHORT')),
  level numeric,
  stop_loss numeric,
  take_profit numeric,
  expected_rr numeric,
  provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
  decision text NOT NULL CHECK(decision IN ('PLACE','KEEP','REPLACE','CANCEL','NONE')),
  decision_reason text NOT NULL,
  working_order_id uuid REFERENCES orders(id) ON DELETE SET NULL,
  mode text NOT NULL CHECK(mode IN ('shadow','live')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(asset_id, closed_at)
);
CREATE INDEX IF NOT EXISTS entry_plans_closed_at_idx ON entry_plans(closed_at);

-- Ships disabled: 15 assets revalidating every 15 minutes would flood the
-- chat with routine replacements. Fills and reversal cancellations keep using
-- their existing, enabled topics.
INSERT INTO notification_preferences(event_type, enabled) VALUES ('resting_order_replaced', false)
ON CONFLICT(event_type) DO NOTHING;
