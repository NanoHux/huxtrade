-- CLOSE_OPPOSITE joins the entry_plans decision set.
--
-- Under the market-on-signal path a reversal was a side effect of submitting
-- the new entry (decideAssetConflict closes the old position first). The
-- resting model does not submit on a flip, so the exit needs its own decision
-- — and it has to be recorded like any other, otherwise the ledger shows a
-- position vanishing with no scan that asked for it.
--
-- The old constraint is located by definition rather than by name so this
-- works whether 010 landed with PostgreSQL's auto-generated name or not, and
-- re-running simply drops and re-adds the same constraint.
DO $$
DECLARE existing text;
BEGIN
  FOR existing IN
    SELECT conname FROM pg_constraint
    WHERE conrelid='entry_plans'::regclass AND contype='c'
      AND pg_get_constraintdef(oid) LIKE '%decision%'
      AND pg_get_constraintdef(oid) NOT LIKE '%decision_reason%'
  LOOP
    EXECUTE format('ALTER TABLE entry_plans DROP CONSTRAINT %I',existing);
  END LOOP;
  ALTER TABLE entry_plans ADD CONSTRAINT entry_plans_decision_check
    CHECK (decision IN ('PLACE','KEEP','REPLACE','CANCEL','CLOSE_OPPOSITE','NONE'));
END $$;
