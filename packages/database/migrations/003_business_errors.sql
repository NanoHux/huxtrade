CREATE TABLE IF NOT EXISTS business_errors (
  id bigserial PRIMARY KEY,
  service text NOT NULL,
  asset_id uuid REFERENCES assets(id) ON DELETE SET NULL,
  code text NOT NULL,
  message text NOT NULL,
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  blocks_trading boolean NOT NULL DEFAULT false,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS business_errors_service_time_idx ON business_errors(service,occurred_at DESC);
CREATE INDEX IF NOT EXISTS business_errors_asset_time_idx ON business_errors(asset_id,occurred_at DESC) WHERE asset_id IS NOT NULL;
