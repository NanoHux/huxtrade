import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { z } from "zod";
import { fixedRules, getConfig } from "@huxtrade/config";
import { pool, query, recordBusinessError, recordHealth, transaction } from "@huxtrade/database";
import { BinanceFuturesClient, CoinGlassClient } from "@huxtrade/exchange-clients";

const config = getConfig();
const app = Fastify({ logger: { redact: ["req.headers.authorization", "body.botToken", "body.apiKey"] } });
await app.register(cors, { origin: config.WEB_ORIGIN });
const binance = new BinanceFuturesClient();
let coinglass = new CoinGlassClient();
let coinglassApiKey=config.COINGLASS_API_KEY;
let telegramBotToken=config.TELEGRAM_BOT_TOKEN;
let telegramChatId=config.TELEGRAM_CHAT_ID;
let coinglassConfigured=Boolean(config.COINGLASS_API_KEY);
let telegramConfigured=Boolean(config.TELEGRAM_BOT_TOKEN&&config.TELEGRAM_CHAT_ID);

async function writeEnvValues(values:Record<string,string>){
  const path=resolve(process.env.ENV_FILE_PATH??".env");let content="";try{content=await readFile(path,"utf8");}catch{}
  for(const [key,value] of Object.entries(values)){
    const pattern=new RegExp(`^${key}=.*$`,"m");content=pattern.test(content)?content.replace(pattern,`${key}=${value}`):`${content.trimEnd()}\n${key}=${value}\n`;
  }
  await writeFile(path,content,{encoding:"utf8",mode:0o600});
}

const assetInput = z.object({
  code: z.string().trim().min(2).max(15).transform((x) => x.toUpperCase()),
  binanceSymbol: z.string().trim().min(5).transform((x) => x.toUpperCase()),
  coinglassSymbol: z.string().trim().min(5).transform((x) => x.toUpperCase()),
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
  id:r.id, code:r.code, binanceSymbol:r.binance_symbol, coinglassSymbol:r.coinglass_symbol, variationalUrl:r.variational_url,
  collectEnabled:r.collect_enabled, signalEnabled:r.signal_enabled, tradeEnabled:r.trade_enabled,
  paused:r.paused, pauseReason:r.pause_reason, lastUpdatedAt:r.last_updated_at,
  connectionStatus:r.paused?"ERROR":!r.closed_at?"PENDING":Date.now()-new Date(String(r.closed_at)).getTime()<=fixedRules.heatmapStaleMs?"CONNECTED":"STALE",
  market:r.closed_at?{price:Number(r.price),oiChange1h:r.oi_change_1h==null?null:Number(r.oi_change_1h),oiZ:r.oi_z==null?null:Number(r.oi_z),oiPassed:Boolean(r.oi_passed),cvd:r.cvd_value==null?null:Number(r.cvd_value),cvdZ:r.cvd_z==null?null:Number(r.cvd_z),cvdPassed:Boolean(r.cvd_passed),funding:r.funding_value==null?null:Number(r.funding_value),fundingZ:r.funding_z==null?null:Math.max(Math.abs(Number(r.funding_z)),Math.abs(Number(r.funding_change_z??0))),fundingPassed:Boolean(r.funding_passed),heatmapPassed:Boolean(r.heatmap_passed),warmupReady:Boolean(r.warmup_ready),closedAt:r.closed_at}:undefined
});
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
  return { status: "ok", service: "api", time: new Date().toISOString() };
});

app.get("/api/dashboard", async () => {
  const [assets, services, orders, signalStats, orderStats, global, risk, session, btc] = await Promise.all([
    query(`SELECT a.*,i.closed_at,i.price,i.oi_change_1h,i.oi_z,i.oi_passed,i.cvd_value,i.cvd_z,i.cvd_passed,i.funding_value,i.funding_z,i.funding_change_z,i.funding_passed,i.heatmap_passed,i.warmup_ready
      FROM assets a LEFT JOIN LATERAL(SELECT * FROM indicator_snapshots s WHERE s.asset_id=a.id ORDER BY s.closed_at DESC LIMIT 1)i ON true ORDER BY a.code`),
    query("SELECT * FROM service_health ORDER BY service"),
    query(`SELECT o.id, a.code, o.direction, o.state, o.entry_price, o.stop_loss, o.take_profit, o.realized_pnl, o.updated_at
           FROM orders o JOIN assets a ON a.id=o.asset_id ORDER BY o.updated_at DESC LIMIT 20`),
    query<{ count:string }>("SELECT count(*) FILTER(WHERE accepted)::text count FROM signals"),
    query<{ orders:string; fills:string; closed:string; wins:string; pnl:string }>(`SELECT count(*)::text orders,
      count(*) FILTER (WHERE state IN ('FILLED_OPEN','CLOSED_TP','CLOSED_SL','LIQUIDATED'))::text fills,
      count(*) FILTER (WHERE state IN ('CLOSED_TP','CLOSED_SL'))::text closed,
      count(*) FILTER (WHERE state='CLOSED_TP')::text wins, coalesce(sum(realized_pnl),0)::text pnl FROM orders`),
    query<{ value:Record<string,unknown> }>("SELECT value FROM app_state WHERE key='global_pause'"),
    query<{ value:Record<string,unknown> }>("SELECT value FROM app_state WHERE key='account_risk'"),
    query<{ value:Record<string,unknown> }>("SELECT value FROM app_state WHERE key='variational_session'"),
    query<{ btc_regime:string }>("SELECT btc_regime FROM indicator_snapshots WHERE btc_regime IS NOT NULL ORDER BY closed_at DESC LIMIT 1")
  ]);
  const os = orderStats.rows[0] ?? { orders:"0", fills:"0", closed:"0", wins:"0", pnl:"0" };
  const orderCount=Number(os.orders), fills=Number(os.fills), closed=Number(os.closed), wins=Number(os.wins);
  return {
    generatedAt:new Date().toISOString(), liveTradingEnabled:config.LIVE_TRADING_ENABLED,
    globalPaused:Boolean(global.rows[0]?.value.paused), btcRegime:btc.rows[0]?.btc_regime ?? "TRANSITION",
    marginUsagePercent:Number(risk.rows[0]?.value.marginUsagePercent ?? 0), balanceUsdc:Number(risk.rows[0]?.value.balanceUsdc ?? 0),
    variationalLoggedIn:Boolean(session.rows[0]?.value.loggedIn), assets:assets.rows.map((x) => camelAsset(x as Record<string,unknown>)),
    services:services.rows.map((x) => ({ service:x.service, state:x.state, lastSuccessAt:x.last_success_at, consecutiveFailures:x.consecutive_failures, error:x.error, blocksTrading:x.blocks_trading })),
    orders:orders.rows, stats:{ signals:Number(signalStats.rows[0]?.count ?? 0), orders:orderCount, fills, fillRate:orderCount?fills/orderCount:0, winRate:closed?wins/closed:0, realizedPnl:Number(os.pnl) }
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
  const input = assetInput.pick({ binanceSymbol:true, coinglassSymbol:true }).parse(request.body);
  const binanceOk = await binance.validateSymbol(input.binanceSymbol);
  let coinglassOk = false, heatmapError: string | null = null;
  try { await coinglass.heatmap(input.coinglassSymbol, "24h"); coinglassOk = true; } catch (e) { heatmapError = e instanceof Error ? e.message : String(e); }
  if (!binanceOk || !coinglassOk) return reply.code(422).send({ binanceOk, coinglassOk, heatmapError });
  return { binanceOk, coinglassOk };
});
app.post("/api/assets", async (request, reply) => {
  let input = assetInput.parse(request.body);
  const count=await query<{count:string}>("SELECT count(*)::text count FROM assets");if(Number(count.rows[0]?.count??0)>=50)return reply.code(409).send({error:"ASSET_LIMIT_REACHED"});
  const resolved=await binance.resolvePerpetualSymbol(input.code);if(!resolved)return reply.code(422).send({error:"BINANCE_SYMBOL_INVALID"});input={...input,binanceSymbol:resolved,coinglassSymbol:resolved};
  try { await coinglass.heatmap(input.coinglassSymbol, "24h"); } catch (e) { return reply.code(422).send({ error:"COINGLASS_HEATMAP_INVALID", message:e instanceof Error?e.message:String(e) }); }
  const result = await query(`INSERT INTO assets(code,binance_symbol,coinglass_symbol,variational_url,collect_enabled,signal_enabled,trade_enabled)
    VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [input.code,input.binanceSymbol,input.coinglassSymbol,input.variationalUrl,input.collectEnabled,input.signalEnabled,input.tradeEnabled]);
  return reply.code(201).send(camelAsset(result.rows[0] as Record<string,unknown>));
});
app.patch("/api/assets/:id", async (request,reply) => {
  const id=z.string().uuid().parse((request.params as {id:string}).id); let input=assetInput.partial().parse(request.body);
  const current=(await query<Record<string,unknown>>("SELECT * FROM assets WHERE id=$1",[id])).rows[0];
  if(!current)return reply.code(404).send({error:"ASSET_NOT_FOUND"});
  if((!input.code||input.code===current.code)&&((input.binanceSymbol&&input.binanceSymbol!==current.binance_symbol)||(input.coinglassSymbol&&input.coinglassSymbol!==current.coinglass_symbol)))return reply.code(400).send({error:"MAPPING_MANAGED_AUTOMATICALLY"});
  if(input.code&&input.code!==current.code){const resolved=await binance.resolvePerpetualSymbol(input.code);if(!resolved)return reply.code(422).send({error:"BINANCE_SYMBOL_INVALID"});input={...input,binanceSymbol:resolved,coinglassSymbol:resolved};}
  if(input.binanceSymbol&&input.binanceSymbol!==current.binance_symbol&&!await binance.validateSymbol(input.binanceSymbol))return reply.code(422).send({error:"BINANCE_SYMBOL_INVALID"});
  if(input.coinglassSymbol&&input.coinglassSymbol!==current.coinglass_symbol){try{await coinglass.heatmap(input.coinglassSymbol,"24h");}catch(error){return reply.code(422).send({error:"COINGLASS_HEATMAP_INVALID",message:error instanceof Error?error.message:String(error)});}}
  const keys:Record<string,string>={code:"code",binanceSymbol:"binance_symbol",coinglassSymbol:"coinglass_symbol",variationalUrl:"variational_url",collectEnabled:"collect_enabled",signalEnabled:"signal_enabled",tradeEnabled:"trade_enabled"};
  const entries=Object.entries(input); if(!entries.length) throw new Error("empty update");
  const values=entries.map(([,v])=>v); const sets=entries.map(([k],i)=>`${keys[k]}=$${i+1}`);
  const result=await query(`UPDATE assets SET ${sets.join(",")},updated_at=now() WHERE id=$${values.length+1} RETURNING *`,[...values,id]);
  return camelAsset(result.rows[0] as Record<string,unknown>);
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

app.get("/api/settings/status", async () => ({
  coinglassConfigured, telegramConfigured,
  variationalMode:config.VARIATIONAL_ADAPTER_MODE, liveTradingEnabled:config.LIVE_TRADING_ENABLED
}));
app.get("/api/settings/secrets/:kind",async(request)=>{
  const kind=z.enum(["coinglass","telegram"]).parse((request.params as {kind:string}).kind);
  return kind==="coinglass"?{apiKey:coinglassApiKey}:{botToken:telegramBotToken,chatId:telegramChatId};
});
app.get("/api/health/details",async()=>{
  const [services,assets,scan,errors]=await Promise.all([
    query("SELECT service,state,last_success_at,consecutive_failures,error,blocks_trading,updated_at FROM service_health ORDER BY service"),
    query(`SELECT a.code,a.paused,a.pause_reason,a.last_updated_at,i.closed_at,i.warmup_ready,extract(epoch FROM(now()-i.closed_at))::int age_seconds
      FROM assets a LEFT JOIN LATERAL(SELECT closed_at,warmup_ready FROM indicator_snapshots s WHERE s.asset_id=a.id ORDER BY closed_at DESC LIMIT 1)i ON true ORDER BY a.code`),
    query("SELECT * FROM scan_runs ORDER BY closed_at DESC LIMIT 1"),
    query(`SELECT e.*,a.code asset_code FROM business_errors e LEFT JOIN assets a ON a.id=e.asset_id ORDER BY e.occurred_at DESC LIMIT 100`)
  ]);
  return {services:services.rows,assets:assets.rows,lastScan:scan.rows[0]??null,errors:errors.rows};
});
app.get("/api/settings/notifications",async()=> (await query("SELECT event_type,enabled FROM notification_preferences ORDER BY event_type")).rows);
app.put("/api/settings/notifications/:eventType",async(request)=>{
  const eventType=z.enum(["signal","order_created","order_failed","entry_filled","closed_tp","closed_sl_or_liquidated","system_error","variational_session_lost","margin_pause_resume","service_recovered"]).parse((request.params as {eventType:string}).eventType);
  const input=z.object({enabled:z.boolean()}).parse(request.body);
  await query("UPDATE notification_preferences SET enabled=$1,updated_at=now() WHERE event_type=$2",[input.enabled,eventType]);return {ok:true};
});
app.post("/api/settings/coinglass/test",async(request)=>{
  const input=z.object({apiKey:z.string().min(8)}).parse(request.body);await new CoinGlassClient(config.COINGLASS_BASE_URL,input.apiKey).heatmap("BTCUSDT","24h");return {ok:true};
});
app.post("/api/settings/coinglass/save",async(request)=>{
  const input=z.object({apiKey:z.string().min(8)}).parse(request.body);const client=new CoinGlassClient(config.COINGLASS_BASE_URL,input.apiKey);await client.heatmap("BTCUSDT","24h");await writeEnvValues({COINGLASS_API_KEY:input.apiKey});coinglass=client;coinglassApiKey=input.apiKey;coinglassConfigured=true;await query("INSERT INTO outbox(topic,payload) VALUES('service.restart_requested',$1)",[JSON.stringify({service:"market-collector"})]);return {ok:true,restartRequested:true};
});
app.post("/api/settings/telegram/test", async (request,reply) => {
  const input=z.object({botToken:z.string().min(20),chatId:z.string().min(1)}).parse(request.body);
  const response=await fetch(`https://api.telegram.org/bot${input.botToken}/sendMessage`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id:input.chatId,text:"HuxTrade Telegram 配置测试成功。"})});
  if(!response.ok) return reply.code(422).send({error:"TELEGRAM_TEST_FAILED"}); await recordHealth("telegram-worker",true); return {ok:true};
});
app.post("/api/settings/telegram/save", async (request) => {
  const input=z.object({botToken:z.string().min(20),chatId:z.string().min(1)}).parse(request.body);
  const response=await fetch(`https://api.telegram.org/bot${input.botToken}/sendMessage`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id:input.chatId,text:"HuxTrade Telegram 配置已验证并保存。"})});
  if(!response.ok) throw new Error("Telegram validation failed; settings were not saved");
  await writeEnvValues({TELEGRAM_BOT_TOKEN:input.botToken,TELEGRAM_CHAT_ID:input.chatId});
  telegramBotToken=input.botToken;telegramChatId=input.chatId;
  telegramConfigured=true;
  await query("INSERT INTO outbox(topic,payload) VALUES('service.restart_requested',$1)",[JSON.stringify({service:"telegram-worker"})]); return {ok:true,restartRequested:true};
});

const shutdown=async()=>{await app.close();await pool.end();process.exit(0);};
process.on("SIGINT",shutdown); process.on("SIGTERM",shutdown);
await app.listen({host:config.API_HOST,port:config.API_PORT});
