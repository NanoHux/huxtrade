import { pool } from "./index.js";

await pool.query(`
  INSERT INTO assets(code, binance_symbol, coinglass_symbol, variational_url, collect_enabled, signal_enabled, trade_enabled)
  VALUES ('BTC', 'BTCUSDT', 'BTCUSDT', 'https://trade.variational.io/markets/btc', true, true, false),
         ('ETH', 'ETHUSDT', 'ETHUSDT', 'https://trade.variational.io/markets/eth', true, true, false),
         ('SOL', 'SOLUSDT', 'SOLUSDT', 'https://trade.variational.io/markets/sol', true, true, false)
  ON CONFLICT (code) DO NOTHING;
  INSERT INTO strategies(name, enabled, logic, required_count, conditions, heatmap_range, max_orders_per_side)
  VALUES ('Default Four-Factor', true, 'AND', 4, ARRAY['OI','CVD','FUNDING','HEATMAP'], '24h', 5)
  ON CONFLICT DO NOTHING;
`);
console.log("seed complete");
await pool.end();

