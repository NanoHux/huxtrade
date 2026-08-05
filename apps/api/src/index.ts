import { chmod,readFile,writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { z } from "zod";
import { fixedRules, getConfig } from "@huxtrade/config";
import { pool, query, recordBusinessError, recordHealth, transaction } from "@huxtrade/database";
import { BinanceFuturesClient,CoinGlassFreeWebClient,coinGlassBrowserHeaderNames,parseCoinGlassHeatmapUrl } from "@huxtrade/exchange-clients";
import { openOrderStates } from "@huxtrade/shared-types";

const config = getConfig();
const app = Fastify({ logger: { redact: ["req.headers.authorization", "body.botToken", "body.apiKey", "body.obe"] } });
await app.register(cors, { origin: config.WEB_ORIGIN });
const binance = new BinanceFuturesClient();
let coinGlassObe=config.COINGLASS_OBE;
let coinGlassBrowserHeaders:Record<string,string>={...config.COINGLASS_BROWSER_HEADERS_B64};
let coinGlass = new CoinGlassFreeWebClient(undefined,undefined,undefined,coinGlassObe,coinGlassBrowserHeaders);
let telegramBotToken=config.TELEGRAM_BOT_TOKEN;
let telegramChatId=config.TELEGRAM_CHAT_ID;
let telegramConfigured=Boolean(config.TELEGRAM_BOT_TOKEN&&config.TELEGRAM_CHAT_ID);
/** Spec 10.3/11.1: a credential-driven restart must be proven, not assumed. */
const restartDeadlineMs=90_000;

async function writeEnvValues(values:Record<string,string>){
  const path=resolve(process.env.ENV_FILE_PATH??".env");let content="";try{content=await readFile(path,"utf8");}catch{}
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
    if(!response.ok)throw new Error(`Telegram HTTP ${response.status}`);
  }finally{clearTimeout(timer);}
}

const assetInput = z.object({
  code: z.string().trim().min(2).max(15).transform((x) => x.toUpperCase()),
  binanceSymbol: z.string().trim().min(5).transform((x) => x.toUpperCase()),
  coinglassUrl: z.string().url(),
  variationalUrl: z.string().url(),
  collectEnabled: z.boolean().default(true), signalEnabled: z.boolean().default(true), tradeEnabled: z.boolean().default(false)
});
const strategyInput = z.object({
  name: z.string().trim().min(3).max(80), enabled: z.boolean().default(false),
  logic: z.enum(["AND", "N_OF_M"]), requiredCount: z.number().int().min(2).max(4).nullable().optional(),
  conditions: z.array(z.enum(["OI", "CVD", "FUNDING", "HEATMAP"])).min(2).max(4).refine((v) => new Set(v).size === v.length, "conditions must be unique"),
  heatmapRange: z.enum(["12h", "24h", "3d", "7d", "30d"]).default("24h"), maxOrdersPerSide: z.number().int().min(1).max(20).default(5)
}).refine((v) => v.logic !== "N_OF_M" || (v.requiredCount! >= 2 && v.requiredCount! <= v.conditions.length), "invalid N-of-M count");

const camelAsset = (r: Record<string, unknown>) => ({
  id:r.id, code:r.code, binanceSymbol:r.binance_symbol, coinglassSymbol:r.coinglass_symbol, coinglassUrl:r.coinglass_url, variationalUrl:r.variational_url,
  collectEnabled:r.collect_enabled, signalEnabled:r.signal_enabled, tradeEnabled:r.trade_enabled,
  paused:r.paused, pauseReason:r.pause_reason, lastUpdatedAt:r.last_updated_at,
  connectionStatus:r.paused?"ERROR":!r.closed_at?"PENDING":Date.now()-new Date(String(r.closed_at)).getTime()<=fixedRules.heatmapStaleMs?"CONNECTED":"STALE",
  market:r.closed_at?{price:Number(r.price),oiChange1h:r.oi_change_1h==null?null:Number(r.oi_change_1h),oiZ:r.oi_z==null?null:Number(r.oi_z),oiPassed:Boolean(r.oi_passed),cvd:r.cvd_value==null?null:Number(r.cvd_value),cvdZ:r.cvd_z==null?null:Number(r.cvd_z),cvdPassed:Boolean(r.cvd_passed),funding:r.funding_value==null?null:Number(r.funding_value),fundingZ:r.funding_z==null?null:Math.max(Math.abs(Number(r.funding_z)),Math.abs(Number(r.funding_change_z??0))),fundingPassed:Boolean(r.funding_passed),heatmapPassed:Boolean(r.heatmap_passed),warmupReady:Boolean(r.warmup_ready),closedAt:r.closed_at}:undefined
});

async function captureCoinGlassHeatmap(value:string){
  const parsed=parseCoinGlassHeatmapUrl(value);
  const captured=await coinGlass.capture(parsed.url,"24h");
  return {parsed,captured};
}
const camelStrategy = (r: Record<string, unknown>) => ({
  id:r.id, name:r.name, enabled:r.enabled, logic:r.logic, requiredCount:r.required_count, conditions:r.conditions,
  heatmapRange:r.heatmap_range, maxOrdersPerSide:r.max_orders_per_side
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

const camelDashboardOrder = (r: Record<string, unknown>) => ({
  id:String(r.id), code:String(r.code), direction:r.direction as "LONG"|"SHORT", state:r.state as never,
  entryPrice:r.entry_price==null?null:Number(r.entry_price), stopLoss:r.stop_loss==null?null:Number(r.stop_loss),
  takeProfit:r.take_profit==null?null:Number(r.take_profit), marginUsdc:r.margin_usdc==null?null:Number(r.margin_usdc),
  realizedPnl:r.realized_pnl==null?null:Number(r.realized_pnl), variationalUrl:String(r.variational_url),
  updatedAt:r.updated_at==null?null:new Date(String(r.updated_at)).toISOString()
});
const camelDashboardPosition = (r: Record<string, unknown>) => ({
  id:String(r.id), code:String(r.code), direction:r.direction as "LONG"|"SHORT",
  quantity:r.quantity==null?null:Number(r.quantity), entryPrice:r.entry_price==null?null:Number(r.entry_price),
  takeProfit:r.take_profit==null?null:Number(r.take_profit), stopLoss:r.stop_loss==null?null:Number(r.stop_loss),
  unrealizedPnl:r.unrealized_pnl==null?null:Number(r.unrealized_pnl), realizedPnl:r.realized_pnl==null?null:Number(r.realized_pnl),
  orderState:r.order_state as never, variationalUrl:String(r.variational_url),
  openedAt:r.opened_at==null?null:new Date(String(r.opened_at)).toISOString(),
  updatedAt:r.updated_at==null?null:new Date(String(r.updated_at)).toISOString()
});

app.get("/api/dashboard", async () => {
  const [assets, services, orders, openOrders, openPositions, signalStats, orderStats, global, risk, session, btc] = await Promise.all([
    query(`SELECT a.*,i.closed_at,i.price,i.oi_change_1h,i.oi_z,i.oi_passed,i.cvd_value,i.cvd_z,i.cvd_passed,i.funding_value,i.funding_z,i.funding_change_z,i.funding_passed,i.heatmap_passed,i.warmup_ready
      FROM assets a LEFT JOIN LATERAL(SELECT * FROM indicator_snapshots s WHERE s.asset_id=a.id ORDER BY s.closed_at DESC LIMIT 1)i ON true ORDER BY a.code`),
    query("SELECT * FROM service_health ORDER BY service"),
    query(`SELECT o.id, a.code, o.direction, o.state, o.entry_price, o.stop_loss, o.take_profit, o.realized_pnl, o.updated_at
           FROM orders o JOIN assets a ON a.id=o.asset_id ORDER BY o.updated_at DESC LIMIT 20`),
    query(`SELECT o.id,a.code,o.direction,o.state,o.entry_price,o.stop_loss,o.take_profit,o.margin_usdc,o.realized_pnl,a.variational_url,o.updated_at
           FROM orders o JOIN assets a ON a.id=o.asset_id WHERE o.state=ANY($1::text[]) ORDER BY o.updated_at DESC LIMIT 50`,[[...openOrderStates]]),
    query(`SELECT p.id,a.code,p.direction,p.quantity,p.entry_price,p.take_profit,p.stop_loss,p.unrealized_pnl,p.realized_pnl,
             o.state order_state,a.variational_url,p.opened_at,p.updated_at
           FROM positions p JOIN assets a ON a.id=p.asset_id JOIN orders o ON o.id=p.order_id
           WHERE p.closed_at IS NULL ORDER BY p.opened_at DESC LIMIT 50`),
    query<{ count:string }>("SELECT count(*) FILTER(WHERE accepted)::text count FROM signals"),
    query<{ orders:string; fills:string; closed:string; wins:string; pnl:string }>(`SELECT count(*)::text orders,
      count(*) FILTER (WHERE state IN ('FILLED_OPEN','CLOSED_TP','CLOSED_SL','LIQUIDATED'))::text fills,
      count(*) FILTER (WHERE state IN ('CLOSED_TP','CLOSED_SL'))::text closed,
      count(*) FILTER (WHERE state='CLOSED_TP')::text wins, coalesce(sum(realized_pnl),0)::text pnl FROM orders`),
    query<{ value:Record<string,unknown> }>("SELECT value FROM app_state WHERE key='global_pause'"),
    query<{ value:Record<string,unknown> }>("SELECT value FROM app_state WHERE key='account_risk'"),
    query<{ value:Record<string,unknown> }>("SELECT value FROM app_state WHERE key='variational_session'"),
    query<{ btc_regime:string;btc_context:Record<string,unknown> }>("SELECT btc_regime,btc_context FROM scan_runs WHERE btc_regime IS NOT NULL ORDER BY closed_at DESC LIMIT 1")
  ]);
  const os = orderStats.rows[0] ?? { orders:"0", fills:"0", closed:"0", wins:"0", pnl:"0" };
  const orderCount=Number(os.orders), fills=Number(os.fills), closed=Number(os.closed), wins=Number(os.wins);
  return {
    generatedAt:new Date().toISOString(), liveTradingEnabled:config.LIVE_TRADING_ENABLED,
    globalPaused:Boolean(global.rows[0]?.value.paused), btcRegime:btc.rows[0]?.btc_regime ?? "TRANSITION", btcContext:btc.rows[0]?.btc_context,
    marginUsagePercent:Number(risk.rows[0]?.value.marginUsagePercent ?? 0), balanceUsdc:Number(risk.rows[0]?.value.balanceUsdc ?? 0),
    variationalLoggedIn:Boolean(session.rows[0]?.value.loggedIn), variationalReconciled:Boolean(session.rows[0]?.value.reconciled), assets:assets.rows.map((x) => camelAsset(x as Record<string,unknown>)),
    services:services.rows.map((x) => ({ service:x.service, state:x.state, lastSuccessAt:x.last_success_at, consecutiveFailures:x.consecutive_failures, error:x.error, blocksTrading:x.blocks_trading })),
    orders:orders.rows,
    openOrders:openOrders.rows.map((x) => camelDashboardOrder(x as Record<string,unknown>)),
    openPositions:openPositions.rows.map((x) => camelDashboardPosition(x as Record<string,unknown>)),
    stats:{ signals:Number(signalStats.rows[0]?.count ?? 0), orders:orderCount, fills, fillRate:orderCount?fills/orderCount:0, winRate:closed?wins/closed:0, realizedPnl:Number(os.pnl) }
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
    query(`SELECT created_at,direction,state,entry_price,stop_loss,take_profit FROM orders WHERE asset_id=$1 AND created_at>=to_timestamp($2/1000.0) ORDER BY created_at`,[asset.id,candles[0]?.openTime??Date.now()]),
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
  const count=await query<{count:string}>("SELECT count(*)::text count FROM assets");if(Number(count.rows[0]?.count??0)>=50)return reply.code(409).send({error:"ASSET_LIMIT_REACHED"});
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
    const result=await client.query(`INSERT INTO strategies(name,enabled,logic,required_count,conditions,heatmap_range,max_orders_per_side)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[input.name,input.enabled,input.logic,input.requiredCount??null,input.conditions,input.heatmapRange,input.maxOrdersPerSide]);
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
  const partial=z.object({name:z.string().trim().min(3).max(80),enabled:z.boolean(),logic:z.enum(["AND","N_OF_M"]),requiredCount:z.number().int().min(2).max(4).nullable(),conditions:z.array(z.enum(["OI","CVD","FUNDING","HEATMAP"])).min(2).max(4),heatmapRange:z.enum(["12h","24h","3d","7d","30d"]),maxOrdersPerSide:z.number().int().min(1).max(20)}).partial().parse(request.body);
  const merged=strategyInput.parse({name:partial.name??current.name,enabled:partial.enabled??current.enabled,logic:partial.logic??current.logic,requiredCount:"requiredCount" in partial?partial.requiredCount:current.required_count,conditions:partial.conditions??current.conditions,heatmapRange:partial.heatmapRange??current.heatmap_range,maxOrdersPerSide:partial.maxOrdersPerSide??current.max_orders_per_side});
  const row=await transaction(async(client)=>{if(merged.enabled){await client.query("UPDATE strategies SET enabled=false,updated_at=now() WHERE enabled=true AND id<>$1",[id]);await client.query("UPDATE heatmap_candidates SET status='INVALIDATED',invalid_reason='STRATEGY_SWITCH' WHERE status IN ('ARMED','CONFIRMED')");}const result=await client.query(`UPDATE strategies SET name=$1,enabled=$2,logic=$3,required_count=$4,conditions=$5,heatmap_range=$6,max_orders_per_side=$7,updated_at=now() WHERE id=$8 RETURNING *`,[merged.name,merged.enabled,merged.logic,merged.requiredCount??null,merged.conditions,merged.heatmapRange,merged.maxOrdersPerSide,id]);if(merged.enabled)await client.query("INSERT INTO outbox(topic,payload) VALUES('strategy.changed',$1)",[JSON.stringify({strategyId:id})]);return result.rows[0];});
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
app.get("/api/statistics", async () => {const summary=(await query(`SELECT s.id,s.name,
  (SELECT count(*) FROM signals sig WHERE sig.strategy_id=s.id AND sig.accepted)::int signals,
  (SELECT count(*) FROM signals sig WHERE sig.strategy_id=s.id AND sig.accepted AND NOT sig.executable)::int non_executable_signals,
  (SELECT count(*) FROM orders o WHERE o.strategy_id=s.id)::int orders,
  (SELECT count(*) FROM orders o WHERE o.strategy_id=s.id AND o.state IN ('FILLED_OPEN','CLOSED_TP','CLOSED_SL','LIQUIDATED'))::int fills,
  (SELECT count(*) FROM orders o WHERE o.strategy_id=s.id AND o.state IN ('CLOSED_TP','CLOSED_SL'))::int closed,
  (SELECT count(*) FROM orders o WHERE o.strategy_id=s.id AND o.state='CLOSED_TP')::int wins,
  coalesce((SELECT sum(o.realized_pnl) FROM orders o WHERE o.strategy_id=s.id),0)::float realized_pnl
  FROM strategies s ORDER BY s.created_at`)).rows;const outcomes=await query<{strategy_id:string;state:string}>("SELECT strategy_id,state FROM orders WHERE state IN ('CLOSED_TP','CLOSED_SL') ORDER BY updated_at");return summary.map((row)=>{let wins=0,losses=0,maxConsecutiveWins=0,maxConsecutiveLosses=0;for(const outcome of outcomes.rows.filter((item)=>item.strategy_id===row.id)){if(outcome.state==="CLOSED_TP"){wins+=1;losses=0;maxConsecutiveWins=Math.max(maxConsecutiveWins,wins);}else{losses+=1;wins=0;maxConsecutiveLosses=Math.max(maxConsecutiveLosses,losses);}}return {...row,max_consecutive_wins:maxConsecutiveWins,max_consecutive_losses:maxConsecutiveLosses};});});

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
  const session=(await query<{value:Record<string,unknown>}>("SELECT value FROM app_state WHERE key='coinglass_session'")).rows[0]?.value;
  return {
    coinglassMode:config.COINGLASS_ADAPTER_MODE,coinglassReady:Boolean(session?.ready??session?.loggedIn),
    coinglassSessionConfigured:Boolean(coinGlassObe),coinglassFingerprintCount:Object.keys(coinGlassBrowserHeaders).length,
    telegramConfigured,variationalMode:config.VARIATIONAL_ADAPTER_MODE,liveTradingEnabled:config.LIVE_TRADING_ENABLED
  };
});
app.get("/api/settings/secrets/:kind",async(request)=>{
  const kind=z.enum(["telegram","coinglass"]).parse((request.params as {kind:string}).kind);
  if(kind==="coinglass")return {obe:coinGlassObe,browserHeaders:coinGlassBrowserHeaders};
  return {botToken:telegramBotToken,chatId:telegramChatId};
});

const coinGlassSecretInput=z.object({
  obe:z.string().trim().max(4096).default(""),
  browserHeaders:z.record(z.string(),z.string().max(1024).refine((v)=>!/[\r\n]/.test(v),"header values cannot contain line breaks"))
    .default({})
    .refine((value)=>Object.keys(value).every((name)=>(coinGlassBrowserHeaderNames as readonly string[]).includes(name)),
      `browserHeaders may only contain: ${coinGlassBrowserHeaderNames.join(", ")}`),
  coinglassUrl:z.string().url().optional()
});

async function probeCoinGlass(input:z.infer<typeof coinGlassSecretInput>){
  const url=input.coinglassUrl
    ??(await query<{coinglass_url:string}>("SELECT coinglass_url FROM assets WHERE collect_enabled=true ORDER BY code LIMIT 1")).rows[0]?.coinglass_url;
  if(!url)throw new Error("先添加一个启用采集的币种，或提供一个 CoinGlass Heatmap URL 用于测试");
  const client=new CoinGlassFreeWebClient(undefined,undefined,undefined,input.obe,input.browserHeaders);
  const captured=await client.capture(url,"24h");
  return {url,regionCount:captured.regions.length,capturedAt:captured.capturedAt.toISOString()};
}

app.post("/api/settings/coinglass/test",async(request,reply)=>{
  const input=coinGlassSecretInput.parse(request.body);
  try{return {ok:true,...await probeCoinGlass(input)};}
  catch(error){return reply.code(422).send({error:"COINGLASS_TEST_FAILED",message:error instanceof Error?error.message:String(error)});}
});

app.post("/api/settings/coinglass/save",async(request,reply)=>{
  const input=coinGlassSecretInput.parse(request.body);
  let probe;
  // Spec 13.2: verify against the real platform first, then persist.
  try{probe=await probeCoinGlass(input);}
  catch(error){return reply.code(422).send({error:"COINGLASS_TEST_FAILED",message:error instanceof Error?error.message:String(error)});}
  const encoded=Object.keys(input.browserHeaders).length?Buffer.from(JSON.stringify(input.browserHeaders),"utf8").toString("base64url"):"";
  await writeEnvValues({COINGLASS_OBE:input.obe,COINGLASS_BROWSER_HEADERS_B64:encoded,COINGLASS_ADAPTER_MODE:"free-web"});
  coinGlassObe=input.obe;coinGlassBrowserHeaders={...input.browserHeaders};
  coinGlass=new CoinGlassFreeWebClient(undefined,undefined,undefined,coinGlassObe,coinGlassBrowserHeaders);
  await requestServiceRestart("coinglass-agent");
  return {ok:true,restartRequested:true,...probe};
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
app.put("/api/settings/notifications/:eventType",async(request)=>{
  const eventType=z.enum(["signal","order_created","order_failed","entry_filled","closed_tp","closed_sl_or_liquidated","system_error","variational_session_lost","margin_pause_resume","service_recovered"]).parse((request.params as {eventType:string}).eventType);
  const input=z.object({enabled:z.boolean()}).parse(request.body);
  await query("UPDATE notification_preferences SET enabled=$1,updated_at=now() WHERE event_type=$2",[input.enabled,eventType]);return {ok:true};
});
app.post("/api/settings/telegram/test", async (request,reply) => {
  const input=z.object({botToken:z.string().min(20),chatId:z.string().min(1)}).parse(request.body);
  const previous=(await query<{state:string}>("SELECT state FROM service_health WHERE service='telegram-worker'")).rows[0]?.state;
  try{await sendTelegramTest(input.botToken,input.chatId,previous==="degraded"?"HuxTrade Telegram 服务已恢复。":"HuxTrade Telegram 配置测试成功。");}
  catch{return reply.code(422).send({error:"TELEGRAM_TEST_FAILED"});}
  await recordHealth("telegram-worker",true,undefined,false,false); return {ok:true,recovered:previous==="degraded"};
});
app.post("/api/settings/telegram/save", async (request,reply) => {
  const input=z.object({botToken:z.string().min(20),chatId:z.string().min(1)}).parse(request.body);
  try{await sendTelegramTest(input.botToken,input.chatId,"HuxTrade Telegram 配置已验证并保存。");}
  catch{return reply.code(422).send({error:"TELEGRAM_TEST_FAILED"});}
  await writeEnvValues({TELEGRAM_BOT_TOKEN:input.botToken,TELEGRAM_CHAT_ID:input.chatId});
  telegramBotToken=input.botToken;telegramChatId=input.chatId;
  telegramConfigured=true;
  await requestServiceRestart("telegram-worker");
  return {ok:true,restartRequested:true};
});

const restartWatchdog=setInterval(()=>{void evaluatePendingRestarts().catch((error)=>app.log.error(error));},15_000);
restartWatchdog.unref();
const shutdown=async()=>{clearInterval(restartWatchdog);await app.close();await pool.end();process.exit(0);};
process.on("SIGINT",shutdown); process.on("SIGTERM",shutdown);
await app.listen({host:config.API_HOST,port:config.API_PORT});
