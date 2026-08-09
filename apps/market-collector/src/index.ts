import { randomUUID } from "node:crypto";
import { claimRestartRequest, pool, query, recordBusinessError, recordHealth } from "@huxtrade/database";
import { BinanceFuturesClient } from "@huxtrade/exchange-clients";
import { fixedRules } from "@huxtrade/config";
import { classifyBtcRegime, cvdAnomaly, fundingAnomaly, oiAnomaly } from "@huxtrade/indicators";
import type { HeatmapRegion } from "@huxtrade/shared-types";
import { cvdBinsFromCandles, isRetryablePause, scanningPaused } from "./control.js";

const binance = new BinanceFuturesClient();
const sleep = (ms:number) => new Promise((resolve) => setTimeout(resolve, ms));
const quarterMs = 15 * 60_000;
const baselineSamples = 30 * 24 * 4;
const nextQuarterDelay = () => Math.floor(Date.now() / quarterMs + 1) * quarterMs - Date.now() + 3_000;
async function waitForNextQuarter(){const end=Date.now()+nextQuarterDelay();while(Date.now()<end){if(await claimRestartRequest("market-collector")){await pool.end();process.exit(0);}await sleep(Math.min(5_000,end-Date.now()));}}

type BaselineMetric = "OI_RAW" | "CVD_15M" | "FUNDING_RAW";
type BaselinePoint = { at:Date; value:number };

async function insertBaseline(assetId:string,metric:BaselineMetric,source:string,points:BaselinePoint[]) {
  const batchSize=500;
  for(let start=0;start<points.length;start+=batchSize){
    const batch=points.slice(start,start+batchSize);
    await query(`INSERT INTO metric_baselines(asset_id,metric,observed_at,value,source)
      SELECT $1,$2,x.observed_at,x.value,$3 FROM unnest($4::timestamptz[],$5::numeric[]) AS x(observed_at,value)
      ON CONFLICT(asset_id,metric,observed_at) DO NOTHING`,[assetId,metric,source,batch.map((p)=>p.at.toISOString()),batch.map((p)=>p.value)]);
  }
}

async function prewarmAsset(asset:Record<string,unknown>) {
  const assetId=String(asset.id),symbol=String(asset.binance_symbol);
  const counts=await query<{metric:BaselineMetric;count:string}>(`SELECT metric,count(*)::text count FROM metric_baselines
    WHERE asset_id=$1 AND observed_at>=now()-interval '30 days' GROUP BY metric`,[assetId]);
  const countByMetric=new Map(counts.rows.map((row)=>[row.metric,Number(row.count)]));
  if (["OI_RAW","CVD_15M","FUNDING_RAW"].every((metric)=>(countByMetric.get(metric as BaselineMetric)??0)>=baselineSamples-4)) return;
  const end=Math.floor(Date.now()/quarterMs)*quarterMs;
  // The 4h lead-in is required to calculate a full 30d baseline of 1h/4h changes.
  const start=end-(30*24+4)*60*60_000;
  const [oi,klines5m,funding]=await Promise.all([
    binance.openInterestHistory(symbol,start,end),
    binance.klinesRange(symbol,"5m",start,end),
    binance.fundingHistory(symbol,1000,start,end)
  ]);
  await insertBaseline(assetId,"OI_RAW","BINANCE_OPEN_INTEREST_HISTORY",oi.map((x)=>({at:new Date(x.timestamp),value:Number(x.sumOpenInterest)})));
  const cvdByQuarter=new Map<number,number>();
  for(const candle of klines5m){
    if(candle.openTime>=end)continue;
    const bucket=Math.floor(candle.openTime/quarterMs)*quarterMs;
    const delta=2*(candle.takerBuyQuoteVolume??0)-(candle.quoteVolume??0);
    cvdByQuarter.set(bucket,(cvdByQuarter.get(bucket)??0)+delta);
  }
  await insertBaseline(assetId,"CVD_15M","BINANCE_5M_TAKER_VOLUME",[...cvdByQuarter].map(([at,value])=>({at:new Date(at),value})));
  const fundingSorted=[...funding].sort((a,b)=>a.fundingTime-b.fundingTime);
  const expanded:BaselinePoint[]=[];
  let index=0,current=Number(fundingSorted[0]?.fundingRate??0);
  for(let at=start;at<end;at+=quarterMs){
    while(index<fundingSorted.length&&fundingSorted[index]!.fundingTime<=at){current=Number(fundingSorted[index]!.fundingRate);index+=1;}
    expanded.push({at:new Date(at),value:current});
  }
  await insertBaseline(assetId,"FUNDING_RAW","BINANCE_FUNDING_HISTORY_STEP_15M",expanded);
}

async function metricValues(assetId:string,metric:BaselineMetric,currentAt:Date,currentValue:number,limit:number){
  await query(`INSERT INTO metric_baselines(asset_id,metric,observed_at,value,source) VALUES($1,$2,$3,$4,'LIVE_SCAN')
    ON CONFLICT(asset_id,metric,observed_at) DO UPDATE SET value=EXCLUDED.value,source=EXCLUDED.source`,[assetId,metric,currentAt,currentValue]);
  const rows=await query<{value:string}>(`SELECT value::text FROM metric_baselines WHERE asset_id=$1 AND metric=$2 AND observed_at<=$3 ORDER BY observed_at DESC LIMIT $4`,[assetId,metric,currentAt,limit]);
  return rows.rows.reverse().map((row)=>Number(row.value));
}

async function requestHeatmapRefresh(closedAt:Date,heatmapRange:string,assetCount:number){
  const requestId=randomUUID(),requestedAt=new Date();
  await query(`INSERT INTO app_state(key,value) VALUES('coinglass_refresh_request',$1)
    ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`,[JSON.stringify({requestId,requestedAt:requestedAt.toISOString(),closedAt:closedAt.toISOString(),heatmapRange})]);
  // CoinGlass Agent captures assets sequentially with a deliberate pause
  // between each (crash prevention), so a fixed wait budget here falls behind
  // as the whitelist grows — a 45s constant already races the agent at just
  // 13 assets (observed: 62.8s for a full pass). Scale with the current
  // asset count instead of guessing a bigger constant; the 15-minute scan
  // cadence has plenty of room even at the 50-asset spec ceiling (~9min).
  const deadline=Date.now()+Math.max(45_000,assetCount*10_000+20_000);
  while(Date.now()<deadline){
    const result=(await query<{value:Record<string,unknown>}>("SELECT value FROM app_state WHERE key='coinglass_refresh_result'")).rows[0]?.value;
    if(result?.requestId===requestId)return requestedAt;
    if(await claimRestartRequest("market-collector")){await pool.end();process.exit(0);}
    await sleep(1_000);
  }
  return requestedAt;
}

async function collectAsset(asset:Record<string,unknown>,btcRegime:string,closedAt:Date,scanRunId:string,heatmapRange:string,heatmapNotBefore:Date):Promise<boolean>{
  const id=String(asset.id),symbol=String(asset.binance_symbol);
  try{
    await prewarmAsset(asset);
    const [price,oi,funding,candles5m,heatmapResult]=await Promise.all([
      binance.latestPrice(symbol),binance.openInterest(symbol),binance.fundingHistory(symbol,8),
      binance.klinesRange(symbol,"5m",closedAt.getTime()-quarterMs,closedAt.getTime()-1),
      query<{regions:HeatmapRegion[];captured_at:Date}>("SELECT regions,captured_at FROM coinglass_heatmaps WHERE asset_id=$1 AND heatmap_range=$2",[id,heatmapRange])
    ]);
    const heatmapRow=heatmapResult.rows[0];
    const heatmapCapturedAt=heatmapRow?new Date(heatmapRow.captured_at).getTime():NaN;
    if(!heatmapRow||Date.now()-heatmapCapturedAt>fixedRules.heatmapStaleMs||heatmapCapturedAt<heatmapNotBefore.getTime())throw new Error(`CoinGlass ${heatmapRange} Heatmap was not refreshed for this scan`);
    const heatmap={regions:Array.isArray(heatmapRow.regions)?heatmapRow.regions:[]};
    if(!heatmap.regions.length)throw new Error(`CoinGlass ${heatmapRange} Heatmap cache contains no eligible regions`);
    // Identical quantity to the per-trade sum this replaced — taker-buy quote
    // volume minus taker-sell — and identical to the formula the 30-day
    // CVD_15M baseline is built from in prewarmAsset. Summing aggregate trades
    // paginated 1000 at a time and cost tens to hundreds of Binance requests
    // per scan on a high-volume asset, which is what pushed the whole system
    // past the 2400/min IP limit; three 5m candles cost one. Using the same
    // source as the baseline also removes the risk of measuring the live value
    // and its own baseline with two different rulers.
    const cvdBins=cvdBinsFromCandles(candles5m,closedAt.getTime()-quarterMs,closedAt.getTime());
    const cvd=cvdBins.reduce((sum,value)=>sum+value,0);
    const fundingValue=Number(funding.at(-1)?.fundingRate??0);
    const [oiValues,cvdValues,fundingValues]=await Promise.all([
      metricValues(id,"OI_RAW",closedAt,oi.value,baselineSamples+8),
      metricValues(id,"CVD_15M",closedAt,cvd,baselineSamples+1),
      metricValues(id,"FUNDING_RAW",closedAt,fundingValue,baselineSamples+18)
    ]);
    const oiResult=oiAnomaly({values:oiValues,baselineSamples});
    const cvdResult=cvdAnomaly({currentBins:cvdBins,history:cvdValues.slice(0,-1),baselineSamples});
    const fundingResult=fundingAnomaly({values:fundingValues,baselineSamples});
    const warmupReady=oiResult.ready&&cvdResult.ready&&fundingResult.ready;
    await query(`INSERT INTO indicator_snapshots(asset_id,scan_run_id,closed_at,price,oi_value,oi_change_1h,oi_z,oi_passed,cvd_value,cvd_z,cvd_passed,cvd_direction,funding_value,funding_change_4h,funding_z,funding_change_z,funding_passed,heatmap,heatmap_passed,btc_regime,warmup_ready,inputs)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
      ON CONFLICT(asset_id,closed_at) DO UPDATE SET scan_run_id=EXCLUDED.scan_run_id,price=EXCLUDED.price,oi_value=EXCLUDED.oi_value,oi_change_1h=EXCLUDED.oi_change_1h,oi_z=EXCLUDED.oi_z,oi_passed=EXCLUDED.oi_passed,cvd_value=EXCLUDED.cvd_value,cvd_z=EXCLUDED.cvd_z,cvd_passed=EXCLUDED.cvd_passed,cvd_direction=EXCLUDED.cvd_direction,funding_value=EXCLUDED.funding_value,funding_change_4h=EXCLUDED.funding_change_4h,funding_z=EXCLUDED.funding_z,funding_change_z=EXCLUDED.funding_change_z,funding_passed=EXCLUDED.funding_passed,heatmap=EXCLUDED.heatmap,heatmap_passed=EXCLUDED.heatmap_passed,btc_regime=EXCLUDED.btc_regime,warmup_ready=EXCLUDED.warmup_ready,inputs=EXCLUDED.inputs`,[
      id,scanRunId,closedAt,price,oi.value,oiResult.value,oiResult.zScore,oiResult.passed,cvd,cvdResult.zScore,cvdResult.passed,cvdResult.direction>0?"LONG":cvdResult.direction<0?"SHORT":null,
      fundingResult.value,fundingResult.change4h,fundingResult.currentZ,fundingResult.changeZ,fundingResult.passed,JSON.stringify(heatmap.regions),heatmap.regions.length>0,btcRegime,warmupReady,
      JSON.stringify({oiTime:oi.time,cvdCandleCount:candles5m.length,cvdSource:"BINANCE_5M_TAKER_VOLUME",baselineSamples:{oi:oiResult.sampleCount,cvd:cvdResult.sampleCount,funding:fundingResult.sampleCount},fundingScore:fundingResult.score,heatmapRange,heatmapCapturedAt:new Date(heatmapRow.captured_at).toISOString()})
    ]);
    await query("UPDATE assets SET last_updated_at=now(),updated_at=now() WHERE id=$1",[id]);
    // Only assets paused for a retryable data/prewarm failure ever reach this
    // point paused=true (the scan query below excludes every other pause
    // reason), so a clean run here is proof the underlying fetch problem is
    // gone — safe to lift automatically. Pauses from real trading-state risk
    // (missing protection, ambiguous reconciliation) never take this path and
    // still require a human to look and clear them by hand.
    if(Boolean(asset.paused)){
      await query("UPDATE assets SET paused=false,pause_reason=null,updated_at=now() WHERE id=$1",[id]);
      await query("INSERT INTO outbox(topic,payload) VALUES('notification.asset_resumed',$1)",[JSON.stringify({asset:String(asset.code),previousReason:String(asset.pause_reason??"")})]);
    }
    return true;
  }catch(error){
    const reason=error instanceof Error?error.message:String(error);
    await recordBusinessError({service:"market-collector",assetId:id,code:"ASSET_COLLECTION_FAILED",message:reason,blocksTrading:true,context:{symbol}});
    await query("UPDATE assets SET paused=true,pause_reason=$1,updated_at=now() WHERE id=$2",[`DATA_ERROR: ${reason}`.slice(0,500),id]);
    await query("INSERT INTO outbox(topic,payload) VALUES('notification.system_error',$1)",[JSON.stringify({asset:String(asset.code),reason})]);
    return false;
  }
}

async function scan(){
  const closedAt=new Date(Math.floor(Date.now()/quarterMs)*quarterMs);
  let scanRunId:string|undefined;
  let binanceHealthy=false;
  try{
    const [globalState,riskState]=await Promise.all([
      query<{value:Record<string,unknown>}>("SELECT value FROM app_state WHERE key='global_pause'"),
      query<{value:Record<string,unknown>}>("SELECT value FROM app_state WHERE key='account_risk'")
    ]);
    if(scanningPaused(globalState.rows[0]?.value,riskState.rows[0]?.value)){await recordHealth("market-collector",true);return;}
    const [daily,fourHour]=await Promise.all([binance.klines("BTCUSDT","1d",260),binance.klines("BTCUSDT","4h",300)]);
    await recordHealth("binance",true);binanceHealthy=true;
    // Assets paused for a transient DATA_ERROR/PREWARM_ERROR are retried every
    // scan so they self-heal once Binance/CoinGlass is reachable again; every
    // other pause reason (missing protection, ambiguous reconciliation, a
    // human's manual pause) is a real trading-state risk and stays excluded
    // until someone clears it deliberately.
    const [allAssets,strategy]=await Promise.all([query<Record<string,unknown>>("SELECT * FROM assets WHERE collect_enabled=true ORDER BY code"),query<{heatmap_range:string}>("SELECT heatmap_range FROM strategies WHERE enabled=true LIMIT 1")]);
    const assetRows=allAssets.rows.filter((row)=>!row.paused||isRetryablePause(row.pause_reason as string|null));
    const previous=(await query<{btc_regime:string}>("SELECT btc_regime FROM indicator_snapshots WHERE btc_regime IS NOT NULL ORDER BY closed_at DESC LIMIT 1")).rows[0]?.btc_regime as "BULL"|"BEAR"|"RANGE"|"TRANSITION"|undefined;
    const dailyClosed=daily.filter((candle)=>candle.openTime+24*60*60_000<=closedAt.getTime());
    const fourHourClosed=fourHour.filter((candle)=>candle.openTime+4*60*60_000<=closedAt.getTime());
    const btc=classifyBtcRegime(dailyClosed,fourHourClosed,previous);
    const run=await query<{id:string}>(`INSERT INTO scan_runs(closed_at,btc_regime,btc_context,asset_count) VALUES($1,$2,$3,$4)
      ON CONFLICT(closed_at) DO UPDATE SET started_at=now(),completed_at=null,status='RUNNING',error=null RETURNING id`,[closedAt,btc.regime,JSON.stringify(btc),assetRows.length]);
    scanRunId=run.rows[0]!.id;
    let success=0;
    const heatmapRange=strategy.rows[0]?.heatmap_range??"24h";
    const heatmapNotBefore=await requestHeatmapRefresh(closedAt,heatmapRange,assetRows.length);
    const pending=[...assetRows];
    const workers=Array.from({length:Math.min(5,pending.length)},async()=>{
      while(pending.length){const asset=pending.shift();if(asset&&await collectAsset(asset,btc.regime,closedAt,scanRunId!,heatmapRange,heatmapNotBefore))success+=1;}
    });
    await Promise.all(workers);
    const failure=assetRows.length-success;
    await query("UPDATE scan_runs SET completed_at=now(),success_count=$1,failure_count=$2,status=$3 WHERE id=$4",[success,failure,failure?"PARTIAL":"COMPLETED",scanRunId]);
    await recordHealth("market-collector",failure===0,failure?`${failure} asset(s) paused during scan`:undefined,false);
  }catch(error){
    if(scanRunId)await query("UPDATE scan_runs SET completed_at=now(),status='FAILED',error=$1 WHERE id=$2",[error instanceof Error?error.message:String(error),scanRunId]);
    if(!binanceHealthy)await recordHealth("binance",false,error,true);
    await recordHealth("market-collector",false,error,true);
  }
}

process.on("SIGTERM",async()=>{await pool.end();process.exit(0);});
async function prewarmAll(){
  const assets=await query<Record<string,unknown>>("SELECT * FROM assets WHERE collect_enabled=true AND paused=false ORDER BY code");
  let failures=0;
  for(const asset of assets.rows){try{await prewarmAsset(asset);}catch(error){failures+=1;const reason=error instanceof Error?error.message:String(error);await recordBusinessError({service:"market-collector",assetId:String(asset.id),code:"ASSET_PREWARM_FAILED",message:reason,blocksTrading:true,context:{symbol:String(asset.binance_symbol)}});await query("UPDATE assets SET paused=true,pause_reason=$1,updated_at=now() WHERE id=$2",[`PREWARM_ERROR: ${reason}`.slice(0,500),asset.id]);}}
  await recordHealth("binance",failures===0,failures?`${failures} Binance prewarm request(s) failed`:undefined,failures>0);
  await recordHealth("market-collector",failures===0,failures?`${failures} asset(s) failed prewarm`:undefined,false);
}
await prewarmAll();
while(true){await waitForNextQuarter();await scan();}
