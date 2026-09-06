-- Hourly klines, the gainers basket's ranking input.
--
-- Idempotent like every other migration here: the migration test applies the
-- whole directory twice, so a bare CREATE TABLE fails the second pass.
CREATE TABLE IF NOT EXISTS klines_1h (
  symbol       text        NOT NULL,
  open_time    bigint      NOT NULL,
  open         numeric     NOT NULL,
  high         numeric     NOT NULL,
  low          numeric     NOT NULL,
  close        numeric     NOT NULL,
  quote_volume numeric     NOT NULL,
  PRIMARY KEY (symbol, open_time)
);

CREATE INDEX IF NOT EXISTS idx_klines_1h_time ON klines_1h (open_time);
