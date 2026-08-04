import { claimRestartRequest, pool, query, recordBusinessError, recordHealth } from "@huxtrade/database";
import { BinanceFuturesClient, CoinGlassClient } from "@huxtrade/exchange-clients";
import { classifyBtcRegime, cvdAnomaly, fundingAnomaly, oiAnomaly } from "@huxtrade/indicators";

const binance = new BinanceFuturesClient();
const coinglass = new CoinGlassClient();
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

async function collectAsset(asset:Record<string,unknown>,btcRegime:string,closedAt:Date,scanRunId:string,heatmapRange:string):Promise<boolean>{
  const id=String(asset.id),symbol=String(asset.binance_symbol);
  try{
    await prewarmAsset(asset);
    const [price,oi,funding,trades,heatmap]=await Promise.all([
      binance.latestPrice(symbol),binance.openInterest(symbol),binance.fundingHistory(symbol,8),
      binance.aggregateTrades(symbol,closedAt.getTime()-quarterMs,closedAt.getTime()-1),coinglass.heatmap(String(asset.coinglass_symbol),heatmapRange)
    ]);
    const cvdBins=trades.reduce<number[]>((bins,trade)=>{
      const index=Math.min(2,Math.max(0,Math.floor((trade.T-(closedAt.getTime()-quarterMs))/(5*60_000))));
      bins[index]=(bins[index]??0)+(trade.m?-1:1)*Number(trade.p)*Number(trade.q);return bins;
    },[0,0,0]);
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
      JSON.stringify({oiTime:oi.time,tradeCount:trades.length,baselineSamples:{oi:oiResult.sampleCount,cvd:cvdResult.sampleCount,funding:fundingResult.sampleCount},fundingScore:fundingResult.score,heatmapRange})
    ]);
    await query("UPDATE assets SET last_updated_at=now(),updated_at=now() WHERE id=$1",[id]);
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
  try{
    const [daily,fourHour,assets,strategy]=await Promise.all([binance.klines("BTCUSDT","1d",260),binance.klines("BTCUSDT","4h",300),query("SELECT * FROM assets WHERE collect_enabled=true AND paused=false ORDER BY code"),query<{heatmap_range:string}>("SELECT heatmap_range FROM strategies WHERE enabled=true LIMIT 1")]);
    const previous=(await query<{btc_regime:string}>("SELECT btc_regime FROM indicator_snapshots WHERE btc_regime IS NOT NULL ORDER BY closed_at DESC LIMIT 1")).rows[0]?.btc_regime as "BULL"|"BEAR"|"RANGE"|"TRANSITION"|undefined;
    const dailyClosed=daily.filter((candle)=>candle.openTime+24*60*60_000<=closedAt.getTime());
    const fourHourClosed=fourHour.filter((candle)=>candle.openTime+4*60*60_000<=closedAt.getTime());
    const btc=classifyBtcRegime(dailyClosed,fourHourClosed,previous);
    const run=await query<{id:string}>(`INSERT INTO scan_runs(closed_at,btc_regime,btc_context,asset_count) VALUES($1,$2,$3,$4)
      ON CONFLICT(closed_at) DO UPDATE SET started_at=now(),completed_at=null,status='RUNNING',error=null RETURNING id`,[closedAt,btc.regime,JSON.stringify(btc),assets.rowCount??0]);
    scanRunId=run.rows[0]!.id;
    let success=0;
    const heatmapRange=strategy.rows[0]?.heatmap_range??"24h";
    const pending=[...assets.rows] as Record<string,unknown>[];
    const workers=Array.from({length:Math.min(5,pending.length)},async()=>{
      while(pending.length){const asset=pending.shift();if(asset&&await collectAsset(asset,btc.regime,closedAt,scanRunId!,heatmapRange))success+=1;}
    });
    await Promise.all(workers);
    const failure=(assets.rowCount??0)-success;
    await query("UPDATE scan_runs SET completed_at=now(),success_count=$1,failure_count=$2,status=$3 WHERE id=$4",[success,failure,failure?"PARTIAL":"COMPLETED",scanRunId]);
    await recordHealth("market-collector",failure===0,failure?`${failure} asset(s) paused during scan`:undefined,false);
  }catch(error){
    if(scanRunId)await query("UPDATE scan_runs SET completed_at=now(),status='FAILED',error=$1 WHERE id=$2",[error instanceof Error?error.message:String(error),scanRunId]);
    await recordHealth("market-collector",false,error,true);
  }
}

process.on("SIGTERM",async()=>{await pool.end();process.exit(0);});
async function prewarmAll(){
  const assets=await query<Record<string,unknown>>("SELECT * FROM assets WHERE collect_enabled=true AND paused=false ORDER BY code");
  let failures=0;
  for(const asset of assets.rows){try{await prewarmAsset(asset);}catch(error){failures+=1;const reason=error instanceof Error?error.message:String(error);await recordBusinessError({service:"market-collector",assetId:String(asset.id),code:"ASSET_PREWARM_FAILED",message:reason,blocksTrading:true,context:{symbol:String(asset.binance_symbol)}});await query("UPDATE assets SET paused=true,pause_reason=$1,updated_at=now() WHERE id=$2",[`PREWARM_ERROR: ${reason}`.slice(0,500),asset.id]);}}
  await recordHealth("market-collector",failures===0,failures?`${failures} asset(s) failed prewarm`:undefined,false);
}
await prewarmAll();
while(true){await waitForNextQuarter();await scan();}
