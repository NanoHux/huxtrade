import { fixedRules, getConfig } from "@huxtrade/config";
import { claimRestartRequest, pool, query, recordHealth, transaction } from "@huxtrade/database";
import { BinanceFuturesClient,variationalUnderlying } from "@huxtrade/exchange-clients";
import { atr, findAtrSwing } from "@huxtrade/indicators";
import { candidateDirections, directionAllowed, directionAllowedAfterMove, evaluateConditions, haltedDirections, heatmapEntryState, makeOrderPlan, neutralBias, resolveRestingEntry, riskGate, type BiasState, type WorkingRestingOrder } from "@huxtrade/strategy-engine";
import type { ConditionResult, Direction, HeatmapRegion, OrderPlan, Strategy } from "@huxtrade/shared-types";
import { decideRestingScan, restingOutboxMessage, type RestingAssetInput } from "./resting.js";
import { timestampIso } from "./time.js";

const config=getConfig();
const binance=new BinanceFuturesClient();
// 1h candles only gain a bar once an hour, but the resting model revalidates
// every 15 minutes — refetching them each scan was four times the Binance
// budget for identical data. Binance rate-limits per IP across every service,
// and the collector's own aggregate-trade pagination on high-volume assets
// already dominates that budget, so this stays cached until the hour turns.
// The still-forming bar is therefore up to 45 minutes stale; it moves ATR by
// at most 1/14 of one bar's range and the swing scan skips it entirely.
const hourCandleCache=new Map<string,{hour:number;candles:Awaited<ReturnType<typeof binance.klines>>}>();
async function hourCandlesFor(symbol:string){
  const hour=Math.floor(Date.now()/3_600_000);
  const cached=hourCandleCache.get(symbol);
  if(cached&&cached.hour===hour)return cached.candles;
  const candles=await binance.klines(symbol,"1h",100);
  hourCandleCache.set(symbol,{hour,candles});
  return candles;
}
const sleep=(ms:number)=>new Promise((resolve)=>setTimeout(resolve,ms));
let initialized=false;

function strategyFromRow(row:Record<string,unknown>):Strategy{
  return {id:String(row.id),name:String(row.name),enabled:true,logic:row.logic as "AND"|"N_OF_M",requiredCount:Number(row.required_count||0)||null,conditions:row.conditions as Strategy["conditions"],heatmapRange:row.heatmap_range as Strategy["heatmapRange"],maxOrdersPerSide:Number(row.max_orders_per_side),entryKind:row.entry_kind==="RESTING_LIMIT"?"RESTING_LIMIT":"MARKET_ON_SIGNAL",restingEntry:resolveRestingEntry(row.resting_entry as Record<string,number>|null)};
}

function biasFromRow(row:Record<string,unknown>):BiasState{
  return row.bias_direction==="LONG"||row.bias_direction==="SHORT"
    ?{direction:row.bias_direction,armedAt:timestampIso(row.bias_armed_at),armedUntil:timestampIso(row.bias_armed_until),
       pendingFlipDirection:row.pending_flip_direction==="LONG"||row.pending_flip_direction==="SHORT"?row.pending_flip_direction:null,
       pendingFlipCount:Number(row.pending_flip_count??0)}
    :neutralBias;
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

/**
 * Persists one batch of resting-model decisions. Every asset gets an
 * entry_plans row on every scan — including KEEP and NONE — because "the
 * model deliberately did nothing" is the observation that distinguishes a
 * working hysteresis band from a candidate search that silently found
 * nothing, and it is the only record shadow mode produces at all.
 *
 * Outbox emission is the single place the shadow/live switch bites: in shadow
 * the ledger is identical and the wire stays empty.
 */
async function runRestingScan(strategy:Strategy,groups:Map<string,RestingAssetInput[]>,signalIds:Map<string,string>){
  for(const [closedAt,assets] of [...groups.entries()].sort(([a],[b])=>a<b?-1:1)){
    const decisions=decideRestingScan(assets,{settings:strategy.restingEntry,mode:config.STRATEGY_EXECUTION_MODE,marginUsdc:config.DEFAULT_MARGIN_USDC,leverage:config.LEVERAGE});
    for(const decision of decisions){
      const message=restingOutboxMessage(decision,{strategyId:strategy.id,signalId:signalIds.get(`${decision.assetId}|${closedAt}`)??null});
      await transaction(async(client)=>{
        await client.query(`INSERT INTO entry_plans(asset_id,closed_at,direction,level,stop_loss,take_profit,expected_rr,provenance,decision,decision_reason,working_order_id,mode)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
          ON CONFLICT(asset_id,closed_at) DO UPDATE SET direction=EXCLUDED.direction,level=EXCLUDED.level,stop_loss=EXCLUDED.stop_loss,
            take_profit=EXCLUDED.take_profit,expected_rr=EXCLUDED.expected_rr,provenance=EXCLUDED.provenance,decision=EXCLUDED.decision,
            decision_reason=EXCLUDED.decision_reason,working_order_id=EXCLUDED.working_order_id,mode=EXCLUDED.mode`,[
          decision.assetId,closedAt,decision.bias.direction,decision.plan?.entryPrice??null,decision.plan?.stopLoss??null,
          decision.plan?.takeProfit??null,decision.plan?.expectedRiskReward??null,
          JSON.stringify({bias:decision.bias,biasReason:decision.biasReason,strength:decision.strength,emitBlockers:decision.emitBlockers,entry:decision.plan?.entryProvenance??null}),
          decision.action,decision.reason,decision.workingOrder?.orderId??null,decision.mode
        ]);
        await client.query(`INSERT INTO asset_signal_cursors(asset_id,closed_at,bias_direction,bias_armed_at,bias_armed_until,bias_strength,pending_flip_direction,pending_flip_count)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(asset_id) DO UPDATE SET bias_direction=EXCLUDED.bias_direction,
            bias_armed_at=EXCLUDED.bias_armed_at,bias_armed_until=EXCLUDED.bias_armed_until,bias_strength=EXCLUDED.bias_strength,
            pending_flip_direction=EXCLUDED.pending_flip_direction,pending_flip_count=EXCLUDED.pending_flip_count,updated_at=now()`,
          [decision.assetId,closedAt,decision.bias.direction,decision.bias.armedAt,decision.bias.armedUntil,decision.strength,
           decision.bias.pendingFlipDirection??null,decision.bias.pendingFlipCount??0]);
        if(decision.workingOrder)await client.query("UPDATE orders SET revalidated_at=now(),updated_at=now() WHERE id=$1",[decision.workingOrder.orderId]);
        if(message)await client.query("INSERT INTO outbox(topic,payload) VALUES($1,$2)",[message.topic,JSON.stringify(message.payload)]);
      });
    }
  }
}

/**
 * Announces a halt exactly once per streak. The breaker is recomputed from the
 * order table every scan, so without this the same halt would notify every 15
 * minutes for its whole 12-hour life. Keyed on the halt's end time, which is
 * derived from the qualifying loss and is therefore stable across scans and
 * restarts, and moves only when a fresher streak re-arms the halt.
 */
async function announceHalts(halts:Array<{direction:string;until:string;count:number}>){
  for(const halt of halts){
    const key=`direction_halt:${halt.direction}`;
    const announced=await query<{value:Record<string,unknown>}>("SELECT value FROM app_state WHERE key=$1",[key]);
    if(announced.rows[0]?.value.until===halt.until)continue;
    await transaction(async(client)=>{
      await client.query("INSERT INTO app_state(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()",[key,JSON.stringify(halt)]);
      await client.query("INSERT INTO outbox(topic,payload) VALUES('notification.direction_halted',$1)",[JSON.stringify(halt)]);
    });
  }
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
    // Account-wide loss streak. Only stops that actually LOST count: after a
    // scale-out the surviving half exits at its breakeven stop, which books
    // CLOSED_SL while being a scratch, and halting on those would shut down a
    // direction that is working.
    const lookbackHours=Math.max(strategy.restingEntry.lossStreakWindowHours,0)+Math.max(strategy.restingEntry.lossStreakHaltHours,0);
    const recentLosses=strategy.restingEntry.lossStreakCount>0
      ?(await query<{direction:string;closed_at:string}>(
        `SELECT direction,updated_at::text closed_at FROM orders
         WHERE state IN ('CLOSED_SL','LIQUIDATED')
           AND coalesce(scaled_out_pnl,0)+coalesce(realized_pnl,0) < 0
           AND updated_at > now() - ($1||' hours')::interval`,[String(lookbackHours||1)])).rows
        .map((row)=>({direction:row.direction==="LONG"?"LONG" as const:"SHORT" as const,closedAt:new Date(row.closed_at).toISOString()}))
      :[];
    const halts=haltedDirections(recentLosses,new Date().toISOString(),strategy.restingEntry);
    const haltedBy=new Map(halts.map((halt)=>[halt.direction,halt]));
    await announceHalts(halts);
    const latestClosedAt=timestampIso(latestResult.rows[0]?.closed_at);
    const cursor=timestampIso(cursorResult.rows[0]?.value.closedAt);
    const advanceCursor=async(closedAt:string|null)=>{if(closedAt)await query("INSERT INTO app_state(key,value) VALUES('signal_cursor',$1) ON CONFLICT(key) DO UPDATE SET value=$1,updated_at=now()",[JSON.stringify({closedAt})]);};
    if(!initialized||!cursor){const alignedNow=new Date(Math.floor(Date.now()/(15*60_000))*(15*60_000)).toISOString();await advanceCursor(latestClosedAt??alignedNow);initialized=true;await recordHealth("signal-engine",true);return;}
    if(Boolean(global.rows[0]?.value.paused)||Boolean(risk.rows[0]?.value.autoPaused)){await advanceCursor(latestClosedAt);await recordHealth("signal-engine",true);return;}
    const snapshots=await query<Record<string,unknown>>(`SELECT i.*,a.code,a.binance_symbol,a.paused,a.trade_enabled,a.variational_url,
      c.bias_direction,c.bias_armed_at,c.bias_armed_until,c.pending_flip_direction,c.pending_flip_count FROM indicator_snapshots i JOIN assets a ON a.id=i.asset_id LEFT JOIN asset_signal_cursors c ON c.asset_id=i.asset_id
      WHERE a.signal_enabled=true AND a.paused=false AND i.closed_at>greatest($1::timestamptz,coalesce(c.closed_at,'epoch'::timestamptz))
      ORDER BY i.closed_at LIMIT 100`,[cursor]);
    // One working resting order and one open position per asset, read once for
    // the whole batch rather than per asset per direction.
    const [workingRows,positionRows]=await Promise.all([
      query<{id:string;asset_id:string;direction:Direction;entry_price:string;stop_loss:string}>(`SELECT id,asset_id,direction,entry_price,stop_loss FROM orders WHERE state='PENDING_ENTRY' AND entry_kind='RESTING_LIMIT'`),
      query<{id:string;asset_id:string;direction:Direction}>(`SELECT id,asset_id,direction FROM orders WHERE state='FILLED_OPEN'`)
    ]);
    const workingByAsset=new Map(workingRows.rows.map((row)=>[row.asset_id,{orderId:row.id,direction:row.direction,level:Number(row.entry_price),stopLoss:Number(row.stop_loss)} satisfies WorkingRestingOrder]));
    const positionByAsset=new Map(positionRows.rows.map((row)=>[row.asset_id,{orderId:row.id,direction:row.direction}]));
    const restingGroups=new Map<string,RestingAssetInput[]>();
    const signalIdByAsset=new Map<string,string>();
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
      // Resolved lazily and only for a short that is otherwise ready to arm, so
      // the common case costs nothing; hourCandlesFor is cached per hour anyway.
      let change24h:number|null|undefined;
      const change24hFor=async()=>{
        if(change24h!==undefined)return change24h;
        try{
          const candles=await hourCandlesFor(String(row.binance_symbol));
          hourCandles=candles;
          const settled=candles.filter((candle)=>candle.openTime+3_600_000<=new Date(String(row.closed_at)).getTime());
          const previous=settled.at(-25),latest=settled.at(-1);
          change24h=previous&&latest&&previous.close>0?(latest.close-previous.close)/previous.close*100:null;
        }catch{change24h=null;}
        return change24h;
      };
      const passedDirections:Direction[]=[];
      let restingConditions:ConditionResult[]=[];
      let restingRegions:HeatmapRegion[]=[];
      let structuralBlockers:string[]=[];
      let emitBlockers:string[]=[];
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
        const gateInput={globalPaused:Boolean(global.rows[0]?.value.paused),assetPaused:Boolean(row.paused)||!dataFresh,dataFresh,sessionValid:sessionReady,liveTrading:config.LIVE_TRADING_ENABLED&&Boolean(row.trade_enabled),marginUsage:Number(risk.rows[0]?.value.marginUsagePercent??0),marginAutoPaused:Boolean(risk.rows[0]?.value.autoPaused),concurrentOrders:Number(concurrent.rows[0]?.count??0),maxOrders:strategy.maxOrdersPerSide};
        const gate=riskGate(gateInput);
        const accepted=conditionPass&&btcPass&&Boolean(row.warmup_ready);
        // The shadow ledger has to record what the model WOULD have done on an
        // asset that is merely not cleared for live trading yet — spec 6-3
        // rolls out 2-3 assets at a time and compares them against the rest.
        // So the decision runs against structural health only; session and
        // live-trading gates decide emission, not whether we think.
        const extremeMoveBlocked=accepted&&!directionAllowedAfterMove(await change24hFor(),direction,strategy.restingEntry);
        // The breaker withholds ARMING only. It never reaches a filled
        // position — that keeps its own stop and target — and it does not
        // cancel working orders directly either: their bias simply stops being
        // refreshed and they drain through the existing expiry rule.
        const halted=haltedBy.get(direction);
        if(accepted&&!extremeMoveBlocked&&!halted){passedDirections.push(direction);restingConditions=conditions;}
        if(heatmap.regions.length)restingRegions=heatmap.regions;
        const conditionRejections=conditions
          .filter((condition)=>strategy.conditions.includes(condition.type)&&!condition.passed)
          .map((condition)=>condition.type==="HEATMAP"?`HEATMAP_${heatmap.state}`:`CONDITION_${condition.type}_FAILED`);
        let plan:OrderPlan|undefined;
        const planRejections:string[]=[];
        if(accepted&&gate.passed){
          try{
            const [candles,entryPrice]=await Promise.all([
              hourCandles?Promise.resolve(hourCandles):hourCandlesFor(String(row.binance_symbol)),
              binance.latestPrice(String(row.binance_symbol))
            ]);
            hourCandles=candles;
            const atrValue=atr(candles,14).at(-1)!;
            plan=makeOrderPlan({symbol:String(row.binance_symbol),venueSymbol:variationalUnderlying(row.variational_url as string|null,String(row.binance_symbol)),direction,closedAt:new Date(String(row.closed_at)).toISOString(),entryPrice,swing:findAtrSwing(candles,atrValue,direction),atr1h:atrValue,regions:heatmap.regions,marginUsdc:config.DEFAULT_MARGIN_USDC,leverage:config.LEVERAGE});
          }catch(error){planRejections.push(`ORDER_PLAN_FAILED: ${error instanceof Error?error.message:String(error)}`);}
        }
        const executable=accepted&&gate.passed&&Boolean(plan);
        const rejectionReasons=[...(!row.warmup_ready?["INDICATOR_WARMUP"]:[]),...conditionRejections,...(!btcPass?["BTC_DIRECTION_FILTER"]:[]),
          ...(extremeMoveBlocked?[`EXTREME_MOVE_BLOCKED: 24h ${change24h?.toFixed(1)}%`]:[]),
          ...(halted?[`DIRECTION_HALTED: ${halted.count} losing ${direction} stops; arming resumes ${halted.until}`]:[]),...gate.reasons,...planRejections];
        await transaction(async(client)=>{
          const signal=await client.query(`INSERT INTO signals(asset_id,strategy_id,closed_at,direction,executable,accepted,conditions,rejection_reasons) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING id`,[row.asset_id,strategy.id,row.closed_at,direction,executable,accepted,JSON.stringify(conditions),rejectionReasons]);
          if(!signal.rows[0])return;
          if(accepted)await client.query("INSERT INTO outbox(topic,payload) VALUES('notification.signal',$1)",[JSON.stringify({symbol:row.code,direction,accepted,executable,rejectionReasons})]);
          if(!plan||!executable||strategy.entryKind!=="MARKET_ON_SIGNAL")return;
          const order=await client.query(`INSERT INTO orders(signal_id,asset_id,strategy_id,idempotency_key,direction,state,entry_price,stop_loss,take_profit,margin_usdc,leverage) VALUES($1,$2,$3,$4,$5,'CREATED_LOCAL',$6,$7,$8,$9,$10) ON CONFLICT(idempotency_key) DO NOTHING RETURNING id`,[signal.rows[0].id,row.asset_id,strategy.id,plan.idempotencyKey,direction,plan.entryPrice,plan.stopLoss,plan.takeProfit,plan.marginUsdc,plan.leverage]);
          if(order.rows[0]){await client.query("INSERT INTO order_events(order_id,from_state,to_state,reason,payload) VALUES($1,NULL,'CREATED_LOCAL','signal accepted',$2)",[order.rows[0].id,JSON.stringify(plan)]);await client.query("INSERT INTO outbox(topic,payload) VALUES('order.submit',$1)",[JSON.stringify({orderId:order.rows[0].id,plan})]);}
        });
      }
      // Direction-independent gates for the resting model. Concurrency is
      // neutralised because the resting model caps itself at one working
      // order per asset (revalidateWorkingOrder's single workingOrder input),
      // and the per-side cap it would otherwise trip is that same order.
      const sessionOk=Boolean(session.rows[0]?.value.loggedIn)&&Boolean(session.rows[0]?.value.reconciled);
      const restingBase={globalPaused:Boolean(global.rows[0]?.value.paused),assetPaused:Boolean(row.paused)||!dataFresh,dataFresh,marginUsage:Number(risk.rows[0]?.value.marginUsagePercent??0),marginAutoPaused:Boolean(risk.rows[0]?.value.autoPaused),concurrentOrders:0,maxOrders:1};
      const structural=riskGate({...restingBase,sessionValid:true,liveTrading:true});
      const emit=riskGate({...restingBase,sessionValid:sessionOk,liveTrading:config.LIVE_TRADING_ENABLED&&Boolean(row.trade_enabled)});
      const previousBias=biasFromRow(row);
      const closedAt=new Date(String(row.closed_at)).toISOString();
      // Candles cost a Binance round-trip, so they are only fetched when this
      // asset can actually produce or hold a resting decision this scan.
      const needsStructure=passedDirections.length===1||Boolean(previousBias.direction)||workingByAsset.has(String(row.asset_id))||positionByAsset.has(String(row.asset_id));
      let candles=hourCandles;
      if(needsStructure&&!candles){
        try{candles=await hourCandlesFor(String(row.binance_symbol));}catch{candles=undefined;}
      }
      const group=restingGroups.get(closedAt)??[];
      group.push({
        assetId:String(row.asset_id),code:String(row.binance_symbol),venueSymbol:variationalUnderlying(row.variational_url as string|null,String(row.binance_symbol)),closedAt,closePrice:Number(row.price),
        previousBias,passedDirections,conditions:restingConditions,regions:restingRegions,candles:candles??[],
        workingOrder:workingByAsset.get(String(row.asset_id))??null,
        openPosition:positionByAsset.get(String(row.asset_id))??null,
        structurallyTradable:structural.passed&&Boolean(row.warmup_ready),
        structuralBlockers:[...(!row.warmup_ready?["INDICATOR_WARMUP"]:[]),...structural.reasons],
        emitAllowed:emit.passed&&Boolean(row.warmup_ready)&&strategy.entryKind==="RESTING_LIMIT",
        emitBlockers:[...emit.reasons,...(strategy.entryKind==="RESTING_LIMIT"?[]:["STRATEGY_USES_MARKET_ON_SIGNAL"])]
      });
      restingGroups.set(closedAt,group);
      const latestSignal=await query<{id:string}>("SELECT id FROM signals WHERE asset_id=$1 AND closed_at=$2 ORDER BY created_at DESC LIMIT 1",[row.asset_id,row.closed_at]);
      if(latestSignal.rows[0])signalIdByAsset.set(`${row.asset_id}|${closedAt}`,latestSignal.rows[0].id);
      await query("INSERT INTO asset_signal_cursors(asset_id,closed_at) VALUES($1,$2) ON CONFLICT(asset_id) DO UPDATE SET closed_at=EXCLUDED.closed_at,updated_at=now()",[row.asset_id,row.closed_at]);
    }
    await runRestingScan(strategy,restingGroups,signalIdByAsset);
    if(snapshots.rows.length)await advanceCursor(timestampIso(snapshots.rows.at(-1)!.closed_at));
    await recordHealth("signal-engine",true);
  }catch(error){await recordHealth("signal-engine",false,error,true);}
}

async function shutdown(){await pool.end();process.exit(0);}
process.on("SIGTERM",shutdown);
while(true){
  // Credential/config updates (e.g. LIVE_TRADING_ENABLED) only take effect on
  // a fresh process, since config is read once and cached at startup; exit
  // and let Docker's restart policy relaunch with the current .env.
  if(await claimRestartRequest("signal-engine")){await shutdown();}
  await run();
  await sleep(30_000);
}
