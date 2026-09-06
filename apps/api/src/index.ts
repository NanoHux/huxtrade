import { chmod,readFile,writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { z } from "zod";
import { fixedRules, getConfig, getEnvFilePath } from "@huxtrade/config";
import { pool, query, recordBusinessError, recordHealth, transaction } from "@huxtrade/database";
import { BinanceFuturesClient,parseCoinGlassHeatmapUrl } from "@huxtrade/exchange-clients";
import { resolveRestingEntry } from "@huxtrade/strategy-engine";

const config = getConfig();
const app = Fastify({ logger: { redact: ["req.headers.authorization", "body.botToken", "body.apiKey"] } });
// Spec 12.1: MacBook-only access, not a public multi-origin policy. Browsers
// treat localhost and 127.0.0.1 as different origins even though they're the
// same machine, so accept whichever the operator's browser happens to use.
const webOriginUrl=new URL(config.WEB_ORIGIN);
const allowedWebOrigins=new Set([config.WEB_ORIGIN,`${webOriginUrl.protocol}//127.0.0.1:${webOriginUrl.port}`,`${webOriginUrl.protocol}//localhost:${webOriginUrl.port}`]);
await app.register(cors, { origin: (origin,callback)=>{callback(null,!origin||allowedWebOrigins.has(origin));}, methods:["GET","POST","PATCH","PUT","DELETE"] });
const binance = new BinanceFuturesClient();
// api has no polling loop and never restarts itself on service.restart_requested
// (only variational-agent needs to, to pick up the new value for enforcement),
// so its own display of this flag must be updated directly, not left cached
// from process start — otherwise the dashboard would show stale state forever.
let liveTradingEnabled=config.LIVE_TRADING_ENABLED;
let defaultMarginUsdc=config.DEFAULT_MARGIN_USDC;
let maxMarginUsdc=config.MAX_MARGIN_USDC;
let telegramBotToken=config.TELEGRAM_BOT_TOKEN;
let telegramChatId=config.TELEGRAM_CHAT_ID;
let telegramConfigured=Boolean(config.TELEGRAM_BOT_TOKEN&&config.TELEGRAM_CHAT_ID);
/** Spec 10.3/11.1: a credential-driven restart must be proven, not assumed. */
const restartDeadlineMs=90_000;

async function writeEnvValues(values:Record<string,string>){
  const path=getEnvFilePath();let content="";try{content=await readFile(path,"utf8");}catch{}
  for(const [key,value] of Object.entries(values)){
    const line=`${key}=${JSON.stringify(value)}`;
    const pattern=new RegExp(`^${key}=.*$`,"m");content=pattern.test(content)?content.replace(pattern,line):`${content.trimEnd()}\n${line}\n`;
  }
  await writeFile(path,content,{encoding:"utf8",mode:0o600});
  await chmod(path,0o600);
}

/**
 * Spec 11.1 / 10.3: request the restart, then verify it. A service that never
 * checks back in is marked degraded and reported; the new secret is kept.
 */
async function requestServiceRestart(service:string){
  const requestedAt=new Date();
  await transaction(async(client)=>{
    await client.query("INSERT INTO outbox(topic,payload) VALUES('service.restart_requested',$1)",[JSON.stringify({service,requestedAt:requestedAt.toISOString()})]);
    await client.query("INSERT INTO app_state(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()",[
      `service_restart:${service}`,
      JSON.stringify({service,status:"PENDING",requestedAt:requestedAt.toISOString(),deadlineAt:new Date(requestedAt.getTime()+restartDeadlineMs).toISOString()})
    ]);
  });
}

export async function evaluatePendingRestarts(){
  const pending=await query<{key:string;value:Record<string,unknown>}>("SELECT key,value FROM app_state WHERE key LIKE 'service_restart:%' AND value->>'status'='PENDING'");
  for(const row of pending.rows){
    const service=String(row.value.service);
    const requestedAt=new Date(String(row.value.requestedAt)).getTime();
    const deadlineAt=new Date(String(row.value.deadlineAt)).getTime();
    const health=(await query<{updated_at:string}>("SELECT updated_at FROM service_health WHERE service=$1",[service])).rows[0];
    const checkedIn=health?new Date(health.updated_at).getTime()>requestedAt:false;
    if(checkedIn){
      await query("UPDATE app_state SET value=value||'{\"status\":\"RESTARTED\"}'::jsonb,updated_at=now() WHERE key=$1",[row.key]);
      continue;
    }
    if(Date.now()<deadlineAt)continue;
    const message=`${service} did not report health within ${Math.round(restartDeadlineMs/1000)}s of the credential update restart; the new secret was kept`;
    await query("UPDATE app_state SET value=value||'{\"status\":\"FAILED\"}'::jsonb,updated_at=now() WHERE key=$1",[row.key]);
    await recordHealth(service,false,message,true,false);
    await recordBusinessError({service:"api",code:"SERVICE_RESTART_FAILED",message,blocksTrading:true,context:{service}});
    await query("INSERT INTO outbox(topic,payload) VALUES('notification.system_error',$1)",[JSON.stringify({service,reason:"SERVICE_RESTART_FAILED",message})]);
  }
}

async function sendTelegramTest(botToken:string,chatId:string,text:string){
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),12_000);
  try{
    const response=await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`,{method:"POST",signal:controller.signal,headers:{"content-type":"application/json"},body:JSON.stringify({chat_id:chatId,text})});
    if(!response.ok){
      const body=await response.json().catch(()=>({description:undefined}));
      throw new Error(body.description??`Telegram HTTP ${response.status}`);
    }
  }finally{clearTimeout(timer);}
}

const assetInput = z.object({
  // One character is a legitimate ticker — "4" trades as 4USDT — and the old
  // two-character minimum rejected it with a bare VALIDATION_ERROR.
  code: z.string().trim().min(1).max(15).transform((x) => x.toUpperCase()),
  binanceSymbol: z.string().trim().min(5).transform((x) => x.toUpperCase()),
  coinglassUrl: z.string().url(),
  variationalUrl: z.string().url(),
  collectEnabled: z.boolean().default(true), signalEnabled: z.boolean().default(true), tradeEnabled: z.boolean().default(false)
});
// Resting limit entry parameters. The bounds are deliberately narrower than
// "any positive number": these are ATR multiples and scan counts whose sane
// range is known, and a typo here would not error — it would quietly stop the
// model from ever finding a candidate.
const restingEntryInput = z.object({
  entryBandAtrMin: z.number().min(0.05).max(3),
  entryBandAtrMax: z.number().min(0.2).max(8),
  entryOffsetAtr: z.number().min(0).max(1),
  confluenceMergeAtr: z.number().min(0.05).max(2),
  replaceThresholdAtr: z.number().min(0.05).max(2),
  biasPersistenceScans: z.number().int().min(1).max(96),
  flipConfirmationScans: z.number().int().min(1).max(12),
  maxArmedAssets: z.number().int().min(1).max(fixedRules.maxAssets),
  swingScore: z.number().min(0.01).max(5),
  emaScore: z.number().min(0.01).max(5),
  incumbentScoreBonus: z.number().min(0).max(5),
  extremeMoveBlockPercent: z.number().min(0).max(200),
  lossStreakCount: z.number().int().min(0).max(20),
  lossStreakWindowHours: z.number().min(0.25).max(72),
  lossStreakHaltHours: z.number().min(0.25).max(168),
  scaleOutTriggerR: z.number().min(0).max(5),
  // Capped below 1 on purpose: closing the whole position at the trigger is
  // not a scale-out, it is a nearer take-profit that abandons the target the
  // plan was built around. resolveRestingEntry clamps too, so a value stored
  // before this bound existed still cannot take effect.
  scaleOutFraction: z.number().min(0).max(0.9),
  scaleOutMinStopPercent: z.number().min(0).max(5),
  breakevenOffsetR: z.number().min(0).max(0.5)
}).partial().refine((v) => v.entryBandAtrMin === undefined || v.entryBandAtrMax === undefined || v.entryBandAtrMin < v.entryBandAtrMax,
  "entryBandAtrMin must be smaller than entryBandAtrMax");

const strategyInput = z.object({
  name: z.string().trim().min(3).max(80), enabled: z.boolean().default(false),
  logic: z.enum(["AND", "N_OF_M"]), requiredCount: z.number().int().min(2).max(4).nullable().optional(),
  conditions: z.array(z.enum(["OI", "CVD", "FUNDING", "HEATMAP"])).min(2).max(4).refine((v) => new Set(v).size === v.length, "conditions must be unique"),
  heatmapRange: z.enum(["12h", "24h", "3d", "7d", "30d"]).default("24h"), maxOrdersPerSide: z.number().int().min(1).max(20).default(5),
  entryKind: z.enum(["MARKET_ON_SIGNAL", "RESTING_LIMIT"]).default("MARKET_ON_SIGNAL"),
  restingEntry: restingEntryInput.default({})
}).refine((v) => v.logic !== "N_OF_M" || (v.requiredCount! >= 2 && v.requiredCount! <= v.conditions.length), "invalid N-of-M count");

const camelAsset = (r: Record<string, unknown>) => ({
  id:r.id, code:r.code, binanceSymbol:r.binance_symbol, coinglassSymbol:r.coinglass_symbol, coinglassUrl:r.coinglass_url, variationalUrl:r.variational_url,
  collectEnabled:r.collect_enabled, signalEnabled:r.signal_enabled, tradeEnabled:r.trade_enabled,
  paused:r.paused, pauseReason:r.pause_reason, lastUpdatedAt:r.last_updated_at,
  connectionStatus:r.paused?"ERROR":!r.closed_at?"PENDING":Date.now()-new Date(String(r.closed_at)).getTime()<=fixedRules.heatmapStaleMs?"CONNECTED":"STALE",
  market:r.closed_at?{price:Number(r.price),oiChange1h:r.oi_change_1h==null?null:Number(r.oi_change_1h),oiZ:r.oi_z==null?null:Number(r.oi_z),oiPassed:Boolean(r.oi_passed),cvd:r.cvd_value==null?null:Number(r.cvd_value),cvdZ:r.cvd_z==null?null:Number(r.cvd_z),cvdPassed:Boolean(r.cvd_passed),funding:r.funding_value==null?null:Number(r.funding_value),fundingZ:r.funding_z==null?null:Math.max(Math.abs(Number(r.funding_z)),Math.abs(Number(r.funding_change_z??0))),fundingPassed:Boolean(r.funding_passed),heatmapPassed:Boolean(r.heatmap_passed),warmupReady:Boolean(r.warmup_ready),closedAt:r.closed_at}:undefined
});

// The API container cannot reach the operator's Chrome; it hands captures to
// the natively-running coinglass-agent through a Postgres app_state
// request/result handshake (mirrors the scheduled coinglass_refresh_request).
async function requestCoinGlassCapture(sourceUrl:string,range:"12h"|"24h"|"3d"|"7d"|"30d"="24h"){
  const requestId=randomUUID();
  await query(`INSERT INTO app_state(key,value) VALUES('coinglass_probe_request',$1)
    ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`,[JSON.stringify({requestId,requestedAt:new Date().toISOString(),sourceUrl,range})]);
  const deadline=Date.now()+45_000;
  while(Date.now()<deadline){
    await new Promise((r)=>setTimeout(r,500));
    const row=(await query<{value:Record<string,unknown>}>("SELECT value FROM app_state WHERE key='coinglass_probe_result'")).rows[0]?.value;
    if(row?.requestId===requestId){
      if(row.ok)return {regions:row.regions as unknown[],raw:row.raw,sourceUrl:String(row.sourceUrl),capturedAt:new Date(String(row.capturedAt))};
      throw new Error(String(row.error??"CoinGlass 采集失败"));
    }
  }
  throw new Error("CoinGlass Agent 未在规定时间内响应，请确认浏览器已登录并处于运行状态（COINGLASS_ADAPTER_MODE=browser）");
}

async function captureCoinGlassHeatmap(value:string){
  const parsed=parseCoinGlassHeatmapUrl(value);
  const captured=await requestCoinGlassCapture(parsed.url,"24h");
  return {parsed,captured};
}
const camelStrategy = (r: Record<string, unknown>) => ({
  id:r.id, name:r.name, enabled:r.enabled, logic:r.logic, requiredCount:r.required_count, conditions:r.conditions,
  heatmapRange:r.heatmap_range, maxOrdersPerSide:r.max_orders_per_side, entryKind:r.entry_kind,
  // Always resolved, never the raw override object: the UI has to show the
  // numbers the engine will actually use, including the ones nobody set.
  restingEntry:resolveRestingEntry(r.resting_entry as Record<string,number>|null)
});

app.setErrorHandler(async(error, _request, reply) => {
  if (error instanceof z.ZodError) return reply.code(400).send({ error: "VALIDATION_ERROR", issues: error.issues });
  app.log.error(error);
  await recordBusinessError({service:"api",code:"UNHANDLED_API_ERROR",message:error instanceof Error?error.message:String(error)});
  return reply.code(500).send({ error: "INTERNAL_ERROR", message: error instanceof Error ? error.message : "Unknown error" });
});

app.get("/health", async () => {
  await query("SELECT 1");
  await recordHealth("api",true);
  return { status: "ok", service: "api", time: new Date().toISOString() };
});

/**
 * The dashboard serves the gainers basket, which is the only strategy that
 * trades. It deliberately reads no orders/positions row: the basket writes
 * neither, so those tables only still hold the retired resting-entry model's
 * records, and rendering them showed a two-week-old book beside an empty
 * "current positions" table while four leveraged legs were actually open.
 */
app.get("/api/dashboard", async () => {
  const [services, gainers, risk, legs, closes] = await Promise.all([
    query("SELECT * FROM service_health ORDER BY service"),
    query<{ value:Record<string,unknown> }>("SELECT value FROM app_state WHERE key='gainers_scheduler'"),
    query<{ value:Record<string,unknown> }>("SELECT value FROM app_state WHERE key='account_risk'"),
    // The venue snapshot carries no exits, so the planned TP/SL come from the
    // leg notification the agent emitted when it opened that leg.
    query<{ base:string; payload:Record<string,unknown> }>(`SELECT DISTINCT ON (payload->>'base') payload->>'base' base, payload
      FROM outbox WHERE topic='notification.gainers_leg' ORDER BY payload->>'base', created_at DESC`),
    query<{ created_at:string; payload:Record<string,unknown> }>(`SELECT created_at, payload FROM outbox
      WHERE topic='notification.gainers_closed' AND jsonb_array_length(coalesce(payload->'closed','[]'::jsonb))>0
      ORDER BY created_at DESC LIMIT 30`)
  ]);

  const state=gainers.rows[0]?.value ?? {};
  const exits=new Map(legs.rows.map((r) => [r.base, r.payload]));
  const num=(value:unknown)=>value==null?null:Number(value);

  const positions=(Array.isArray(state.positions)?state.positions:[]).map((raw) => {
    const p=raw as Record<string,unknown>;
    const leg=exits.get(String(p.symbol));
    return {
      symbol:String(p.symbol), quantity:Number(p.qty),
      entryPrice:Number(p.entryPrice), markPrice:num(p.markPrice), unrealizedPnl:num(p.unrealizedPnl),
      takeProfit:num(leg?.takeProfit), stopLoss:num(leg?.stopLoss), marginUsdc:num(leg?.margin),
      openedAt:p.openedAt==null?null:String(p.openedAt)
    };
  });

  const history=closes.rows.map((row) => {
    const closed=(row.payload.closed ?? []) as Array<Record<string,unknown>>;
    return {
      closedAt:new Date(String(row.created_at)).toISOString(),
      mode:String(row.payload.mode ?? "正式"), legs:closed.length,
      realizedPnl:closed.reduce((sum,leg) => sum+Number(leg.realizedPnl ?? 0),0)
    };
  });

  return {
    generatedAt:new Date().toISOString(), liveTradingEnabled,
    marginUsagePercent:Number(risk.rows[0]?.value.marginUsagePercent ?? 0),
    balanceUsdc:Number(risk.rows[0]?.value.balanceUsdc ?? 0),
    services:services.rows.map((x) => ({ service:x.service, state:x.state, lastSuccessAt:x.last_success_at, consecutiveFailures:x.consecutive_failures, error:x.error, blocksTrading:x.blocks_trading })),
    gainers:{
      enabled:Boolean(state.enabled),
      marginUsdc:num(state.marginUsdc),
      closeAt:state.closeAt==null?null:String(state.closeAt),
      openLegs:Array.isArray(state.open)?(state.open as unknown[]).length:0,
      positions, positionsAt:state.positionsAt==null?null:String(state.positionsAt),
      history,
      // Scheduled baskets only. Test baskets run at a tenth of the size and on
      // demand, so folding them into the headline P&L measures the operator's
      // experiments rather than the strategy.
      stats:(() => {
        const scheduled=history.filter((b) => b.mode==="正式");
        return {
          baskets:scheduled.length,
          winners:scheduled.filter((b) => b.realizedPnl>0).length,
          realizedPnl:scheduled.reduce((sum,b) => sum+b.realizedPnl,0)
        };
      })()
    }
  };
});

app.get("/api/assets", async () => (await query(`SELECT a.*,i.closed_at,i.price,i.oi_change_1h,i.oi_z,i.oi_passed,i.cvd_value,i.cvd_z,i.cvd_passed,i.funding_value,i.funding_z,i.funding_change_z,i.funding_passed,i.heatmap_passed,i.warmup_ready
  FROM assets a LEFT JOIN LATERAL(SELECT * FROM indicator_snapshots s WHERE s.asset_id=a.id ORDER BY s.closed_at DESC LIMIT 1)i ON true ORDER BY a.code`)).rows.map((x) => camelAsset(x as Record<string,unknown>)));
app.get("/api/market/:symbol/candles",async(request)=>{
  const symbol=z.string().regex(/^[A-Z0-9]{5,20}$/).parse((request.params as {symbol:string}).symbol.toUpperCase());
  const params=z.object({interval:z.enum(["5m","15m","1h","4h","1d"]).default("15m"),limit:z.coerce.number().int().min(20).max(500).default(200)}).parse(request.query);
  const candles=await binance.klines(symbol,params.interval,params.limit);
  const asset=(await query<{id:string}>("SELECT id FROM assets WHERE binance_symbol=$1",[symbol])).rows[0];
  if(!asset)return {symbol,interval:params.interval,candles,signals:[],orders:[],heatmap:[]};
  const [signals,orders,snapshot]=await Promise.all([
    query(`SELECT closed_at,direction,accepted,executable FROM signals WHERE asset_id=$1 AND closed_at>=to_timestamp($2/1000.0) ORDER BY closed_at`,[asset.id,candles[0]?.openTime??Date.now()]),
    // Only orders that exist on the platform right now get a price line. The
    // resting model replaces an order every time the structure moves, so
    // "created inside the candle window" accumulated every cancelled and
    // closed order as a full-width line — AAVE drew 39 of them for 13 dead
    // orders and no live one. A line across the chart asserts "this price
    // matters now", which a cancelled order's entry does not. Live orders are
    // not time-filtered either: a position opened before the window still has
    // a stop that matters.
    query(`SELECT created_at,direction,state,entry_price,stop_loss,take_profit FROM orders
      WHERE asset_id=$1 AND state IN ('PENDING_ENTRY','FILLED_OPEN') ORDER BY created_at`,[asset.id]),
    query<{heatmap:unknown}>("SELECT heatmap FROM indicator_snapshots WHERE asset_id=$1 ORDER BY closed_at DESC LIMIT 1",[asset.id])
  ]);
  return {symbol,interval:params.interval,candles,signals:signals.rows,orders:orders.rows,heatmap:snapshot.rows[0]?.heatmap??[]};
});
app.post("/api/assets/validate", async (request, reply) => {
  const input = assetInput.pick({ binanceSymbol:true, coinglassUrl:true }).parse(request.body);
  const binanceOk = await binance.validateSymbol(input.binanceSymbol);
  let coinglassOk = false, heatmapError: string | null = null,regionCount=0,capturedAt:string|null=null;
  try {
    const {parsed,captured}=await captureCoinGlassHeatmap(input.coinglassUrl);
    if(parsed.symbol!==`Binance_${input.binanceSymbol}`)throw new Error(`CoinGlass coin ${parsed.coin} does not match Binance symbol ${input.binanceSymbol}`);
    coinglassOk = true;regionCount=captured.regions.length;capturedAt=captured.capturedAt.toISOString();
  } catch (e) { heatmapError = e instanceof Error ? e.message : String(e); }
  if (!binanceOk || !coinglassOk) return reply.code(422).send({ binanceOk, coinglassOk, heatmapError });
  return { binanceOk, coinglassOk,regionCount,capturedAt };
});
app.post("/api/assets", async (request, reply) => {
  let input = assetInput.parse(request.body);
  const count=await query<{count:string}>("SELECT count(*)::text count FROM assets");if(Number(count.rows[0]?.count??0)>=fixedRules.maxAssets)return reply.code(409).send({error:"ASSET_LIMIT_REACHED",message:`白名单已达 ${fixedRules.maxAssets} 个上限`});
  const resolved=await binance.resolvePerpetualSymbol(input.code);if(!resolved)return reply.code(422).send({error:"BINANCE_SYMBOL_INVALID"});input={...input,binanceSymbol:resolved};
  let coinglass;try { coinglass=await captureCoinGlassHeatmap(input.coinglassUrl); } catch (e) { return reply.code(422).send({ error:"COINGLASS_HEATMAP_INVALID", message:e instanceof Error?e.message:String(e) }); }
  if(coinglass.parsed.symbol!==`Binance_${resolved}`)return reply.code(422).send({error:"COINGLASS_SYMBOL_MISMATCH",message:`CoinGlass coin ${coinglass.parsed.coin} does not match Binance symbol ${resolved}`});
  const saved = await transaction(async(client)=>{
    const result = await client.query(`INSERT INTO assets(code,binance_symbol,coinglass_symbol,coinglass_url,variational_url,collect_enabled,signal_enabled,trade_enabled)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [input.code,input.binanceSymbol,coinglass.parsed.symbol,coinglass.parsed.url,input.variationalUrl,input.collectEnabled,input.signalEnabled,input.tradeEnabled]);
    await client.query(`INSERT INTO coinglass_heatmaps(asset_id,heatmap_range,source_url,captured_at,regions,raw) VALUES($1,'24h',$2,$3,$4,$5)`,[
      result.rows[0].id,coinglass.captured.sourceUrl,coinglass.captured.capturedAt,JSON.stringify(coinglass.captured.regions),JSON.stringify(coinglass.captured.raw)
    ]);
    return result.rows[0];
  });
  return reply.code(201).send(camelAsset(saved as Record<string,unknown>));
});
app.patch("/api/assets/:id", async (request,reply) => {
  const id=z.string().uuid().parse((request.params as {id:string}).id); let input=assetInput.partial().parse(request.body);
  const current=(await query<Record<string,unknown>>("SELECT * FROM assets WHERE id=$1",[id])).rows[0];
  if(!current)return reply.code(404).send({error:"ASSET_NOT_FOUND"});
  if((!input.code||input.code===current.code)&&input.binanceSymbol&&input.binanceSymbol!==current.binance_symbol)return reply.code(400).send({error:"MAPPING_MANAGED_AUTOMATICALLY"});
  if(input.code&&input.code!==current.code){const resolved=await binance.resolvePerpetualSymbol(input.code);if(!resolved)return reply.code(422).send({error:"BINANCE_SYMBOL_INVALID"});input={...input,binanceSymbol:resolved};}
  if(input.binanceSymbol&&input.binanceSymbol!==current.binance_symbol&&!await binance.validateSymbol(input.binanceSymbol))return reply.code(422).send({error:"BINANCE_SYMBOL_INVALID"});
  let capturedCoinGlass:Awaited<ReturnType<typeof captureCoinGlassHeatmap>>|undefined;if(input.coinglassUrl&&input.coinglassUrl!==current.coinglass_url){try{capturedCoinGlass=await captureCoinGlassHeatmap(input.coinglassUrl);input={...input,coinglassUrl:capturedCoinGlass.parsed.url};}catch(error){return reply.code(422).send({error:"COINGLASS_HEATMAP_INVALID",message:error instanceof Error?error.message:String(error)});}}
  const parsedCoinGlass=capturedCoinGlass?.parsed;
  const effectiveCoinGlass=parsedCoinGlass??parseCoinGlassHeatmapUrl(String(current.coinglass_url));
  const effectiveBinance=String(input.binanceSymbol??current.binance_symbol);
  if(effectiveCoinGlass.symbol!==`Binance_${effectiveBinance}`)return reply.code(422).send({error:"COINGLASS_SYMBOL_MISMATCH",message:`CoinGlass coin ${effectiveCoinGlass.coin} does not match Binance symbol ${effectiveBinance}`});
  const keys:Record<string,string>={code:"code",binanceSymbol:"binance_symbol",coinglassUrl:"coinglass_url",variationalUrl:"variational_url",collectEnabled:"collect_enabled",signalEnabled:"signal_enabled",tradeEnabled:"trade_enabled"};
  const entries=Object.entries(input); if(!entries.length) throw new Error("empty update");
  if(parsedCoinGlass)entries.push(["coinglassSymbol",parsedCoinGlass.symbol]);
  keys.coinglassSymbol="coinglass_symbol";
  const values=entries.map(([,v])=>v); const sets=entries.map(([k],i)=>`${keys[k]}=$${i+1}`);
  const saved=await transaction(async(client)=>{
    const result=await client.query(`UPDATE assets SET ${sets.join(",")},updated_at=now() WHERE id=$${values.length+1} RETURNING *`,[...values,id]);
    if(capturedCoinGlass)await client.query(`INSERT INTO coinglass_heatmaps(asset_id,heatmap_range,source_url,captured_at,regions,raw)
      VALUES($1,'24h',$2,$3,$4,$5) ON CONFLICT(asset_id,heatmap_range) DO UPDATE SET source_url=EXCLUDED.source_url,captured_at=EXCLUDED.captured_at,regions=EXCLUDED.regions,raw=EXCLUDED.raw,updated_at=now()`,[
      id,capturedCoinGlass.captured.sourceUrl,capturedCoinGlass.captured.capturedAt,JSON.stringify(capturedCoinGlass.captured.regions),JSON.stringify(capturedCoinGlass.captured.raw)
    ]);
    return result.rows[0];
  });
  return camelAsset(saved as Record<string,unknown>);
});
app.delete("/api/assets/:id", async (request,reply) => { const id=z.string().uuid().parse((request.params as {id:string}).id);const used=await query<{count:string}>(`SELECT (SELECT count(*) FROM signals WHERE asset_id=$1)+(SELECT count(*) FROM orders WHERE asset_id=$1)+(SELECT count(*) FROM positions WHERE asset_id=$1) count`,[id]);if(Number(used.rows[0]?.count??0)>0)return reply.code(409).send({error:"ASSET_HAS_AUDIT_HISTORY",message:"有业务历史的币种只能停用，不能删除"});await query("DELETE FROM assets WHERE id=$1",[id]); return reply.code(204).send(); });

app.get("/api/strategies", async () => (await query("SELECT * FROM strategies ORDER BY created_at")).rows.map((x)=>camelStrategy(x as Record<string,unknown>)));
app.post("/api/strategies", async (request,reply) => {
  const input=strategyInput.parse(request.body);
  const row=await transaction(async (client)=>{
    if(input.enabled){ await client.query("UPDATE strategies SET enabled=false,updated_at=now() WHERE enabled=true");await client.query("UPDATE heatmap_candidates SET status='INVALIDATED',invalid_reason='STRATEGY_SWITCH' WHERE status IN ('ARMED','CONFIRMED')");}
    const result=await client.query(`INSERT INTO strategies(name,enabled,logic,required_count,conditions,heatmap_range,max_orders_per_side,entry_kind,resting_entry)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[input.name,input.enabled,input.logic,input.requiredCount??null,input.conditions,input.heatmapRange,input.maxOrdersPerSide,input.entryKind,JSON.stringify(input.restingEntry)]);
    if(input.enabled) await client.query("INSERT INTO outbox(topic,payload) VALUES('strategy.changed',$1)",[JSON.stringify({strategyId:result.rows[0].id})]);
    return result.rows[0];
  });
  return reply.code(201).send(camelStrategy(row));
});
app.post("/api/strategies/:id/enable", async (request,reply) => {
  const id=z.string().uuid().parse((request.params as {id:string}).id);
  const exists=await query("SELECT 1 FROM strategies WHERE id=$1",[id]);if(!exists.rowCount)return reply.code(404).send({error:"STRATEGY_NOT_FOUND"});
  await transaction(async(client)=>{ await client.query("UPDATE strategies SET enabled=false,updated_at=now() WHERE enabled=true"); await client.query("UPDATE strategies SET enabled=true,updated_at=now() WHERE id=$1",[id]);await client.query("UPDATE heatmap_candidates SET status='INVALIDATED',invalid_reason='STRATEGY_SWITCH' WHERE status IN ('ARMED','CONFIRMED') AND strategy_id<>$1",[id]); await client.query("INSERT INTO outbox(topic,payload) VALUES('strategy.changed',$1)",[JSON.stringify({strategyId:id})]); });
  return {ok:true};
});
app.patch("/api/strategies/:id",async(request,reply)=>{
  const id=z.string().uuid().parse((request.params as {id:string}).id);
  const current=(await query<Record<string,unknown>>("SELECT * FROM strategies WHERE id=$1",[id])).rows[0];if(!current)return reply.code(404).send({error:"STRATEGY_NOT_FOUND"});
  const partial=z.object({name:z.string().trim().min(3).max(80),enabled:z.boolean(),logic:z.enum(["AND","N_OF_M"]),requiredCount:z.number().int().min(2).max(4).nullable(),conditions:z.array(z.enum(["OI","CVD","FUNDING","HEATMAP"])).min(2).max(4),heatmapRange:z.enum(["12h","24h","3d","7d","30d"]),maxOrdersPerSide:z.number().int().min(1).max(20),entryKind:z.enum(["MARKET_ON_SIGNAL","RESTING_LIMIT"]),restingEntry:restingEntryInput}).partial().parse(request.body);
  // Resting-entry keys merge field by field, like every other column here: a
  // PATCH that only moves maxArmedAssets must not silently reset the band.
  const merged=strategyInput.parse({name:partial.name??current.name,enabled:partial.enabled??current.enabled,logic:partial.logic??current.logic,requiredCount:"requiredCount" in partial?partial.requiredCount:current.required_count,conditions:partial.conditions??current.conditions,heatmapRange:partial.heatmapRange??current.heatmap_range,maxOrdersPerSide:partial.maxOrdersPerSide??current.max_orders_per_side,entryKind:partial.entryKind??current.entry_kind,restingEntry:{...(current.resting_entry as Record<string,number>|null??{}),...partial.restingEntry}});
  const row=await transaction(async(client)=>{if(merged.enabled){await client.query("UPDATE strategies SET enabled=false,updated_at=now() WHERE enabled=true AND id<>$1",[id]);await client.query("UPDATE heatmap_candidates SET status='INVALIDATED',invalid_reason='STRATEGY_SWITCH' WHERE status IN ('ARMED','CONFIRMED')");}const result=await client.query(`UPDATE strategies SET name=$1,enabled=$2,logic=$3,required_count=$4,conditions=$5,heatmap_range=$6,max_orders_per_side=$7,entry_kind=$8,resting_entry=$9,updated_at=now() WHERE id=$10 RETURNING *`,[merged.name,merged.enabled,merged.logic,merged.requiredCount??null,merged.conditions,merged.heatmapRange,merged.maxOrdersPerSide,merged.entryKind,JSON.stringify(merged.restingEntry),id]);if(merged.enabled)await client.query("INSERT INTO outbox(topic,payload) VALUES('strategy.changed',$1)",[JSON.stringify({strategyId:id})]);return result.rows[0];});
  return camelStrategy(row);
});
app.delete("/api/strategies/:id",async(request,reply)=>{const id=z.string().uuid().parse((request.params as {id:string}).id);const current=(await query<{enabled:boolean}>("SELECT enabled FROM strategies WHERE id=$1",[id])).rows[0];if(!current)return reply.code(404).send({error:"STRATEGY_NOT_FOUND"});if(current.enabled)return reply.code(409).send({error:"ACTIVE_STRATEGY",message:"请先启用另一套策略"});const used=await query<{count:string}>("SELECT (SELECT count(*) FROM signals WHERE strategy_id=$1)+(SELECT count(*) FROM orders WHERE strategy_id=$1) count",[id]);if(Number(used.rows[0]?.count??0)>0)return reply.code(409).send({error:"STRATEGY_HAS_AUDIT_HISTORY",message:"有信号或订单历史的策略只能停用，不能删除"});await query("DELETE FROM strategies WHERE id=$1",[id]);return reply.code(204).send();});

app.get("/api/orders", async (request) => {
  const state=z.string().optional().parse((request.query as {state?:string}).state);
  return (await query(`SELECT o.*,a.code,a.variational_url,s.name strategy_name FROM orders o JOIN assets a ON a.id=o.asset_id JOIN strategies s ON s.id=o.strategy_id ${state?"WHERE o.state=$1":""} ORDER BY o.updated_at DESC LIMIT 250`,state?[state]:[])).rows;
});
app.get("/api/positions",async()=> (await query(`SELECT p.*,a.code,a.variational_url,o.state order_state,o.updated_at order_updated_at
  FROM positions p JOIN assets a ON a.id=p.asset_id JOIN orders o ON o.id=p.order_id
  ORDER BY coalesce(p.closed_at,p.opened_at) DESC LIMIT 250`)).rows);
app.get("/api/fills",async(request)=>{
  const input=z.object({limit:z.coerce.number().int().min(1).max(500).default(100)}).parse(request.query);
  return (await query(`SELECT f.*,a.code,o.direction FROM fills f JOIN orders o ON o.id=f.order_id JOIN assets a ON a.id=o.asset_id
    ORDER BY f.filled_at DESC LIMIT $1`,[input.limit])).rows;
});
/**
 * The working-order board. Distance to market is reported in ATR as well as
 * percent because ATR is the unit every threshold in the model is expressed
 * in — "0.9 ATR away" says whether the order is inside its band, "1.4%" does
 * not. The ATR comes from the scan that placed or last revalidated the order,
 * which is exactly the number the decision was made against.
 */
app.get("/api/resting-orders", async () => (await query(`SELECT o.id,o.direction,o.state,o.entry_price,o.stop_loss,o.take_profit,o.margin_usdc,
  o.entry_provenance,o.revalidated_at,o.created_at,o.platform_order_id,o.awaiting_trigger,o.trigger_touched_at,a.code,a.variational_url,
  i.price market_price,i.closed_at market_closed_at,
  (SELECT p.decision_reason FROM entry_plans p WHERE p.working_order_id=o.id ORDER BY p.closed_at DESC LIMIT 1) last_decision_reason
  FROM orders o JOIN assets a ON a.id=o.asset_id
  LEFT JOIN LATERAL (SELECT price,closed_at FROM indicator_snapshots s WHERE s.asset_id=o.asset_id ORDER BY closed_at DESC LIMIT 1) i ON true
  WHERE o.entry_kind='RESTING_LIMIT' AND (o.state='PENDING_ENTRY' OR (o.state='CREATED_LOCAL' AND o.awaiting_trigger))
  ORDER BY o.awaiting_trigger DESC,o.created_at`)).rows.map((raw)=>{
  const row=raw as Record<string,unknown>;
  const provenance=row.entry_provenance as {atr1h?:number;sources?:string[];score?:number}|null;
  const level=Number(row.entry_price),market=row.market_price==null?null:Number(row.market_price);
  const atr=provenance?.atr1h&&provenance.atr1h>0?provenance.atr1h:null;
  const distance=market==null?null:Math.abs(market-level);
  const risk=Math.abs(level-Number(row.stop_loss));
  return {
    id:row.id,code:row.code,direction:row.direction,level,stopLoss:Number(row.stop_loss),takeProfit:Number(row.take_profit),
    // A virtual entry is held locally and has nothing on the venue yet: the
    // board has to say so, or an operator reads it as an order that exists.
    awaitingTrigger:Boolean(row.awaiting_trigger),
    triggerTouchedAt:row.trigger_touched_at==null?null:new Date(String(row.trigger_touched_at)).toISOString(),
    marginUsdc:row.margin_usdc==null?null:Number(row.margin_usdc),marketPrice:market,
    distanceAtr:distance==null||!atr?null:distance/atr,
    distancePercent:distance==null||!market?null:distance/market*100,
    expectedRiskReward:risk>0?Math.abs(Number(row.take_profit)-level)/risk:null,
    sources:provenance?.sources??[],score:provenance?.score??null,provenance,
    ageMinutes:(Date.now()-new Date(String(row.created_at)).getTime())/60_000,
    revalidatedAt:row.revalidated_at,createdAt:row.created_at,lastDecisionReason:row.last_decision_reason,
    platformOrderId:row.platform_order_id,variationalUrl:row.variational_url
  };
}));

app.get("/api/entry-plans",async(request)=>{
  const input=z.object({
    limit:z.coerce.number().int().min(1).max(500).default(100),
    offset:z.coerce.number().int().min(0).default(0),
    assetId:z.string().uuid().optional(),
    mode:z.enum(["shadow","live"]).optional(),
    decision:z.enum(["PLACE","KEEP","REPLACE","CANCEL","CLOSE_OPPOSITE","NONE"]).optional()
  }).parse(request.query);
  const filters:string[]=[],values:unknown[]=[];
  if(input.assetId){values.push(input.assetId);filters.push(`p.asset_id=$${values.length}`);}
  if(input.mode){values.push(input.mode);filters.push(`p.mode=$${values.length}`);}
  if(input.decision){values.push(input.decision);filters.push(`p.decision=$${values.length}`);}
  const where=filters.length?`WHERE ${filters.join(" AND ")}`:"";
  const [rows,total]=await Promise.all([
    query(`SELECT p.*,a.code FROM entry_plans p JOIN assets a ON a.id=p.asset_id ${where}
      ORDER BY p.closed_at DESC,a.code LIMIT $${values.length+1} OFFSET $${values.length+2}`,[...values,input.limit,input.offset]),
    query<{count:string}>(`SELECT count(*)::text count FROM entry_plans p ${where}`,values)
  ]);
  return {rows:rows.rows,total:Number(total.rows[0]?.count??0)};
});

/**
 * The shadow-vs-live comparison from spec 6-2. Fill rate is counted over
 * decisions that actually put an order on the book; the average entry
 * distance is what the model bought with all that waiting; realised R is
 * grouped by exit reason so a good ratio built entirely out of stop-outs
 * cannot hide inside an average.
 */
app.get("/api/resting-statistics",async()=>{
  const [ledger,outcomes]=await Promise.all([
    query<{mode:string;decision:string;count:string}>("SELECT mode,decision,count(*)::text count FROM entry_plans GROUP BY mode,decision"),
    query<{state:string;count:string;avg_rr:string|null;avg_distance:string|null}>(`SELECT o.state,count(*)::text count,
      avg(CASE WHEN abs(o.entry_price-o.stop_loss)>0 THEN (coalesce(o.realized_pnl,0)+coalesce(o.scaled_out_pnl,0))/(o.margin_usdc*abs(o.entry_price-o.stop_loss)/o.entry_price*o.leverage) END)::text avg_rr,
      avg(abs((o.entry_provenance->>'referencePrice')::numeric-o.entry_price)/nullif((o.entry_provenance->>'atr1h')::numeric,0))::text avg_distance
      FROM orders o WHERE o.entry_kind='RESTING_LIMIT' AND o.state IN ('CLOSED_TP','CLOSED_SL','LIQUIDATED','CLOSED_REVERSED') GROUP BY o.state`)
  ]);
  const placed=ledger.rows.filter((row)=>["PLACE","REPLACE"].includes(row.decision)).reduce((sum,row)=>sum+Number(row.count),0);
  const filled=(await query<{count:string}>("SELECT count(*)::text count FROM orders WHERE entry_kind='RESTING_LIMIT' AND state IN ('FILLED_OPEN','CLOSED_TP','CLOSED_SL','LIQUIDATED','CLOSED_REVERSED')")).rows[0];
  const filledCount=Number(filled?.count??0);
  return {
    ledger:ledger.rows.map((row)=>({...row,count:Number(row.count)})),
    placed,filled:filledCount,fillRate:placed?filledCount/placed:0,
    byExit:outcomes.rows.map((row)=>({state:row.state,count:Number(row.count),averageRealizedRiskReward:row.avg_rr==null?null:Number(row.avg_rr),averageEntryDistanceAtr:row.avg_distance==null?null:Number(row.avg_distance)}))
  };
});

app.get("/api/statistics", async () => {const summary=(await query(`SELECT s.id,s.name,
  (SELECT count(*) FROM signals sig WHERE sig.strategy_id=s.id AND sig.accepted)::int signals,
  (SELECT count(*) FROM signals sig WHERE sig.strategy_id=s.id AND sig.accepted AND NOT sig.executable)::int non_executable_signals,
  (SELECT count(*) FROM orders o WHERE o.strategy_id=s.id)::int orders,
  (SELECT count(*) FROM orders o WHERE o.strategy_id=s.id AND o.state IN ('FILLED_OPEN','CLOSED_TP','CLOSED_SL','LIQUIDATED'))::int fills,
  (SELECT count(*) FROM orders o WHERE o.strategy_id=s.id AND o.state IN ('CLOSED_TP','CLOSED_SL'))::int closed,
  (SELECT count(*) FROM orders o WHERE o.strategy_id=s.id AND o.state='CLOSED_TP')::int wins,
  coalesce((SELECT sum(coalesce(o.realized_pnl,0)+coalesce(o.scaled_out_pnl,0)) FROM orders o WHERE o.strategy_id=s.id),0)::float realized_pnl
  FROM strategies s ORDER BY s.created_at`)).rows;const outcomes=await query<{strategy_id:string;state:string}>("SELECT strategy_id,state FROM orders WHERE state IN ('CLOSED_TP','CLOSED_SL') ORDER BY updated_at");return summary.map((row)=>{let wins=0,losses=0,maxConsecutiveWins=0,maxConsecutiveLosses=0;for(const outcome of outcomes.rows.filter((item)=>item.strategy_id===row.id)){if(outcome.state==="CLOSED_TP"){wins+=1;losses=0;maxConsecutiveWins=Math.max(maxConsecutiveWins,wins);}else{losses+=1;wins=0;maxConsecutiveLosses=Math.max(maxConsecutiveLosses,losses);}}return {...row,max_consecutive_wins:maxConsecutiveWins,max_consecutive_losses:maxConsecutiveLosses};});});

app.get("/api/signals",async(request)=>{
  const input=z.object({
    limit:z.coerce.number().int().min(1).max(200).default(50),
    offset:z.coerce.number().int().min(0).default(0),
    assetId:z.string().uuid().optional(),
    strategyId:z.string().uuid().optional()
  }).parse(request.query);
  const filters:string[]=[],values:unknown[]=[];
  if(input.assetId){values.push(input.assetId);filters.push(`sig.asset_id=$${values.length}`);}
  if(input.strategyId){values.push(input.strategyId);filters.push(`sig.strategy_id=$${values.length}`);}
  const where=filters.length?`WHERE ${filters.join(" AND ")}`:"";
  const [rows,total]=await Promise.all([
    query(`SELECT sig.id,sig.closed_at,sig.direction,sig.executable,sig.accepted,sig.conditions,sig.rejection_reasons,
      a.code asset_code,s.name strategy_name,s.conditions strategy_conditions,o.id order_id,o.state order_state,o.entry_price,o.stop_loss,o.take_profit,o.realized_pnl
      FROM signals sig JOIN assets a ON a.id=sig.asset_id JOIN strategies s ON s.id=sig.strategy_id LEFT JOIN orders o ON o.signal_id=sig.id
      ${where} ORDER BY sig.closed_at DESC LIMIT $${values.length+1} OFFSET $${values.length+2}`,[...values,input.limit,input.offset]),
    query<{count:string}>(`SELECT count(*)::text count FROM signals sig ${where}`,values)
  ]);
  return {rows:rows.rows,total:Number(total.rows[0]?.count??0)};
});
app.post("/api/control/global", async (request) => {
  const input=z.object({paused:z.boolean(),reason:z.string().max(300).nullable().optional()}).parse(request.body);
  const latest=(await query<{closed_at:string}>("SELECT max(closed_at)::text closed_at FROM indicator_snapshots")).rows[0]?.closed_at;
  await transaction(async(client)=>{ await client.query("INSERT INTO app_state(key,value) VALUES('global_pause',$1) ON CONFLICT(key) DO UPDATE SET value=$1,updated_at=now()",[JSON.stringify(input)]);if(latest)await client.query("INSERT INTO app_state(key,value) VALUES('signal_cursor',$1) ON CONFLICT(key) DO UPDATE SET value=$1,updated_at=now()",[JSON.stringify({closedAt:latest})]); await client.query("INSERT INTO outbox(topic,payload) VALUES($1,$2)",[input.paused?"control.global_pause":"control.global_resume",JSON.stringify(input)]); });
  return {ok:true};
});
app.post("/api/control/assets/:id", async (request) => {
  const id=z.string().uuid().parse((request.params as {id:string}).id); const input=z.object({paused:z.boolean(),reason:z.string().max(300).nullable().optional()}).parse(request.body);
  await transaction(async(client)=>{await client.query("UPDATE assets SET paused=$1,pause_reason=$2,updated_at=now() WHERE id=$3",[input.paused,input.reason??null,id]);if(input.paused)await client.query(`INSERT INTO asset_signal_cursors(asset_id,closed_at) SELECT $1,max(closed_at) FROM indicator_snapshots WHERE asset_id=$1 HAVING max(closed_at) IS NOT NULL ON CONFLICT(asset_id) DO UPDATE SET closed_at=EXCLUDED.closed_at,updated_at=now()`,[id]);}); return {ok:true};
});

app.get("/api/settings/status", async () => {
  const [sessionRow,gainersRow]=await Promise.all([
    query<{value:Record<string,unknown>}>("SELECT value FROM app_state WHERE key='coinglass_session'"),
    query<{value:Record<string,unknown>}>("SELECT value FROM app_state WHERE key='gainers_scheduler'")
  ]);
  const session=sessionRow.rows[0]?.value,gainers=gainersRow.rows[0]?.value??{};
  return {
    coinglassMode:config.COINGLASS_ADAPTER_MODE,coinglassReady:Boolean(session?.ready??session?.loggedIn),coinglassError:session?.error??null,
    telegramConfigured,variationalMode:config.VARIATIONAL_ADAPTER_MODE,binanceMode:Boolean(config.BINANCE_API_KEY&&config.BINANCE_SECRET_KEY),liveTradingEnabled,defaultMarginUsdc,maxMarginUsdc,
    gainersEnabled:Boolean(gainers.enabled),
    gainersMarginUsdc:gainers.marginUsdc==null?null:Number(gainers.marginUsdc),
    gainersCloseAt:gainers.closeAt==null?null:String(gainers.closeAt),
    gainersOpenLegs:Array.isArray(gainers.open)?(gainers.open as unknown[]).length:0,
    gainersTestState:String((gainers.test as {state?:string}|undefined)?.state??"IDLE"),
    gainersTestLegs:Array.isArray((gainers.test as {legs?:unknown[]}|undefined)?.legs)?((gainers.test as {legs:unknown[]}).legs).length:0
  };
});
app.get("/api/settings/secrets/:kind",async(request)=>{
  const kind=z.enum(["telegram"]).parse((request.params as {kind:string}).kind);
  void kind;
  return {botToken:telegramBotToken,chatId:telegramChatId};
});

// The CoinGlass session lives inside the coinglass-agent's own logged-in
// Chrome profile (§13.2 style: no credential to store), not an .env secret;
// this only proves the agent can currently reach a live Heatmap.
app.post("/api/settings/coinglass/test",async(request,reply)=>{
  const input=z.object({coinglassUrl:z.string().url().optional()}).parse(request.body??{});
  const url=input.coinglassUrl
    ??(await query<{coinglass_url:string}>("SELECT coinglass_url FROM assets WHERE collect_enabled=true ORDER BY code LIMIT 1")).rows[0]?.coinglass_url;
  if(!url)return reply.code(422).send({error:"COINGLASS_TEST_FAILED",message:"先添加一个启用采集的币种，或提供一个 CoinGlass Heatmap URL 用于测试"});
  try{
    const captured=await requestCoinGlassCapture(url,"24h");
    return {ok:true,url,regionCount:captured.regions.length,capturedAt:captured.capturedAt.toISOString()};
  }catch(error){return reply.code(422).send({error:"COINGLASS_TEST_FAILED",message:error instanceof Error?error.message:String(error)});}
});

/**
 * Realised P&L per calendar day, for the calendar page.
 *
 * Keyed by the Asia/Shanghai date the basket *closed* on: entry is 23:55 and
 * the exit lands at 07:55 the next morning, so a night's result belongs to the
 * morning it settled. Days with several closes — the old two-pass exit emitted
 * one per direction — are summed into a single cell.
 *
 * `priced` counts the legs that actually carried a realizedPnl. The first
 * baskets predate that field, and reporting them as 0 would put a fake
 * break-even day on the calendar, so they come back as null instead.
 */
app.get("/api/pnl/daily",async()=>{
  const rows=(await query<{d:string;mode:string;baskets:number;legs:number;pnl:string|null;gross:string|null;fees:string|null;funding:string|null;priced:number;split:number;funded:number}>(`
    SELECT (o.created_at AT TIME ZONE 'Asia/Shanghai')::date::text d,
           o.payload->>'mode' mode,
           count(*)::int baskets,
           sum(jsonb_array_length(o.payload->'closed'))::int legs,
           sum(x.pnl)::text pnl,
           sum(x.gross)::text gross,
           sum(x.fees)::text fees,
           sum(x.funding)::text funding,
           sum(x.priced)::int priced,
           sum(x.split)::int split,
           sum(x.funded)::int funded
    FROM outbox o
    CROSS JOIN LATERAL (
      SELECT sum((l->>'realizedPnl')::numeric) pnl,
             sum((l->>'grossPnl')::numeric) gross,
             sum(abs((l->>'commission')::numeric)) fees,
             sum((l->>'funding')::numeric) funding,
             count(*) FILTER (WHERE l ? 'realizedPnl') priced,
             count(*) FILTER (WHERE l ? 'grossPnl' AND l ? 'commission') split,
             count(*) FILTER (WHERE l ? 'funding') funded
      FROM jsonb_array_elements(o.payload->'closed') l
    ) x
    WHERE o.topic='notification.gainers_closed'
      AND jsonb_array_length(coalesce(o.payload->'closed','[]'::jsonb))>0
    GROUP BY 1,2 ORDER BY 1`)).rows;

  const byDate=new Map<string,{date:string;realizedPnl:number|null;grossPnl:number|null;funding:number|null;commission:number|null;legs:number;baskets:number;testPnl:number|null;testLegs:number}>();
  for(const row of rows){
    const day=byDate.get(row.d)??{date:row.d,realizedPnl:null,grossPnl:null,funding:null,commission:null,legs:0,baskets:0,testPnl:null,testLegs:0};
    const pnl=row.priced>0&&row.pnl!=null?Number(row.pnl):null;
    if(row.mode==="测试"){
      day.testLegs+=row.legs;
      if(pnl!=null)day.testPnl=(day.testPnl??0)+pnl;
    }else{
      day.legs+=row.legs; day.baskets+=row.baskets;
      if(pnl!=null)day.realizedPnl=(day.realizedPnl??0)+pnl;
      // Only from legs that carried both halves — a day mixing old and new
      // records would otherwise show a gross that its net cannot be derived from.
      if(row.split>0&&row.split===row.priced&&row.gross!=null&&row.fees!=null){
        day.grossPnl=(day.grossPnl??0)+Number(row.gross);
        day.commission=(day.commission??0)+Number(row.fees);
      }
      // Funding is tracked on its own: it was captured later than the
      // gross/fee split, so a day can have one without the other.
      if(row.funded>0&&row.funding!=null)day.funding=(day.funding??0)+Number(row.funding);
    }
    byDate.set(row.d,day);
  }
  const days=[...byDate.values()].sort((a,b)=>a.date.localeCompare(b.date));
  const priced=days.filter((d)=>d.realizedPnl!=null);
  return {
    days,
    stats:{
      tradingDays:days.filter((d)=>d.baskets>0).length,
      winDays:priced.filter((d)=>d.realizedPnl!>0).length,
      lossDays:priced.filter((d)=>d.realizedPnl!<0).length,
      grossPnl:days.filter((d)=>d.grossPnl!=null).reduce((sum,d)=>sum+d.grossPnl!,0),
      commission:days.filter((d)=>d.commission!=null).reduce((sum,d)=>sum+d.commission!,0),
      funding:days.filter((d)=>d.funding!=null).reduce((sum,d)=>sum+d.funding!,0),
      fundingDays:days.filter((d)=>d.funding!=null).length,
      realizedPnl:priced.reduce((sum,d)=>sum+d.realizedPnl!,0),
      best:priced.reduce<{date:string;realizedPnl:number}|null>((b,d)=>!b||d.realizedPnl!>b.realizedPnl?{date:d.date,realizedPnl:d.realizedPnl!}:b,null),
      worst:priced.reduce<{date:string;realizedPnl:number}|null>((w,d)=>!w||d.realizedPnl!<w.realizedPnl?{date:d.date,realizedPnl:d.realizedPnl!}:w,null)
    }
  };
});

app.get("/api/settings/restarts",async()=>
  (await query<{key:string;value:Record<string,unknown>;updated_at:string}>("SELECT key,value,updated_at FROM app_state WHERE key LIKE 'service_restart:%' ORDER BY updated_at DESC")).rows.map((row)=>({...row.value,updatedAt:row.updated_at})));
app.get("/api/health/details",async()=>{
  const [services,assets,scan,errors,restarts]=await Promise.all([
    query("SELECT service,state,last_success_at,consecutive_failures,error,blocks_trading,updated_at FROM service_health ORDER BY service"),
    query(`SELECT a.id,a.code,a.paused,a.pause_reason,a.last_updated_at,i.closed_at,i.warmup_ready,extract(epoch FROM(now()-i.closed_at))::int age_seconds,
      h.captured_at heatmap_captured_at,extract(epoch FROM(now()-h.captured_at))::int heatmap_age_seconds
      FROM assets a
      LEFT JOIN LATERAL(SELECT closed_at,warmup_ready FROM indicator_snapshots s WHERE s.asset_id=a.id ORDER BY closed_at DESC LIMIT 1)i ON true
      LEFT JOIN LATERAL(SELECT captured_at FROM coinglass_heatmaps c WHERE c.asset_id=a.id ORDER BY captured_at DESC LIMIT 1)h ON true
      ORDER BY a.code`),
    query("SELECT * FROM scan_runs ORDER BY closed_at DESC LIMIT 1"),
    query(`SELECT e.*,a.code asset_code FROM business_errors e LEFT JOIN assets a ON a.id=e.asset_id ORDER BY e.occurred_at DESC LIMIT 100`),
    query<{key:string;value:Record<string,unknown>;updated_at:string}>("SELECT key,value,updated_at FROM app_state WHERE key LIKE 'service_restart:%' ORDER BY updated_at DESC LIMIT 20")
  ]);
  return {
    services:services.rows,assets:assets.rows,lastScan:scan.rows[0]??null,errors:errors.rows,
    restarts:restarts.rows.map((row)=>({...row.value,updatedAt:row.updated_at}))
  };
});
app.get("/api/settings/notifications",async()=> (await query("SELECT event_type,enabled FROM notification_preferences ORDER BY event_type")).rows);
app.put("/api/settings/notifications/:eventType",async(request,reply)=>{
  // Validated against the rows that actually exist rather than a list copied
  // into the code: the hardcoded enum silently went stale when new topics were
  // added, leaving resting_order_replaced and venue_limit_rejected impossible
  // to toggle from the UI at all — a notification the operator cannot switch
  // off is a notification they will eventually start ignoring wholesale.
  const eventType=z.string().min(1).max(64).parse((request.params as {eventType:string}).eventType);
  const input=z.object({enabled:z.boolean()}).parse(request.body);
  const updated=await query("UPDATE notification_preferences SET enabled=$1,updated_at=now() WHERE event_type=$2",[input.enabled,eventType]);
  if(!updated.rowCount)return reply.code(404).send({error:"UNKNOWN_NOTIFICATION_TYPE",message:`没有名为 ${eventType} 的通知类型`});
  return {ok:true};
});
app.post("/api/settings/telegram/test", async (request,reply) => {
  const input=z.object({botToken:z.string().min(20),chatId:z.string().min(1)}).parse(request.body);
  const previous=(await query<{state:string}>("SELECT state FROM service_health WHERE service='telegram-worker'")).rows[0]?.state;
  try{await sendTelegramTest(input.botToken,input.chatId,previous==="degraded"?"HuxTrade Telegram 服务已恢复。":"HuxTrade Telegram 配置测试成功。");}
  catch(error){return reply.code(422).send({error:"TELEGRAM_TEST_FAILED",message:error instanceof Error?error.message:String(error)});}
  await recordHealth("telegram-worker",true,undefined,false,false); return {ok:true,recovered:previous==="degraded"};
});
app.post("/api/settings/telegram/save", async (request,reply) => {
  const input=z.object({botToken:z.string().min(20),chatId:z.string().min(1)}).parse(request.body);
  try{await sendTelegramTest(input.botToken,input.chatId,"HuxTrade Telegram 配置已验证并保存。");}
  catch(error){return reply.code(422).send({error:"TELEGRAM_TEST_FAILED",message:error instanceof Error?error.message:String(error)});}
  await writeEnvValues({TELEGRAM_BOT_TOKEN:input.botToken,TELEGRAM_CHAT_ID:input.chatId});
  telegramBotToken=input.botToken;telegramChatId=input.chatId;
  telegramConfigured=true;
  await requestServiceRestart("telegram-worker");
  return {ok:true,restartRequested:true};
});

// Spec's execution safety gate: LIVE_TRADING_ENABLED is a config value cached
// in each process's memory at startup, so flipping it only takes effect once
// a service restarts and re-reads .env. Two services gate on it independently
// — variational-agent (order submission) and signal-engine (the riskGate that
// decides a signal is executable) — so both must be bounced, or signal-engine
// keeps rejecting with LIVE_TRADING_DISABLED on its stale cached value.
// Disabling is never blocked — an operator must always be able to kill live
// trading immediately. Enabling requires a currently valid, reconciled
// Variational session so the switch can't arm trading against a session
// that's actually logged out.
/**
 * The daily gainers basket switch. Unlike live-trading this needs no restart:
 * the agent reads app_state every tick, so the toggle takes effect within 30
 * seconds and a running basket keeps its own close time.
 */
app.post("/api/settings/gainers",async(request,reply)=>{
  const input=z.object({enabled:z.boolean(),marginUsdc:z.number().positive().max(500).nullable().optional()}).parse(request.body);
  const current=(await query<{value:Record<string,unknown>}>("SELECT value FROM app_state WHERE key='gainers_scheduler'")).rows[0]?.value??{};
  if(input.enabled){
    if(!liveTradingEnabled)return reply.code(422).send({error:"GAINERS_BLOCKED",message:"真实交易未开启，定时器开了也不会下单"});
    const session=(await query<{value:Record<string,unknown>}>("SELECT value FROM app_state WHERE key='variational_session'")).rows[0]?.value;
    if(!session?.loggedIn)return reply.code(422).send({error:"GAINERS_BLOCKED",message:"Variational 会话未登录"});
  }
  // A running basket keeps closeAt and its leg ids even when switched off, so
  // the morning exit still fires: turning the scheduler off must not strand
  // positions it already opened.
  const next={...current,enabled:input.enabled,...(input.marginUsdc===undefined?{}:{marginUsdc:input.marginUsdc})};
  await query("INSERT INTO app_state(key,value) VALUES('gainers_scheduler',$1) ON CONFLICT(key) DO UPDATE SET value=$1,updated_at=now()",[JSON.stringify(next)]);
  return {ok:true,...next};
});

/**
 * The manual test run. The API holds no Variational session — only the agent
 * does — so this writes an intent the agent picks up within 30 seconds.
 */
app.post("/api/settings/gainers/test",async(request,reply)=>{
  const input=z.object({running:z.boolean(),marginUsdc:z.number().positive().max(100).optional()}).parse(request.body);
  const current=(await query<{value:Record<string,unknown>}>("SELECT value FROM app_state WHERE key='gainers_scheduler'")).rows[0]?.value??{};
  const test=(current.test??{state:"IDLE"}) as {state:string;legs?:unknown[]};
  if(input.running){
    if(!liveTradingEnabled)return reply.code(422).send({error:"GAINERS_BLOCKED",message:"真实交易未开启，测试不会下单"});
    const binanceMode=Boolean(config.BINANCE_API_KEY&&config.BINANCE_SECRET_KEY);
    if(!binanceMode){
      const session=(await query<{value:Record<string,unknown>}>("SELECT value FROM app_state WHERE key='variational_session'")).rows[0]?.value;
      if(!session?.loggedIn)return reply.code(422).send({error:"GAINERS_BLOCKED",message:"Variational 会话未登录"});
    }
    if(test.state!=="IDLE")return reply.code(409).send({error:"GAINERS_TEST_BUSY",message:`测试已在 ${test.state} 状态，不能重复开始`});
    if(current.closeAt)return reply.code(409).send({error:"GAINERS_BUSY",message:"正式篮子正在持仓中，先等它平掉再测试"});
    const next={...current,test:{state:"START_REQUESTED",marginUsdc:input.marginUsdc??10}};
    await query("INSERT INTO app_state(key,value) VALUES('gainers_scheduler',$1) ON CONFLICT(key) DO UPDATE SET value=$1,updated_at=now()",[JSON.stringify(next)]);
    return {ok:true,state:"START_REQUESTED"};
  }
  if(test.state==="IDLE")return reply.code(409).send({error:"GAINERS_TEST_IDLE",message:"当前没有在跑的测试"});
  const next={...current,test:{...test,state:"STOP_REQUESTED"}};
  await query("INSERT INTO app_state(key,value) VALUES('gainers_scheduler',$1) ON CONFLICT(key) DO UPDATE SET value=$1,updated_at=now()",[JSON.stringify(next)]);
  return {ok:true,state:"STOP_REQUESTED"};
});

app.post("/api/settings/live-trading",async(request,reply)=>{
  const input=z.object({enabled:z.boolean()}).parse(request.body);
  if(input.enabled){
    if(config.VARIATIONAL_ADAPTER_MODE!=="browser-fetch")return reply.code(422).send({error:"LIVE_TRADING_BLOCKED",message:"VARIATIONAL_ADAPTER_MODE 必须是 browser-fetch"});
    const session=(await query<{value:Record<string,unknown>}>("SELECT value FROM app_state WHERE key='variational_session'")).rows[0]?.value;
    if(!session?.loggedIn||!session?.reconciled)return reply.code(422).send({error:"LIVE_TRADING_BLOCKED",message:"Variational 会话未登录或未完成启动对账，不能开启真实交易"});
  }
  await writeEnvValues({LIVE_TRADING_ENABLED:input.enabled?"true":"false"});
  liveTradingEnabled=input.enabled;
  await requestServiceRestart("variational-agent");
  await requestServiceRestart("signal-engine");
  return {ok:true,restartRequested:true};
});

// Both signal-engine (sizes every new plan) and variational-agent (enforces
// the platform-minimum cap in adjustMarginForPlatformMinimum) cache these at
// startup, same as LIVE_TRADING_ENABLED, so both need bouncing to pick up a
// change. defaultMarginUsdc alone above maxMarginUsdc would reject every
// order outright (adjustMarginForPlatformMinimum takes max(default,required)
// before comparing to the cap), so that ordering is enforced here up front.
app.post("/api/settings/margin",async(request,reply)=>{
  const input=z.object({defaultMarginUsdc:z.number().min(1),maxMarginUsdc:z.number().min(1)}).parse(request.body);
  if(input.defaultMarginUsdc>input.maxMarginUsdc)return reply.code(422).send({error:"MARGIN_INVALID",message:"默认保证金不能超过保证金上限"});
  await writeEnvValues({DEFAULT_MARGIN_USDC:String(input.defaultMarginUsdc),MAX_MARGIN_USDC:String(input.maxMarginUsdc)});
  defaultMarginUsdc=input.defaultMarginUsdc;
  maxMarginUsdc=input.maxMarginUsdc;
  await requestServiceRestart("signal-engine");
  await requestServiceRestart("variational-agent");
  return {ok:true,restartRequested:true};
});

// The dedicated Variational Chrome window can crash or get closed outside
// the agent's control. variational-agent now relaunches it itself the next
// time it tries to connect (same real Chrome.app, same persistent profile,
// so an existing login survives) — this button just forces that moment now
// instead of waiting up to one poll interval, by restarting the process
// that owns the connection. No .env write, no restart-blocking session
// check: unlike live-trading, there's nothing here that arms real trading.
app.post("/api/settings/variational/reopen-browser",async()=>{
  await requestServiceRestart("variational-agent");
  return {ok:true,restartRequested:true};
});

const restartWatchdog=setInterval(()=>{void evaluatePendingRestarts().catch((error)=>app.log.error(error));},15_000);
restartWatchdog.unref();
const shutdown=async()=>{clearInterval(restartWatchdog);await app.close();await pool.end();process.exit(0);};
process.on("SIGINT",shutdown); process.on("SIGTERM",shutdown);
await app.listen({host:config.API_HOST,port:config.API_PORT});
