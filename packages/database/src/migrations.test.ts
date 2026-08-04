import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

const migrationDirectory=fileURLToPath(new URL("../migrations",import.meta.url));

async function applyMigrations(db:PGlite){
  const names=(await readdir(migrationDirectory)).filter((name)=>name.endsWith(".sql")).sort();
  for(const name of names){
    const sql=(await readFile(join(migrationDirectory,name),"utf8"))
      // PGlite does not ship optional extension control files. PostgreSQL 13+
      // exposes gen_random_uuid() in core, so only extension installation is skipped.
      .replace(/^CREATE EXTENSION IF NOT EXISTS pgcrypto;\s*/m,"");
    await db.exec(sql);
  }
}

describe("PostgreSQL migrations",()=>{
  it("apply twice and enforce the V1 audit constraints",async()=>{
    const db=new PGlite();
    try{
      await applyMigrations(db);
      await applyMigrations(db);

      const tables=await db.query<{table_name:string}>(`SELECT table_name FROM information_schema.tables
        WHERE table_schema='public' ORDER BY table_name`);
      expect(tables.rows.map((row)=>row.table_name)).toEqual(expect.arrayContaining([
        "assets","strategies","indicator_snapshots","metric_baselines","scan_runs",
        "heatmap_candidates","signals","orders","order_events","positions","fills",
        "notification_preferences","service_health","business_errors","app_state","outbox"
      ]));

      const state=await db.query<{key:string}>("SELECT key FROM app_state ORDER BY key");
      expect(state.rows.map((row)=>row.key)).toEqual(expect.arrayContaining([
        "account_risk","global_pause","signal_cursor","variational_session"
      ]));
      const preferences=await db.query<{count:number}>("SELECT count(*)::int count FROM notification_preferences");
      expect(preferences.rows[0]?.count).toBe(10);

      await db.query(`INSERT INTO strategies(name,enabled,logic,required_count,conditions)
        VALUES('primary',true,'AND',4,ARRAY['OI','CVD','FUNDING','HEATMAP'])`);
      await expect(db.query(`INSERT INTO strategies(name,enabled,logic,required_count,conditions)
        VALUES('second',true,'AND',4,ARRAY['OI','CVD','FUNDING','HEATMAP'])`)).rejects.toThrow();

      const asset=await db.query<{id:string}>(`INSERT INTO assets(code,binance_symbol,coinglass_symbol,variational_url)
        VALUES('BTC','BTCUSDT','BTCUSDT','https://trade.variational.io/markets/btc') RETURNING id`);
      const assetId=asset.rows[0]!.id;
      await db.query("INSERT INTO metric_baselines(asset_id,metric,observed_at,value,source) VALUES($1,'OI_RAW',now(),1,'TEST')",[assetId]);
      await expect(db.query("INSERT INTO metric_baselines(asset_id,metric,observed_at,value,source) VALUES($1,'INVALID',now(),1,'TEST')",[assetId])).rejects.toThrow();
      await db.query("DELETE FROM assets WHERE id=$1",[assetId]);
      const baselines=await db.query<{count:number}>("SELECT count(*)::int count FROM metric_baselines");
      expect(baselines.rows[0]?.count).toBe(0);

      const strategy=await db.query<{id:string}>("SELECT id FROM strategies WHERE name='primary'");
      const eth=await db.query<{id:string}>(`INSERT INTO assets(code,binance_symbol,coinglass_symbol,variational_url)
        VALUES('ETH','ETHUSDT','ETHUSDT','https://trade.variational.io/markets/eth') RETURNING id`);
      const signal=await db.query<{id:string}>(`INSERT INTO signals(asset_id,strategy_id,closed_at,direction,executable,accepted,conditions)
        VALUES($1,$2,'2026-08-04T00:15:00Z','LONG',true,true,'[]') RETURNING id`,[eth.rows[0]!.id,strategy.rows[0]!.id]);
      await expect(db.query(`INSERT INTO signals(asset_id,strategy_id,closed_at,direction,executable,accepted,conditions)
        VALUES($1,$2,'2026-08-04T00:15:00Z','LONG',true,true,'[]')`,[eth.rows[0]!.id,strategy.rows[0]!.id])).rejects.toThrow();
      await db.query(`INSERT INTO signals(asset_id,strategy_id,closed_at,direction,executable,accepted,conditions)
        VALUES($1,$2,'2026-08-04T00:15:00Z','SHORT',true,true,'[]')`,[eth.rows[0]!.id,strategy.rows[0]!.id]);

      const order=await db.query<{id:string}>(`INSERT INTO orders(signal_id,asset_id,strategy_id,idempotency_key,direction,state,entry_price,stop_loss,take_profit,margin_usdc,leverage)
        VALUES($1,$2,$3,'stable-key','LONG','FILLED_OPEN',100,90,115,10,5) RETURNING id`,[signal.rows[0]!.id,eth.rows[0]!.id,strategy.rows[0]!.id]);
      await expect(db.query(`INSERT INTO orders(asset_id,strategy_id,idempotency_key,direction,state,entry_price,stop_loss,take_profit,margin_usdc,leverage)
        VALUES($1,$2,'stable-key','LONG','CREATED_LOCAL',100,90,115,10,5)`,[eth.rows[0]!.id,strategy.rows[0]!.id])).rejects.toThrow();
      const position=await db.query<{id:string}>(`INSERT INTO positions(order_id,platform_position_id,asset_id,direction,quantity,entry_price,opened_at)
        VALUES($1,'position-1',$2,'LONG',0.5,100,'2026-08-04T00:16:00Z') RETURNING id`,[order.rows[0]!.id,eth.rows[0]!.id]);
      await expect(db.query(`INSERT INTO positions(order_id,platform_position_id,asset_id,direction,quantity,entry_price,opened_at)
        VALUES($1,'position-2',$2,'LONG',0.5,100,'2026-08-04T00:16:00Z')`,[order.rows[0]!.id,eth.rows[0]!.id])).rejects.toThrow();
      await db.query(`INSERT INTO fills(order_id,position_id,platform_fill_id,side,price,quantity,filled_at)
        VALUES($1,$2,'fill-1','BUY',100,0.5,'2026-08-04T00:16:00Z')`,[order.rows[0]!.id,position.rows[0]!.id]);
      await expect(db.query(`INSERT INTO fills(order_id,position_id,platform_fill_id,side,price,quantity,filled_at)
        VALUES($1,$2,'fill-1','BUY',100,0.5,'2026-08-04T00:16:00Z')`,[order.rows[0]!.id,position.rows[0]!.id])).rejects.toThrow();
    }finally{await db.close();}
  },20_000);
});
