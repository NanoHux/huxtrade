-- Partial take-profit ("scale out") and the breakeven stop that follows it.
--
-- Of 67 resolved trades in the 2026-08-07..09 replay, 61% reached +0.6R of
-- unrealised profit and 72% reached +0.5R, yet only 12% ever reached their
-- target: the dominant outcome was a position that went meaningfully green and
-- then gave all of it back plus the stop. ZRO ran to +3.14R, a fifth of a
-- percent from its target, and still closed at -1.06R.
--
-- An order can therefore now have TWO exits at different prices and times,
-- which the original one-order/one-terminal-state/one-realized_pnl shape could
-- not express. These columns record the first of them; `realized_pnl` and
-- `state` keep their existing meaning and describe the final exit only, so
-- every existing query, notification and reconciliation path reads the same
-- value it read before. Total realised for an order is
-- `coalesce(scaled_out_pnl,0) + coalesce(realized_pnl,0)`.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS scaled_out_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS scaled_out_price numeric;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS scaled_out_quantity numeric;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS scaled_out_pnl numeric;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS scaled_out_rfq_id text;
-- Set only once the surviving remainder's stop has actually been confirmed at
-- the breakeven price. Kept separate from scaled_out_at because the two are
-- distinct venue round-trips and the gap between them is exactly the window
-- where the position is unprotected: a row with scaled_out_at set and this
-- column still null is the state an operator needs to be able to find.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS breakeven_stop_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS breakeven_stop_price numeric;

-- `scaleOutDecision` refuses to fire twice on one position, and this is what
-- makes that guarantee survive a restart rather than living in agent memory.
CREATE INDEX IF NOT EXISTS orders_scaled_out_idx ON orders(asset_id) WHERE scaled_out_at IS NOT NULL;

-- Ships ENABLED: a scale-out moves real money and changes the risk on a live
-- position, so it belongs in the same class as order_created rather than with
-- the muted-by-default diagnostics.
INSERT INTO notification_preferences(event_type, enabled) VALUES ('scaled_out', true)
ON CONFLICT(event_type) DO NOTHING;
-- Ships ENABLED and deliberately loud. This fires when the half-close
-- succeeded but the replacement stop could not be created, which means the
-- agent has fallen back to closing the remainder outright. It is the one
-- outcome in this feature that needs a human to look at the venue.
INSERT INTO notification_preferences(event_type, enabled) VALUES ('breakeven_stop_failed', true)
ON CONFLICT(event_type) DO NOTHING;
