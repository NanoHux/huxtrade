ALTER TABLE assets ADD COLUMN IF NOT EXISTS coinglass_url text;

UPDATE assets
SET coinglass_url='https://www.coinglass.com/pro/futures/LiquidationHeatMap?coin=' ||
  regexp_replace(regexp_replace(coinglass_symbol,'^Binance_',''),'USDT$','') || '&type=pair'
WHERE coinglass_url IS NULL;

UPDATE assets
SET coinglass_symbol='Binance_' || regexp_replace(coinglass_symbol,'USDT$','') || 'USDT'
WHERE coinglass_symbol NOT LIKE 'Binance_%';

ALTER TABLE assets ALTER COLUMN coinglass_url SET NOT NULL;

CREATE TABLE IF NOT EXISTS coinglass_heatmaps (
  asset_id uuid NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  heatmap_range text NOT NULL CHECK (heatmap_range IN ('12h','24h','3d','7d','30d')),
  source_url text NOT NULL,
  captured_at timestamptz NOT NULL,
  regions jsonb NOT NULL,
  raw jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(asset_id,heatmap_range)
);

CREATE INDEX IF NOT EXISTS coinglass_heatmaps_captured_idx ON coinglass_heatmaps(captured_at DESC);

INSERT INTO app_state(key,value) VALUES('coinglass_session','{"loggedIn":false,"lastCheckedAt":null,"error":null}')
ON CONFLICT(key) DO NOTHING;
