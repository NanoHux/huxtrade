-- Adds orders.reconcile_misses: counts consecutive authoritative
-- reconciliations that found no platform evidence for an UNKNOWN order that
-- never received an rfq_id; at the limit the agent releases it to
-- SUBMISSION_FAILED so it stops occupying the per-side order cap forever.
--
-- Also backfills the damage done by the pre-apportionment sync, which copied
-- the platform's per-instrument AGGREGATE position (quantity, unrealized and
-- realized PnL) onto every stacked same-direction order, multiply-counting
-- everything, and never closed positions rows locally (/api/positions only
-- lists open positions, so a closed order's row froze open with stale
-- unrealized PnL).
--
-- The equal split below is safe because stacked orders always used the same
-- margin, so identical copied values divide evenly and the split rows again
-- sum to the platform's aggregate. Live rows are overwritten with correctly
-- apportioned values by the next 30-second sync anyway.
--
-- The whole migration is guarded on the new column's absence: the split is
-- not idempotent (a second run would halve the values again), and the guard
-- makes reapplication a no-op.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='public' AND table_name='orders' AND column_name='reconcile_misses') THEN
    RETURN;
  END IF;

  ALTER TABLE orders ADD COLUMN reconcile_misses integer NOT NULL DEFAULT 0;

  UPDATE positions p SET closed_at=o.updated_at,unrealized_pnl=NULL,updated_at=now()
  FROM orders o
  WHERE o.id=p.order_id AND p.closed_at IS NULL
    AND o.state IN ('CLOSED_TP','CLOSED_SL','CLOSED_REVERSED','LIQUIDATED','CANCELLED_EXTERNALLY');

  WITH g AS (
    SELECT id, count(*) OVER (PARTITION BY asset_id,direction,state,realized_pnl) n
    FROM orders WHERE realized_pnl IS NOT NULL
  )
  UPDATE orders o SET realized_pnl=o.realized_pnl/g.n, updated_at=now()
  FROM g WHERE g.id=o.id AND g.n>1;

  WITH g AS (
    SELECT id, count(*) OVER (PARTITION BY asset_id,direction,quantity,entry_price) n
    FROM positions
  )
  UPDATE positions p SET quantity=p.quantity/g.n,
    unrealized_pnl=p.unrealized_pnl/g.n,
    realized_pnl=p.realized_pnl/g.n,
    updated_at=now()
  FROM g WHERE g.id=p.id AND g.n>1;
END $$;
