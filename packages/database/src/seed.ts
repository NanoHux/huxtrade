import { pool } from "./index.js";

await pool.query(`
  INSERT INTO assets(code, binance_symbol, coinglass_symbol, coinglass_url, variational_url, collect_enabled, signal_enabled, trade_enabled)
  VALUES ('BTC', 'BTCUSDT', 'Binance_BTCUSDT', 'https://www.coinglass.com/pro/futures/LiquidationHeatMap?coin=BTC&type=pair', 'https://omni.variational.io/perpetual/BTC', true, true, false),
         ('ETH', 'ETHUSDT', 'Binance_ETHUSDT', 'https://www.coinglass.com/pro/futures/LiquidationHeatMap?coin=ETH&type=pair', 'https://omni.variational.io/perpetual/ETH', true, true, false),
         ('SOL', 'SOLUSDT', 'Binance_SOLUSDT', 'https://www.coinglass.com/pro/futures/LiquidationHeatMap?coin=SOL&type=pair', 'https://omni.variational.io/perpetual/SOL', true, true, false)
  ON CONFLICT (code) DO NOTHING;
  INSERT INTO strategies(name, enabled, logic, required_count, conditions, heatmap_range, max_orders_per_side)
  VALUES ('Default Four-Factor', true, 'AND', 4, ARRAY['OI','CVD','FUNDING','HEATMAP'], '24h', 5)
  ON CONFLICT DO NOTHING;
`);
console.log("seed complete");
await pool.end();
