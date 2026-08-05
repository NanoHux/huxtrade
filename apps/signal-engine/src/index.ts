import { fixedRules, getConfig } from "@huxtrade/config";
import { pool, query, recordHealth, transaction } from "@huxtrade/database";
import { BinanceFuturesClient } from "@huxtrade/exchange-clients";
import { atr, findAtrSwing } from "@huxtrade/indicators";
import { candidateDirections, directionAllowed, evaluateConditions, heatmapEntryState, makeOrderPlan, riskGate } from "@huxtrade/strategy-engine";
import type { ConditionResult, Direction, HeatmapRegion, OrderPlan, Strategy } from "@huxtrade/shared-types";
import { timestampIso } from "./time.js";

const config=getConfig();
const binance=new BinanceFuturesClient();
const sleep=(ms:number)=>new Promise((resolve)=>setTimeout(resolve,ms));
let initialized=false;

function strategyFromRow(row:Record<string,unknown>):Strategy{
  return {id:String(row.id),name:String(row.name),enabled:true,logic:row.logic as "AND"|"N_OF_M",requiredCount:Number(row.required_count||0)||null,conditions:row.conditions as Strategy["conditions"],heatmapRange:row.heatmap_range as Strategy["heatmapRange"],maxOrdersPerSide:Number(row.max_orders_per_side)};
}

async function decideHeatmap(input:{row:Record<string,unknown>;strategy:Strategy;direction:Direction;baseValid:boolean}){
  const regions=Array.isArray(input.row.heatmap)?input.row.heatmap as HeatmapRegion[]:[];
  const strongest=[...regions].sort((a,b)=>b.intensity-a.intensity)[0];
  let active=(await query<Record<string,unknown>>(`SELECT * FROM heatmap_candidates WHERE asset_id=$1 AND strategy_id=$2 AND direction=$3 AND status IN ('ARMED','CONFIRMED') ORDER BY created_at DESC LIMIT 1`,[input.row.asset_id,input.strategy.id,input.direction])).rows[0];
  const regionStillEligible=(candidate:Record<string,unknown>)=>regions.some((region)=>
    region.lowPrice<=Number(candidate.region_high)&&region.highPrice>=Number(candidate.region_low));
  if(active?.status==="CONFIRMED"){
    const valid=input.baseValid&&Boolean(input.row.warmup_ready)&&regionStillEligible(active),inside=Number(input.row.price)>=Number(active.region_low)&&Number(input.row.price)<=Number(active.region_high);
    if(valid&&inside)return {state:"CONFIRMED" as const,reason:"CONFIRMED_REGION_STILL_ACTIVE",regions};
    await query("UPDATE heatmap_candidates SET status='INVALIDATED',invalid_reason=$1 WHERE id=$2",[valid?"PRICE_EXITED_REGION":"CONDITIONS_INVALID",active.id]);active=undefined;
  }
  if(!strongest&&!active)return {state:"INVALIDATED" as const,reason:"NO_ELIGIBLE_REGION",regions};
  const candidateRegion=active?{price:Number(active.region_price),lowPrice:Number(active.region_low),highPrice:Number(active.region_high),intensity:Number(active.intensity),rank:1,percentile:1}:strongest!;
  const decision=heatmapEntryState({region:candidateRegion,price:Number(input.row.price),closedAt:new Date(String(input.row.closed_at)).toISOString(),armedAt:active?new Date(String(active.entered_at)).toISOString():null,confirmAfter:active?.confirm_after?new Date(String(active.confirm_after)).toISOString():null,conditionsValid:input.baseValid&&Boolean(input.row.warmup_ready)&&(!active||regionStillEligible(active))});
  if(decision.state==="ARMED"&&!active){
    await query(`INSERT INTO heatmap_candidates(asset_id,strategy_id,direction,region_price,region_low,region_high,intensity,entered_at,confirm_after)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8::timestamptz+interval '15 minutes') ON CONFLICT DO NOTHING`,[input.row.asset_id,input.strategy.id,input.direction,candidateRegion.price,candidateRegion.lowPrice,candidateRegion.highPrice,candidateRegion.intensity,input.row.closed_at]);
  }else if(decision.state==="CONFIRMED"&&active){
    await query("UPDATE heatmap_candidates SET status='CONFIRMED',confirmed_at=$1 WHERE id=$2",[input.row.closed_at,active.id]);
  }else if(decision.state==="INVALIDATED"&&active){
    await query("UPDATE heatmap_candidates SET status='INVALIDATED',invalid_reason=$1 WHERE id=$2",[decision.reason,active.id]);
  }
  return {...decision,regions};
}

async function run(){
  try{
    const strategyRow=(await query<Record<string,unknown>>("SELECT * FROM strategies WHERE enabled=true LIMIT 1")).rows[0];
    if(!strategyRow){await recordHealth("signal-engine",true);return;}
    const strategy=strategyFromRow(strategyRow);
    const [global,risk,session,cursorResult,latestResult]=await Promise.all([
      query<{value:Record<string,unknown>}>("SELECT value FROM app_state WHERE key='global_pause'"),
      query<{value:Record<string,unknown>}>("SELECT value FROM app_state WHERE key='account_risk'"),
      query<{value:Record<string,unknown>}>("SELECT value FROM app_state WHERE key='variational_session'"),
      query<{value:Record<string,unknown>}>("SELECT value FROM app_state WHERE key='signal_cursor'"),
      query<{closed_at:string}>("SELECT max(closed_at)::text closed_at FROM indicator_snapshots")
    ]);
    const latestClosedAt=timestampIso(latestResult.rows[0]?.closed_at);
    const cursor=timestampIso(cursorResult.rows[0]?.value.closedAt);
    const advanceCursor=async(closedAt:string|null)=>{if(closedAt)await query("INSERT INTO app_state(key,value) VALUES('signal_cursor',$1) ON CONFLICT(key) DO UPDATE SET value=$1,updated_at=now()",[JSON.stringify({closedAt})]);};
    if(!initialized||!cursor){const alignedNow=new Date(Math.floor(Date.now()/(15*60_000))*(15*60_000)).toISOString();await advanceCursor(latestClosedAt??alignedNow);initialized=true;await recordHealth("signal-engine",true);return;}
    if(Boolean(global.rows[0]?.value.paused)||Boolean(risk.rows[0]?.value.autoPaused)){await advanceCursor(latestClosedAt);await recordHealth("signal-engine",true);return;}
    const snapshots=await query<Record<string,unknown>>(`SELECT i.*,a.code,a.binance_symbol,a.paused,a.trade_enabled FROM indicator_snapshots i JOIN assets a ON a.id=i.asset_id LEFT JOIN asset_signal_cursors c ON c.asset_id=i.asset_id
      WHERE a.signal_enabled=true AND a.paused=false AND i.closed_at>greatest($1::timestamptz,coalesce(c.closed_at,'epoch'::timestamptz))
      ORDER BY i.closed_at LIMIT 100`,[cursor]);
    for(const row of snapshots.rows){
      const dataFresh=Date.now()-new Date(String(row.closed_at)).getTime()<fixedRules.binanceStaleMs;
      // Spec 4.3: a stale snapshot pauses the asset. Evaluating it anyway would
      // only write audit noise, so the bar is skipped after the cursor moves on.
      if(!dataFresh){
        await transaction(async(client)=>{
          await client.query("UPDATE assets SET paused=true,pause_reason='STALE_BINANCE_SNAPSHOT',updated_at=now() WHERE id=$1",[row.asset_id]);
          await client.query("INSERT INTO asset_signal_cursors(asset_id,closed_at) VALUES($1,$2) ON CONFLICT(asset_id) DO UPDATE SET closed_at=EXCLUDED.closed_at,updated_at=now()",[row.asset_id,row.closed_at]);
          await client.query("UPDATE heatmap_candidates SET status='INVALIDATED',invalid_reason='STALE_BINANCE_SNAPSHOT' WHERE asset_id=$1 AND status IN ('ARMED','CONFIRMED')",[row.asset_id]);
          await client.query("INSERT INTO outbox(topic,payload) VALUES('notification.system_error',$1)",[JSON.stringify({asset:row.code,reason:"STALE_BINANCE_SNAPSHOT",closedAt:row.closed_at})]);
        });
        continue;
      }
      const derived:Direction=row.cvd_direction==="SHORT"?"SHORT":"LONG";
      const directions=candidateDirections({cvdSelected:strategy.conditions.includes("CVD"),cvdPassed:Boolean(row.cvd_passed),cvdDirection:row.cvd_direction==="LONG"||row.cvd_direction==="SHORT"?row.cvd_direction:null});
      let hourCandles:Awaited<ReturnType<typeof binance.klines>>|undefined;
      for(const direction of directions){
        const rawConditions:ConditionResult[]=[
          {type:"OI",passed:Boolean(row.oi_passed),value:Number(row.oi_change_1h),zScore:Number(row.oi_z),reason:Boolean(row.oi_passed)?"1h OI anomaly and 2-of-3 direction confirmed":"OI 1h threshold/confirmation not met"},
          {type:"CVD",passed:Boolean(row.cvd_passed)&&derived===direction,value:Number(row.cvd_value),zScore:Number(row.cvd_z),direction,reason:Boolean(row.cvd_passed)&&derived===direction?"15m CVD anomaly and 2-of-3 5m direction confirmed":"CVD threshold/confirmation not met"},
          {type:"FUNDING",passed:Boolean(row.funding_passed),value:Number(row.funding_value),zScore:Math.max(Math.abs(Number(row.funding_z)),Math.abs(Number(row.funding_change_z))),reason:Boolean(row.funding_passed)?"Funding level or 4h amplitude is anomalous":"Funding anomaly not met"},
          {type:"HEATMAP",passed:Boolean(row.heatmap_passed),reason:Boolean(row.heatmap_passed)?"Eligible Binance heatmap region exists":"No eligible heatmap region"}
        ];
        const baseConditionsPass=evaluateConditions(strategy,rawConditions);
        const btcPass=directionAllowed(row.btc_regime as "BULL"|"BEAR"|"RANGE"|"TRANSITION",direction);
        const heatmap=strategy.conditions.includes("HEATMAP")?await decideHeatmap({row,strategy,direction,baseValid:baseConditionsPass&&btcPass}):{state:"CONFIRMED" as const,reason:"HEATMAP_NOT_SELECTED",regions:Array.isArray(row.heatmap)?row.heatmap as HeatmapRegion[]:[]};
        const conditions=rawConditions.map((condition)=>condition.type==="HEATMAP"?{...condition,passed:heatmap.state==="CONFIRMED",reason:heatmap.reason}:condition);
        const conditionPass=evaluateConditions(strategy,conditions);
        const concurrent=await query<{count:string}>(`SELECT count(*)::text count FROM orders WHERE asset_id=$1 AND direction=$2 AND state IN ('CREATED_LOCAL','SUBMITTING','PENDING_ENTRY','FILLED_OPEN','UNKNOWN','RECONCILIATION_REQUIRED')`,[row.asset_id,direction]);
        const sessionReady=Boolean(session.rows[0]?.value.loggedIn)&&Boolean(session.rows[0]?.value.reconciled);
        const gate=riskGate({globalPaused:Boolean(global.rows[0]?.value.paused),assetPaused:Boolean(row.paused)||!dataFresh,dataFresh,sessionValid:sessionReady,liveTrading:config.LIVE_TRADING_ENABLED&&Boolean(row.trade_enabled),marginUsage:Number(risk.rows[0]?.value.marginUsagePercent??0),marginAutoPaused:Boolean(risk.rows[0]?.value.autoPaused),concurrentOrders:Number(concurrent.rows[0]?.count??0),maxOrders:strategy.maxOrdersPerSide});
        const accepted=conditionPass&&btcPass&&Boolean(row.warmup_ready);
        const conditionRejections=conditions
          .filter((condition)=>strategy.conditions.includes(condition.type)&&!condition.passed)
          .map((condition)=>condition.type==="HEATMAP"?`HEATMAP_${heatmap.state}`:`CONDITION_${condition.type}_FAILED`);
        let plan:OrderPlan|undefined;
        const planRejections:string[]=[];
        if(accepted&&gate.passed){
          try{
            const [candles,entryPrice]=await Promise.all([
              hourCandles?Promise.resolve(hourCandles):binance.klines(String(row.binance_symbol),"1h",100),
              binance.latestPrice(String(row.binance_symbol))
            ]);
            hourCandles=candles;
            const atrValue=atr(candles,14).at(-1)!;
            plan=makeOrderPlan({symbol:String(row.binance_symbol),direction,closedAt:new Date(String(row.closed_at)).toISOString(),entryPrice,swing:findAtrSwing(candles,atrValue,direction),atr1h:atrValue,regions:heatmap.regions,marginUsdc:config.DEFAULT_MARGIN_USDC,leverage:config.LEVERAGE});
          }catch(error){planRejections.push(`ORDER_PLAN_FAILED: ${error instanceof Error?error.message:String(error)}`);}
        }
        const executable=accepted&&gate.passed&&Boolean(plan);
        const rejectionReasons=[...(!row.warmup_ready?["INDICATOR_WARMUP"]:[]),...conditionRejections,...(!btcPass?["BTC_DIRECTION_FILTER"]:[]),...gate.reasons,...planRejections];
        await transaction(async(client)=>{
          const signal=await client.query(`INSERT INTO signals(asset_id,strategy_id,closed_at,direction,executable,accepted,conditions,rejection_reasons) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING id`,[row.asset_id,strategy.id,row.closed_at,direction,executable,accepted,JSON.stringify(conditions),rejectionReasons]);
          if(!signal.rows[0])return;
          if(accepted)await client.query("INSERT INTO outbox(topic,payload) VALUES('notification.signal',$1)",[JSON.stringify({symbol:row.code,direction,accepted,executable,rejectionReasons})]);
          if(!plan||!executable)return;
          const order=await client.query(`INSERT INTO orders(signal_id,asset_id,strategy_id,idempotency_key,direction,state,entry_price,stop_loss,take_profit,margin_usdc,leverage) VALUES($1,$2,$3,$4,$5,'CREATED_LOCAL',$6,$7,$8,$9,$10) ON CONFLICT(idempotency_key) DO NOTHING RETURNING id`,[signal.rows[0].id,row.asset_id,strategy.id,plan.idempotencyKey,direction,plan.entryPrice,plan.stopLoss,plan.takeProfit,plan.marginUsdc,plan.leverage]);
          if(order.rows[0]){await client.query("INSERT INTO order_events(order_id,from_state,to_state,reason,payload) VALUES($1,NULL,'CREATED_LOCAL','signal accepted',$2)",[order.rows[0].id,JSON.stringify(plan)]);await client.query("INSERT INTO outbox(topic,payload) VALUES('order.submit',$1)",[JSON.stringify({orderId:order.rows[0].id,plan})]);}
        });
      }
      await query("INSERT INTO asset_signal_cursors(asset_id,closed_at) VALUES($1,$2) ON CONFLICT(asset_id) DO UPDATE SET closed_at=EXCLUDED.closed_at,updated_at=now()",[row.asset_id,row.closed_at]);
    }
    if(snapshots.rows.length)await advanceCursor(timestampIso(snapshots.rows.at(-1)!.closed_at));
    await recordHealth("signal-engine",true);
  }catch(error){await recordHealth("signal-engine",false,error,true);}
}

process.on("SIGTERM",async()=>{await pool.end();process.exit(0);});
while(true){await run();await sleep(30_000);}
