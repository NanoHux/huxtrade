import { fixedRules, getConfig } from "@huxtrade/config";
import { claimRestartRequest, pool, query, recordHealth, transaction } from "@huxtrade/database";
import {
  formatAssetResumed,formatClosed,formatEntryFilled,formatGeneric,formatMarginPauseResume,
  formatBreakevenStopFailed,formatDirectionHalted,formatOrderCreated,formatOrderDesynced,formatOrderFailed,formatScaledOut,formatServiceRecovered,formatSessionLost,formatSignal,formatSystemError,
  type FillRow,type OrderContext
} from "./format.js";
import {
  formatAccount,formatHelp,formatPlans,formatPnl,formatPositions,formatStatus,formatWorkingOrders,
  parseCommand,type CommandName
} from "./commands.js";
const config=getConfig(),sleep=(ms:number)=>new Promise((r)=>setTimeout(r,ms));

async function orderContext(orderId:unknown):Promise<OrderContext|undefined>{
  if(typeof orderId!=="string")return undefined;
  const row=(await query<OrderContext>(`SELECT a.code,o.direction,o.entry_price AS "entryPrice",o.stop_loss AS "stopLoss",o.take_profit AS "takeProfit",
    o.leverage,o.margin_usdc AS "marginUsdc",o.realized_pnl AS "realizedPnl" FROM orders o JOIN assets a ON a.id=o.asset_id WHERE o.id=$1`,[orderId])).rows[0];
  return row;
}
async function orderFills(orderId:unknown):Promise<FillRow[]>{
  if(typeof orderId!=="string")return [];
  return (await query<FillRow>(`SELECT price,quantity,side,filled_at AS "filledAt" FROM fills WHERE order_id=$1 ORDER BY filled_at ASC`,[orderId])).rows;
}

async function format(topic:string,payload:Record<string,unknown>){
  const eventType=topic.replace("notification.","");
  switch(eventType){
    case "signal":return formatSignal(payload);
    case "order_created":{const order=await orderContext(payload.orderId);return order?formatOrderCreated(order):formatGeneric(topic,payload);}
    case "order_failed":return formatOrderFailed(payload,await orderContext(payload.orderId));
    case "entry_filled":{const order=await orderContext(payload.orderId);return order?formatEntryFilled(order,await orderFills(payload.orderId)):formatGeneric(topic,payload);}
    case "closed_tp":
    case "closed_sl_or_liquidated":
    case "closed_reversed":{const order=await orderContext(payload.orderId);return order?formatClosed(String(payload.toState??""),order,await orderFills(payload.orderId)):formatGeneric(topic,payload);}
    case "direction_halted":return formatDirectionHalted(payload);
    case "order_desynced":return formatOrderDesynced(payload,await orderContext(payload.orderId));
    case "scaled_out":return formatScaledOut(payload);
    case "breakeven_stop_failed":return formatBreakevenStopFailed(payload);
    case "system_error":return formatSystemError(payload);
    case "asset_resumed":return formatAssetResumed(payload);
    case "variational_session_lost":return formatSessionLost();
    case "margin_pause_resume":return formatMarginPauseResume(payload);
    case "service_recovered":return formatServiceRecovered(payload);
    default:return formatGeneric(topic,payload);
  }
}
async function send(text:string){if(!config.TELEGRAM_BOT_TOKEN||!config.TELEGRAM_CHAT_ID)throw new Error("Telegram is not configured");const r=await fetch(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id:config.TELEGRAM_CHAT_ID,text})});if(!r.ok)throw new Error(`Telegram HTTP ${r.status}`);}
async function tick(){
 if(await claimRestartRequest("telegram-worker")){await pool.end();process.exit(0);}
 const health=await query<{state:string}>("SELECT state FROM service_health WHERE service='telegram-worker'");
 if(health.rows[0]?.state==="degraded"){await query("UPDATE outbox SET status='dropped' WHERE status='pending' AND topic LIKE 'notification.%'");return;}
 const item=await transaction(async(client)=>{const r=await client.query<Record<string,unknown>>("SELECT * FROM outbox WHERE status='pending' AND topic LIKE 'notification.%' AND available_at<=now() ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1");if(!r.rows[0])return null;await client.query("UPDATE outbox SET status='processing' WHERE id=$1",[r.rows[0].id]);return r.rows[0];});
 if(!item)return;
 const eventType=String(item.topic).replace("notification.","");
 const preference=await query<{enabled:boolean}>("SELECT enabled FROM notification_preferences WHERE event_type=$1",[eventType]);
 if(preference.rows[0]&&!preference.rows[0].enabled){await query("UPDATE outbox SET status='dropped' WHERE id=$1",[item.id]);return;}
 try{await send(await format(String(item.topic),item.payload as Record<string,unknown>));await query("UPDATE outbox SET status='sent',sent_at=now(),attempts=attempts+1 WHERE id=$1",[item.id]);await recordHealth("telegram-worker",true);}
 catch(error){const attempts=Number(item.attempts)+1;if(attempts>=fixedRules.telegramMaxAttempts){await query("UPDATE outbox SET status='failed',attempts=$1 WHERE id=$2",[attempts,item.id]);await recordHealth("telegram-worker",false,error,false);}else await query("UPDATE outbox SET status='pending',attempts=$1,available_at=now()+interval '10 seconds' WHERE id=$2",[attempts,item.id]);}
}
/**
 * Read-only chat commands.
 *
 * A Telegram message authenticates nothing beyond "this reached the bot", and
 * the bot token is enough for anyone holding it to send one. So the command
 * surface changes no trading state, and every update from a chat other than
 * the configured operator's is dropped without a reply — an error reply would
 * confirm the bot exists to whoever probed it.
 */
async function answer(command:CommandName):Promise<string>{
  if(command==="/help")return formatHelp();
  if(command==="/status"){
    const [services,state,strategy,paused,assets,scan]=await Promise.all([
      query<{service:string;state:string;error:string|null}>("SELECT service,state,error FROM service_health ORDER BY service"),
      query<{key:string;value:Record<string,unknown>}>("SELECT key,value FROM app_state WHERE key IN ('global_pause','account_risk')"),
      query<{name:string;entry_kind:string}>("SELECT name,entry_kind FROM strategies WHERE enabled LIMIT 1"),
      query<{code:string;pause_reason:string|null}>("SELECT code,pause_reason FROM assets WHERE paused ORDER BY code"),
      query<{count:string}>("SELECT count(*)::text count FROM assets WHERE collect_enabled"),
      query<{closed_at:string}>("SELECT max(closed_at)::text closed_at FROM indicator_snapshots")
    ]);
    const byKey=new Map(state.rows.map((row)=>[row.key,row.value]));
    return formatStatus({
      services:services.rows,
      globalPaused:Boolean(byKey.get("global_pause")?.paused),
      liveTrading:config.LIVE_TRADING_ENABLED,
      executionMode:config.STRATEGY_EXECUTION_MODE,
      strategyName:strategy.rows[0]?.name??null,
      entryKind:strategy.rows[0]?.entry_kind??null,
      pausedAssets:paused.rows.map((row)=>({code:row.code,reason:row.pause_reason})),
      assetCount:Number(assets.rows[0]?.count??0),
      lastScanAt:scan.rows[0]?.closed_at??null
    });
  }
  if(command==="/acc"){
    const [state,counts]=await Promise.all([
      query<{key:string;value:Record<string,unknown>}>("SELECT key,value FROM app_state WHERE key IN ('account_risk','variational_session')"),
      query<{positions:string;orders:string}>(`SELECT count(*) FILTER (WHERE state='FILLED_OPEN')::text positions,count(*) FILTER (WHERE state='PENDING_ENTRY')::text orders FROM orders`)
    ]);
    const byKey=new Map(state.rows.map((row)=>[row.key,row.value]));
    const risk=byKey.get("account_risk")??{},session=byKey.get("variational_session")??{};
    return formatAccount({
      balanceUsdc:Number(risk.balanceUsdc??0),marginUsagePercent:Number(risk.marginUsagePercent??0),
      autoPaused:Boolean(risk.autoPaused),loggedIn:Boolean(session.loggedIn),reconciled:Boolean(session.reconciled),
      openPositions:Number(counts.rows[0]?.positions??0),workingOrders:Number(counts.rows[0]?.orders??0)
    });
  }
  if(command==="/pos"){
    const rows=await query<{code:string;direction:string;entry_price:string;stop_loss:string;take_profit:string;unrealized_pnl:string|null;minutes:string}>(
      `SELECT a.code,o.direction,coalesce(p.entry_price,o.entry_price) entry_price,o.stop_loss,o.take_profit,p.unrealized_pnl,
        (extract(epoch FROM (now()-coalesce(p.opened_at,o.updated_at)))/60)::text minutes
       FROM orders o JOIN assets a ON a.id=o.asset_id LEFT JOIN positions p ON p.order_id=o.id
       WHERE o.state='FILLED_OPEN' ORDER BY p.opened_at`);
    return formatPositions(rows.rows.map((row)=>({
      code:row.code,direction:row.direction,entryPrice:Number(row.entry_price),stopLoss:Number(row.stop_loss),
      takeProfit:Number(row.take_profit),unrealizedPnl:row.unrealized_pnl===null?null:Number(row.unrealized_pnl),
      openedMinutes:Number(row.minutes)
    })));
  }
  if(command==="/orders"){
    const rows=await query<{code:string;direction:string;entry_price:string;market_price:string|null;atr:string|null;sources:string[]|null;stop_loss:string;take_profit:string;minutes:string;awaiting_trigger:boolean;trigger_touched_at:string|null}>(
      `SELECT a.code,o.direction,o.entry_price,o.stop_loss,o.take_profit,o.awaiting_trigger,o.trigger_touched_at,
        i.price market_price,(o.entry_provenance->>'atr1h') atr,
        ARRAY(SELECT jsonb_array_elements_text(coalesce(o.entry_provenance->'sources','[]'::jsonb))) sources,
        (extract(epoch FROM (now()-o.created_at))/60)::text minutes
       FROM orders o JOIN assets a ON a.id=o.asset_id
       LEFT JOIN LATERAL (SELECT price FROM indicator_snapshots s WHERE s.asset_id=o.asset_id ORDER BY closed_at DESC LIMIT 1) i ON true
       WHERE o.entry_kind='RESTING_LIMIT' AND (o.state='PENDING_ENTRY' OR (o.state='CREATED_LOCAL' AND o.awaiting_trigger))
       ORDER BY o.awaiting_trigger DESC,o.created_at`);
    return formatWorkingOrders(rows.rows.map((row)=>{
      const level=Number(row.entry_price),market=row.market_price===null?null:Number(row.market_price),atr=Number(row.atr);
      const risk=Math.abs(level-Number(row.stop_loss));
      return {
        code:row.code,direction:row.direction,level,marketPrice:market,
        distanceAtr:market===null||!(atr>0)?null:Math.abs(market-level)/atr,
        expectedRiskReward:risk>0?Math.abs(Number(row.take_profit)-level)/risk:null,
        sources:row.sources??[],ageMinutes:Number(row.minutes),
        awaitingTrigger:Boolean(row.awaiting_trigger),touched:row.trigger_touched_at!==null
      };
    }));
  }
  if(command==="/pnl"){
    const [totals,byExit,activity]=await Promise.all([
      query<{today:string;total:string}>(`SELECT
        coalesce(sum(realized_pnl) FILTER (WHERE updated_at>=date_trunc('day',now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'),0)::text today,
        coalesce(sum(realized_pnl),0)::text total FROM orders WHERE entry_kind='RESTING_LIMIT'`),
      query<{state:string;count:string;realized:string}>(`SELECT state,count(*)::text count,coalesce(sum(realized_pnl),0)::text realized
        FROM orders WHERE entry_kind='RESTING_LIMIT' AND state IN ('CLOSED_TP','CLOSED_SL','LIQUIDATED','CLOSED_REVERSED') GROUP BY state ORDER BY state`),
      query<{filled:string;placed:string}>(`SELECT
        (SELECT count(*)::text FROM orders WHERE entry_kind='RESTING_LIMIT' AND state IN ('FILLED_OPEN','CLOSED_TP','CLOSED_SL','LIQUIDATED','CLOSED_REVERSED')) filled,
        (SELECT count(*)::text FROM entry_plans WHERE decision IN ('PLACE','REPLACE') AND mode='live') placed`)
    ]);
    return formatPnl({
      todayRealized:Number(totals.rows[0]?.today??0),totalRealized:Number(totals.rows[0]?.total??0),
      byExit:byExit.rows.map((row)=>({state:row.state,count:Number(row.count),realized:Number(row.realized)})),
      filled:Number(activity.rows[0]?.filled??0),placed:Number(activity.rows[0]?.placed??0)
    });
  }
  const plans=await query<{code:string;closed_at:string;decision:string;direction:string|null;level:string|null;decision_reason:string}>(
    `SELECT a.code,p.closed_at::text,p.decision,p.direction,p.level::text,p.decision_reason
     FROM entry_plans p JOIN assets a ON a.id=p.asset_id
     WHERE p.decision NOT IN ('KEEP','NONE') ORDER BY p.closed_at DESC,a.code LIMIT 12`);
  return formatPlans(plans.rows.map((row)=>({
    code:row.code,closedAt:row.closed_at,decision:row.decision,direction:row.direction,
    level:row.level===null?null:Number(row.level),reason:row.decision_reason
  })));
}

/**
 * Telegram long-polls from an offset that must survive a restart, otherwise a
 * bounce replays every command still inside Telegram's 24h retention.
 */
async function pollCommands(){
  if(!config.TELEGRAM_BOT_TOKEN||!config.TELEGRAM_CHAT_ID)return;
  const stored=(await query<{value:Record<string,unknown>}>("SELECT value FROM app_state WHERE key='telegram_update_offset'")).rows[0]?.value;
  const offset=Number(stored?.offset??0);
  const response=await fetch(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/getUpdates?timeout=0&limit=20${offset?`&offset=${offset}`:""}`);
  if(!response.ok)throw new Error(`Telegram getUpdates HTTP ${response.status}`);
  const body=await response.json() as {result?:Array<{update_id:number;message?:{text?:string;chat?:{id?:number|string}}}>};
  const updates=body.result??[];
  if(!updates.length)return;
  for(const update of updates){
    const chatId=String(update.message?.chat?.id??"");
    // Silence, not an error reply: answering an unknown chat confirms the bot
    // is live to whoever is probing it.
    if(chatId!==String(config.TELEGRAM_CHAT_ID))continue;
    const command=parseCommand(update.message?.text);
    if(command)await send(await answer(command));
  }
  await query(`INSERT INTO app_state(key,value) VALUES('telegram_update_offset',$1)
    ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`,
    [JSON.stringify({offset:Math.max(...updates.map((update)=>update.update_id))+1})]);
}

process.on("SIGTERM",async()=>{await pool.end();process.exit(0);});
await recordHealth("telegram-worker",Boolean(config.TELEGRAM_BOT_TOKEN&&config.TELEGRAM_CHAT_ID),config.TELEGRAM_BOT_TOKEN&&config.TELEGRAM_CHAT_ID?undefined:"Telegram is not configured",false);
while(true){await tick();try{await pollCommands();}catch{/* commands are best-effort; delivery of alerts must not depend on them */}await sleep(2_000);}
