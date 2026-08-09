-- Virtual entries: the level is held locally and nothing reaches the venue
-- until price arrives AND two 5m closes decline to contradict the trade.
--
-- A resting limit order is filled TO you: price arrives, the order is taken,
-- and the model finds out on the next reconciliation. Holding the level
-- locally makes the last step a decision instead — and cancelling a virtual
-- entry costs nothing, which is what makes the extra question worth asking.
--
-- An order in CREATED_LOCAL with awaiting_trigger set has no platform order
-- behind it and never had one; that is what distinguishes it from a row that
-- is mid-submission.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS awaiting_trigger boolean NOT NULL DEFAULT false;
-- Open time of the 5m candle that first reached the level. The FIRST touch
-- starts the clock: letting a later touch slide the window forward means a
-- price that keeps brushing the level never resolves either way.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS trigger_touched_at timestamptz;

CREATE INDEX IF NOT EXISTS orders_awaiting_trigger_idx ON orders(asset_id) WHERE awaiting_trigger;
