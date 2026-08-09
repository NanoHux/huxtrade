import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

const migrationDirectory=fileURLToPath(new URL("../migrations",import.meta.url));

async function applyMigrations(db:PGlite,upTo?:string){
  const names=(await readdir(migrationDirectory)).filter((name)=>name.endsWith(".sql")).sort();
  for(const name of names){
    if(upTo&&name>upTo)break;
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
        "heatmap_candidates","coinglass_heatmaps","signals","orders","order_events","positions","fills",
        "notification_preferences","service_health","business_errors","app_state","outbox","entry_plans"
      ]));

      const state=await db.query<{key:string}>("SELECT key FROM app_state ORDER BY key");
      expect(state.rows.map((row)=>row.key)).toEqual(expect.arrayContaining([
        "account_risk","coinglass_session","global_pause","signal_cursor","variational_session"
      ]));
      const session=await db.query<{reconciled:boolean}>("SELECT (value->>'reconciled')::boolean reconciled FROM app_state WHERE key='variational_session'");
      expect(session.rows[0]?.reconciled).toBe(false);
      const preferences=await db.query<{count:number}>("SELECT count(*)::int count FROM notification_preferences");
      expect(preferences.rows[0]?.count).toBe(18);
      const replaced=await db.query<{enabled:boolean}>("SELECT enabled FROM notification_preferences WHERE event_type='resting_order_replaced'");
      expect(replaced.rows[0]?.enabled).toBe(false);
      // 014 hands over a switch without flipping it: venue limits keep
      // notifying until the operator decides otherwise.
      const venue=await db.query<{enabled:boolean}>("SELECT enabled FROM notification_preferences WHERE event_type='venue_limit_rejected'");
      expect(venue.rows[0]?.enabled).toBe(true);

      await db.query(`INSERT INTO strategies(name,enabled,logic,required_count,conditions)
        VALUES('primary',true,'AND',4,ARRAY['OI','CVD','FUNDING','HEATMAP'])`);
      await expect(db.query(`INSERT INTO strategies(name,enabled,logic,required_count,conditions)
        VALUES('second',true,'AND',4,ARRAY['OI','CVD','FUNDING','HEATMAP'])`)).rejects.toThrow();

      const asset=await db.query<{id:string}>(`INSERT INTO assets(code,binance_symbol,coinglass_symbol,coinglass_url,variational_url)
        VALUES('BTC','BTCUSDT','Binance_BTCUSDT','https://www.coinglass.com/pro/futures/LiquidationHeatMap?coin=BTC&type=pair','https://trade.variational.io/markets/btc') RETURNING id`);
      const assetId=asset.rows[0]!.id;
      await db.query("INSERT INTO metric_baselines(asset_id,metric,observed_at,value,source) VALUES($1,'OI_RAW',now(),1,'TEST')",[assetId]);
      await expect(db.query("INSERT INTO metric_baselines(asset_id,metric,observed_at,value,source) VALUES($1,'INVALID',now(),1,'TEST')",[assetId])).rejects.toThrow();
      await db.query("DELETE FROM assets WHERE id=$1",[assetId]);
      const baselines=await db.query<{count:number}>("SELECT count(*)::int count FROM metric_baselines");
      expect(baselines.rows[0]?.count).toBe(0);

      const strategy=await db.query<{id:string}>("SELECT id FROM strategies WHERE name='primary'");
      const eth=await db.query<{id:string}>(`INSERT INTO assets(code,binance_symbol,coinglass_symbol,coinglass_url,variational_url)
        VALUES('ETH','ETHUSDT','Binance_ETHUSDT','https://www.coinglass.com/pro/futures/LiquidationHeatMap?coin=ETH&type=pair','https://trade.variational.io/markets/eth') RETURNING id`);
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

  it("009 splits aggregate-copied PnL across stacked orders and closes stale position rows",async()=>{
    const db=new PGlite();
    try{
      // Reproduce the pre-009 damage: 4 stacked XPL shorts each carrying the
      // platform aggregate (qty 2660, upnl -3.907, realized -0.7032) plus a
      // reversed order whose position row froze open with stale unrealized.
      await applyMigrations(db,"008");
      await db.query(`INSERT INTO strategies(name,enabled,logic,required_count,conditions) VALUES('s',true,'AND',2,ARRAY['OI','CVD'])`);
      await db.query(`INSERT INTO assets(code,binance_symbol,coinglass_symbol,coinglass_url,variational_url)
        VALUES('XPL','XPLUSDT','Binance_XPLUSDT','https://example.com','https://example.com')`);
      const ids=await db.query<{aid:string;sid:string}>("SELECT a.id::text aid,s.id::text sid FROM assets a,strategies s");
      const {aid,sid}=ids.rows[0]!;
      for(let i=0;i<4;i+=1){
        const order=await db.query<{id:string}>(`INSERT INTO orders(asset_id,strategy_id,idempotency_key,direction,state,entry_price,stop_loss,take_profit,margin_usdc,leverage,realized_pnl)
          VALUES($1,$2,$3,'SHORT','FILLED_OPEN',0.0751,0.07703,0.0731,10,5,-0.7032) RETURNING id`,[aid,sid,`stack-${i}`]);
        await db.query(`INSERT INTO positions(order_id,platform_position_id,asset_id,direction,quantity,entry_price,unrealized_pnl,realized_pnl,opened_at)
          VALUES($1,'agg-pos',$2,'SHORT',2660,0.0751,-3.907,0.008,'2026-08-06T18:16:44Z')`,[order.rows[0]!.id,aid]);
      }
      const reversed=await db.query<{id:string}>(`INSERT INTO orders(asset_id,strategy_id,idempotency_key,direction,state,entry_price,stop_loss,take_profit,margin_usdc,leverage,realized_pnl)
        VALUES($1,$2,'reversed-1','SHORT','CLOSED_REVERSED',0.0762,0.0781,0.0741,10,5,-0.35) RETURNING id`,[aid,sid]);
      await db.query(`INSERT INTO positions(order_id,platform_position_id,asset_id,direction,quantity,entry_price,unrealized_pnl,opened_at)
        VALUES($1,'agg-pos',$2,'SHORT',1330,0.0762,-1.2,'2026-08-06T16:16:22Z')`,[reversed.rows[0]!.id,aid]);

      await applyMigrations(db);

      const stacked=await db.query<{realized:number;quantity:number;upnl:number}>(`SELECT o.realized_pnl::float realized,p.quantity::float quantity,p.unrealized_pnl::float upnl
        FROM orders o JOIN positions p ON p.order_id=o.id WHERE o.state='FILLED_OPEN'`);
      expect(stacked.rows).toHaveLength(4);
      for(const row of stacked.rows){
        expect(row.realized).toBeCloseTo(-0.7032/4,9);
        expect(row.quantity).toBeCloseTo(665,9);
        expect(row.upnl).toBeCloseTo(-3.907/4,9);
      }
      const closed=await db.query<{closed_at:string|null;upnl:number|null;quantity:number;realized:number}>(`SELECT p.closed_at,p.unrealized_pnl::float upnl,p.quantity::float quantity,o.realized_pnl::float realized
        FROM positions p JOIN orders o ON o.id=p.order_id WHERE o.state='CLOSED_REVERSED'`);
      expect(closed.rows[0]!.closed_at).not.toBeNull();
      expect(closed.rows[0]!.upnl).toBeNull();
      expect(closed.rows[0]!.quantity).toBeCloseTo(1330,9);
      expect(closed.rows[0]!.realized).toBeCloseTo(-0.35,9);
      const misses=await db.query<{reconcile_misses:number}>("SELECT reconcile_misses FROM orders LIMIT 1");
      expect(misses.rows[0]!.reconcile_misses).toBe(0);
    }finally{await db.close();}
  },20_000);

  it("010 defaults existing orders to the market-on-signal path and opens the entry_plans ledger",async()=>{
    const db=new PGlite();
    try{
      await applyMigrations(db);
      await db.query(`INSERT INTO strategies(name,enabled,logic,required_count,conditions) VALUES('s',true,'AND',2,ARRAY['OI','CVD'])`);
      await db.query(`INSERT INTO assets(code,binance_symbol,coinglass_symbol,coinglass_url,variational_url)
        VALUES('SOL','SOLUSDT','Binance_SOLUSDT','https://example.com','https://example.com')`);
      const ids=await db.query<{aid:string;sid:string}>("SELECT a.id::text aid,s.id::text sid FROM assets a,strategies s");
      const {aid,sid}=ids.rows[0]!;
      const insertOrder=(key:string,kind?:string)=>db.query<{id:string}>(
        `INSERT INTO orders(asset_id,strategy_id,idempotency_key,direction,state,entry_price,stop_loss,take_profit,margin_usdc,leverage${kind?",entry_kind":""})
         VALUES($1,$2,$3,'LONG','PENDING_ENTRY',100,95,110,10,5${kind?",$4":""}) RETURNING id`,kind?[aid,sid,key,kind]:[aid,sid,key]);

      const legacy=await insertOrder("legacy-1");
      const kinds=await db.query<{entry_kind:string;revalidated_at:string|null;replaced_by:string|null}>("SELECT entry_kind,revalidated_at,replaced_by FROM orders");
      expect(kinds.rows[0]).toMatchObject({entry_kind:"MARKET_ON_SIGNAL",revalidated_at:null,replaced_by:null});
      await expect(insertOrder("bad-kind","MARKET")).rejects.toThrow();

      const resting=await insertOrder("resting-1","RESTING_LIMIT");
      await db.query("UPDATE orders SET state='CANCELLED_REPLACED',replaced_by=$1,revalidated_at=now(),entry_provenance=$2 WHERE id=$3",
        [resting.rows[0]!.id,JSON.stringify({sources:["HEATMAP","SWING"],level:97.2}),legacy.rows[0]!.id]);
      const linked=await db.query<{sources:string}>("SELECT entry_provenance->>'sources' sources FROM orders WHERE replaced_by=$1",[resting.rows[0]!.id]);
      expect(linked.rows).toHaveLength(1);
      expect(JSON.parse(linked.rows[0]!.sources)).toEqual(["HEATMAP","SWING"]);

      // A no-op scan still gets a row, and it carries no level at all.
      await db.query(`INSERT INTO entry_plans(asset_id,closed_at,decision,decision_reason,mode)
        VALUES($1,'2026-08-07T00:15:00Z','NONE','no armed direction bias this scan','shadow')`,[aid]);
      await db.query(`INSERT INTO entry_plans(asset_id,closed_at,direction,level,stop_loss,take_profit,expected_rr,provenance,decision,decision_reason,working_order_id,mode)
        VALUES($1,'2026-08-07T00:30:00Z','LONG',97.2,95,104.7,3.409,'{"sources":["HEATMAP"]}','PLACE','new LONG resting entry at 97.2',$2,'live')`,[aid,resting.rows[0]!.id]);
      // 012: the reversal exit is a recorded decision, not an invisible side effect.
      await db.query(`INSERT INTO entry_plans(asset_id,closed_at,direction,decision,decision_reason,mode)
        VALUES($1,'2026-08-07T01:00:00Z','SHORT','CLOSE_OPPOSITE','bias is SHORT while an open LONG position remains','live')`,[aid]);
      // One decision per asset per scan — a replayed scan can never double-book.
      await expect(db.query(`INSERT INTO entry_plans(asset_id,closed_at,decision,decision_reason,mode)
        VALUES($1,'2026-08-07T00:30:00Z','KEEP','duplicate','live')`,[aid])).rejects.toThrow();
      await expect(db.query(`INSERT INTO entry_plans(asset_id,closed_at,decision,decision_reason,mode)
        VALUES($1,'2026-08-07T00:45:00Z','HOLD','not a valid decision','live')`,[aid])).rejects.toThrow();
      await expect(db.query(`INSERT INTO entry_plans(asset_id,closed_at,decision,decision_reason,mode)
        VALUES($1,'2026-08-07T00:45:00Z','KEEP','bad mode','paper')`,[aid])).rejects.toThrow();

      // Purging orders keeps the ledger — the decision record outlives the
      // order it produced — but purging the asset takes the ledger with it.
      // 013: bias survives a restart, beside the cursor it shares a boundary with.
      await db.query(`INSERT INTO asset_signal_cursors(asset_id,closed_at,bias_direction,bias_armed_at,bias_armed_until,bias_strength)
        VALUES($1,'2026-08-07T00:00:00Z','LONG','2026-08-07T00:00:00Z','2026-08-07T01:00:00Z',3.5)
        ON CONFLICT(asset_id) DO UPDATE SET bias_direction=EXCLUDED.bias_direction,bias_armed_until=EXCLUDED.bias_armed_until`,[aid]);
      const bias=await db.query<{bias_direction:string;bias_strength:string}>("SELECT bias_direction,bias_strength FROM asset_signal_cursors WHERE asset_id=$1",[aid]);
      expect(bias.rows[0]).toMatchObject({bias_direction:"LONG"});
      await expect(db.query("UPDATE asset_signal_cursors SET bias_direction='SIDEWAYS' WHERE asset_id=$1",[aid])).rejects.toThrow();
      // 013: the entry model is selectable, defaulting to the path running today.
      const entryKinds=await db.query<{entry_kind:string}>("SELECT entry_kind FROM strategies");
      expect(entryKinds.rows[0]?.entry_kind).toBe("MARKET_ON_SIGNAL");
      await db.query("UPDATE strategies SET entry_kind='RESTING_LIMIT'");
      await expect(db.query("UPDATE strategies SET entry_kind='LIMIT'")).rejects.toThrow();

      // 011: an untouched strategy stores no overrides at all, so a default
      // that changes in code still reaches it.
      const settings=await db.query<{resting_entry:Record<string,number>}>("SELECT resting_entry FROM strategies");
      expect(settings.rows[0]!.resting_entry).toEqual({});
      await db.query(`UPDATE strategies SET resting_entry='{"maxArmedAssets":8}'::jsonb`);
      const overridden=await db.query<{armed:string}>("SELECT resting_entry->>'maxArmedAssets' armed FROM strategies");
      expect(overridden.rows[0]!.armed).toBe("8");

      await db.query("DELETE FROM orders WHERE asset_id=$1",[aid]);
      const orphaned=await db.query<{count:number}>("SELECT count(*)::int count FROM entry_plans WHERE working_order_id IS NULL");
      expect(orphaned.rows[0]?.count).toBe(3);
      await db.query("DELETE FROM assets WHERE id=$1",[aid]);
      const remaining=await db.query<{count:number}>("SELECT count(*)::int count FROM entry_plans");
      expect(remaining.rows[0]?.count).toBe(0);
    }finally{await db.close();}
  },20_000);
});
