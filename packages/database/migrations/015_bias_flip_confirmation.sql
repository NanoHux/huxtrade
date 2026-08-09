-- A contested reversal has to survive a restart, otherwise every agent restart
-- silently forgives the counter-signals accumulated so far and a real reversal
-- can never reach its confirmation count.
--
-- Reversals used to be taken on a single 15-minute bar, which meant a signal
-- noisier than the stop-loss could overrule the stop-loss: an armed BTC bias
-- reversed six times in five hours, market-closing filled positions that still
-- had their own defined risk and whose trend had not actually turned.
ALTER TABLE asset_signal_cursors ADD COLUMN IF NOT EXISTS pending_flip_direction text;
ALTER TABLE asset_signal_cursors ADD COLUMN IF NOT EXISTS pending_flip_count integer NOT NULL DEFAULT 0;

DO $$ BEGIN
  ALTER TABLE asset_signal_cursors ADD CONSTRAINT asset_signal_cursors_pending_flip_check
    CHECK (pending_flip_direction IS NULL OR pending_flip_direction IN ('LONG','SHORT'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
