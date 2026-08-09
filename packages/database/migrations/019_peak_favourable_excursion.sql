-- The high-water mark of unrealised profit, in stop-widths, that a position
-- actually reached on the venue's own mark price.
--
-- DEXE went 0.99R in favour on Binance and never scaled out, and there was no
-- way to tell whether the 0.5R trigger was genuinely never reached on
-- Variational's mark — an RFQ venue whose price for a thin asset can diverge
-- from Binance by more than the trigger distance — or whether the mechanism
-- had failed. positions.unrealized_pnl is overwritten every sweep, so nothing
-- retained the answer. One column, written only when it rises.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS peak_favourable_r numeric;
