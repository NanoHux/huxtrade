import { fixedRules,getConfig } from "@huxtrade/config";
import { pool,query,recordBusinessError,recordHealth,transaction } from "@huxtrade/database";
import { adjustMarginForPlatformMinimum,assertOrderTransition,marginPauseTransition } from "@huxtrade/strategy-engine";
import type { OrderPlan } from "@huxtrade/shared-types";
import { notificationTopicsForTransition,reconcileProtectionState,submitWithInitialProtection,type PlatformEntry,type PlatformEntryState,type PlatformProtection,type PlatformTrackedOrder,type ProtectionAdapter } from "./execution.js";
import { BrowserFetchTransport } from "./browser-fetch-transport.js";
import { OmniBrowserAdapter,type VariationalAdapter } from "./omni-adapter.js";

const config=getConfig();
const sleep=(ms:number)=>new Promise((resolve)=>setTimeout(resolve,ms));
class DisabledAdapter implements VariationalAdapter{
  async sessionValid(){return false;}
  async account():Promise<{balanceUsdc:number;marginUsagePercent:number}>{throw new Error("Variational adapter is disabled");}
  async minimumMargin(_plan:OrderPlan):Promise<number>{throw new Error("Variational adapter is disabled");}
  async submitEntry(_plan:Record<string,unknown>):Promise<PlatformEntry>{throw new Error("Variational adapter is disabled");}
  async placeTakeProfit(_entry:PlatformEntry,_plan:OrderPlan):Promise<PlatformProtection>{throw new Error("Variational adapter is disabled");}
  async placeStopLoss(_entry:PlatformEntry,_plan:OrderPlan):Promise<PlatformProtection>{throw new Error("Variational adapter is disabled");}
  async orderState(_entryId:string):Promise<PlatformEntryState>{throw new Error("Variational adapter is disabled");}
  async cancelEntry(_entryId:string):Promise<{cancelled:boolean;state:PlatformEntryState;raw:Record<string,unknown>}>{throw new Error("Variational adapter is disabled");}
  async cancelOrder(_orderId:string){throw new Error("Variational adapter is disabled");}
  async closeMarket(_entryId:string):Promise<{closed:boolean;raw:Record<string,unknown>}>{throw new Error("Variational adapter is disabled");}
  async listTracked(_orderIds:string[]){return[];}
  async cancelPending():Promise<Array<{id:string;cancelled:boolean}>>{throw new Error("Variational adapter is disabled");}
}

const adapter:VariationalAdapter=config.VARIATIONAL_ADAPTER_MODE==="browser-fetch"
  ?new OmniBrowserAdapter(new BrowserFetchTransport(config),config)
  :new DisabledAdapter();

async function setState(orderId:string,from:string,to:string,reason:string,payload?:unknown){
  assertOrderTransition(from,to);
  await transaction(async(client)=>{
    await client.query("UPDATE orders SET state=$1,raw_platform_state=$2,updated_at=now() WHERE id=$3",[to,payload?JSON.stringify(payload):null,orderId]);
    await client.query("INSERT INTO order_events(order_id,from_state,to_state,reason,payload) VALUES($1,$2,$3,$4,$5)",[orderId,from,to,reason,payload?JSON.stringify(payload):null]);
    for(const topic of notificationTopicsForTransition(from as Parameters<typeof notificationTopicsForTransition>[0],to as Parameters<typeof notificationTopicsForTransition>[1]))await client.query("INSERT INTO outbox(topic,payload) VALUES($1,$2)",[topic,JSON.stringify({orderId,fromState:from,toState:to,reason,details:payload??null})]);
  });
}

async function refreshAccount():Promise<unknown>{
  try{
    const account=await adapter.account();
    const previous=(await query<{value:Record<string,unknown>}>("SELECT value FROM app_state WHERE key='account_risk'")).rows[0]?.value??{};
    const transition=marginPauseTransition(Boolean(previous.autoPaused),account.marginUsagePercent);
    const autoPaused=transition==="PAUSE"?true:transition==="RESUME"?false:Boolean(previous.autoPaused);
    await transaction(async(client)=>{
      await client.query("UPDATE app_state SET value=$1,updated_at=now() WHERE key='account_risk'",[JSON.stringify({...account,autoPaused})]);
      if(transition!=="HOLD"){
        await client.query(`INSERT INTO app_state(key,value) SELECT 'signal_cursor',jsonb_build_object('closedAt',max(closed_at)::text) FROM indicator_snapshots HAVING max(closed_at) IS NOT NULL
          ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`);
        await client.query("INSERT INTO outbox(topic,payload) VALUES('notification.margin_pause_resume',$1)",[JSON.stringify({transition,...account})]);
      }
    });
    return undefined;
  }catch(error){return error;}
}

async function persistPlatformDetails(order:{id:string;asset_id:string},remote:PlatformTrackedOrder){
  if(!remote.position&&!remote.fills?.length)return;
  await transaction(async(client)=>{
    let positionId:string|null=null;
    if(remote.position){
      const position=remote.position;
      const saved=await client.query<{id:string}>(`INSERT INTO positions(order_id,platform_position_id,asset_id,direction,quantity,entry_price,take_profit,stop_loss,unrealized_pnl,realized_pnl,opened_at,closed_at,raw_platform_state)
        SELECT o.id,$1,o.asset_id,o.direction,$2,$3,$4,$5,$6,$7,$8,$9,$10 FROM orders o WHERE o.id=$11
        ON CONFLICT(order_id) DO UPDATE SET platform_position_id=EXCLUDED.platform_position_id,quantity=EXCLUDED.quantity,entry_price=EXCLUDED.entry_price,take_profit=EXCLUDED.take_profit,stop_loss=EXCLUDED.stop_loss,unrealized_pnl=EXCLUDED.unrealized_pnl,realized_pnl=EXCLUDED.realized_pnl,closed_at=EXCLUDED.closed_at,updated_at=now(),raw_platform_state=EXCLUDED.raw_platform_state RETURNING id`,[
        position.id,position.quantity,position.entryPrice,position.takeProfit??null,position.stopLoss??null,position.unrealizedPnl??null,position.realizedPnl??null,position.openedAt,position.closedAt??null,JSON.stringify(position.raw),order.id
      ]);
      positionId=saved.rows[0]?.id??null;
      if(position.realizedPnl!==undefined)await client.query("UPDATE orders SET realized_pnl=$1,updated_at=now() WHERE id=$2",[position.realizedPnl,order.id]);
    }
    for(const fill of remote.fills??[]){
      await client.query(`INSERT INTO fills(order_id,position_id,platform_fill_id,side,price,quantity,fee,realized_pnl,filled_at,raw_platform_state)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(platform_fill_id) DO UPDATE SET position_id=EXCLUDED.position_id,fee=EXCLUDED.fee,realized_pnl=EXCLUDED.realized_pnl,raw_platform_state=EXCLUDED.raw_platform_state`,[
        order.id,positionId,fill.id,fill.side,fill.price,fill.quantity,fill.fee??null,fill.realizedPnl??null,fill.filledAt,JSON.stringify(fill.raw)
      ]);
      if(fill.realizedPnl!==undefined)await client.query("UPDATE orders SET realized_pnl=$1,updated_at=now() WHERE id=$2",[fill.realizedPnl,order.id]);
    }
  });
}

async function reconcileOpenOrders():Promise<unknown>{
  try{
    const local=await query<{id:string;asset_id:string;platform_order_id:string;state:string}>("SELECT id,asset_id,platform_order_id,state FROM orders WHERE state IN ('PENDING_ENTRY','FILLED_OPEN','UNKNOWN','RECONCILIATION_REQUIRED')");
    if(!local.rows.length)return undefined;
    const platform=await adapter.listTracked(local.rows.flatMap((order)=>order.platform_order_id?[order.platform_order_id]:[]));
    const byId=new Map(platform.map((order)=>[order.id,order]));
    for(const order of local.rows){
      const remote=order.platform_order_id?byId.get(order.platform_order_id):undefined;
      if(!remote){if(order.state!=="UNKNOWN"&&order.state!=="RECONCILIATION_REQUIRED")await setState(order.id,order.state,"RECONCILIATION_REQUIRED","30-second reconciliation did not find active platform order");continue;}
      await persistPlatformDetails(order,remote);
      if(remote.state==="FILLED_OPEN"&&remote.takeProfitPresent!==undefined&&remote.stopLossPresent!==undefined){
        const protection=reconcileProtectionState({localState:order.state as "PENDING_ENTRY"|"FILLED_OPEN"|"UNKNOWN"|"RECONCILIATION_REQUIRED",platformState:"FILLED_OPEN",takeProfitPresent:remote.takeProfitPresent,stopLossPresent:remote.stopLossPresent});
        if(protection.action==="PAUSE_MANUAL_ONLY"){
          await transaction(async(client)=>{
            await client.query("UPDATE assets SET paused=true,pause_reason='EXISTING_PROTECTION_MISSING',updated_at=now() WHERE id=$1",[order.asset_id]);
            if(order.state!=="RECONCILIATION_REQUIRED"){
              await client.query("UPDATE orders SET state='RECONCILIATION_REQUIRED',raw_platform_state=$1,updated_at=now() WHERE id=$2",[JSON.stringify(remote.raw),order.id]);
              await client.query("INSERT INTO order_events(order_id,from_state,to_state,reason,payload) VALUES($1,$2,'RECONCILIATION_REQUIRED',$3,$4)",[order.id,order.state,protection.reason,JSON.stringify(remote.raw)]);
              await client.query("INSERT INTO outbox(topic,payload) VALUES('notification.order_failed',$1)",[JSON.stringify({orderId:order.id,reason:protection.reason,manualIntervention:true})]);
            }
          });
          continue;
        }
      }
      if(remote.state!==order.state){
        try{await setState(order.id,order.state,remote.state,"30-second Variational authoritative sync",remote.raw);}
        catch{if(order.state!=="RECONCILIATION_REQUIRED")await setState(order.id,order.state,"RECONCILIATION_REQUIRED","platform state cannot follow local transition table",remote.raw);}
      }
    }
    return undefined;
  }catch(error){return error;}
}

async function claimWork(){
  return transaction(async(client)=>{
    const result=await client.query<Record<string,unknown>>("SELECT * FROM outbox WHERE topic IN ('order.submit','control.global_pause','control.global_resume','strategy.changed') AND status='pending' ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1");
    if(!result.rows[0])return null;
    await client.query("UPDATE outbox SET status='processing' WHERE id=$1",[result.rows[0].id]);return result.rows[0];
  });
}

async function cancelManagedPending(newStrategyId?:string){
  const result=await query<{id:string;asset_id:string;platform_order_id:string|null;state:string;strategy_id:string}>(`SELECT id,asset_id,platform_order_id,state,strategy_id
    FROM orders WHERE state='PENDING_ENTRY' ${newStrategyId?"AND strategy_id<>$1":""} ORDER BY created_at`,newStrategyId?[newStrategyId]:[]);
  const cancellations:Array<{orderId:string;platformOrderId:string|null;cancelled:boolean;state?:PlatformEntryState;error?:string}>=[];
  for(const order of result.rows){
    if(!order.platform_order_id){
      const error="Local pending order has no platform order ID";
      cancellations.push({orderId:order.id,platformOrderId:null,cancelled:false,error});
      await recordBusinessError({service:"variational-agent",assetId:order.asset_id,code:"MANAGED_ORDER_CANCEL_FAILED",message:error,blocksTrading:false,context:{orderId:order.id}});
      continue;
    }
    try{
      const cancelled=await adapter.cancelEntry(order.platform_order_id);
      cancellations.push({orderId:order.id,platformOrderId:order.platform_order_id,cancelled:cancelled.cancelled,state:cancelled.state});
      if(cancelled.state!==order.state)await setState(order.id,order.state,cancelled.state,"operator control cancellation reconciliation",cancelled.raw);
      if(!cancelled.cancelled&&cancelled.state==="PENDING_ENTRY")await recordBusinessError({service:"variational-agent",assetId:order.asset_id,code:"MANAGED_ORDER_CANCEL_NOT_CONFIRMED",message:"Variational still reports the entry as pending after one cancellation attempt",blocksTrading:false,context:{orderId:order.id,platformOrderId:order.platform_order_id}});
    }catch(error){
      const message=error instanceof Error?error.message:String(error);
      cancellations.push({orderId:order.id,platformOrderId:order.platform_order_id,cancelled:false,error:message});
      await recordBusinessError({service:"variational-agent",assetId:order.asset_id,code:"MANAGED_ORDER_CANCEL_FAILED",message,blocksTrading:false,context:{orderId:order.id,platformOrderId:order.platform_order_id}});
    }
  }
  return cancellations;
}

async function handleControl(item:Record<string,unknown>){
  if(item.topic==="control.global_resume"){await query("UPDATE outbox SET status='sent',sent_at=now() WHERE id=$1",[item.id]);return;}
  if(item.topic==="control.global_pause"){
    const state=(await query<{value:Record<string,unknown>}>("SELECT value FROM app_state WHERE key='global_pause'")).rows[0]?.value;
    if(!state?.paused){await query("UPDATE outbox SET status='sent',sent_at=now(),payload=payload||'{\"skipped\":\"GLOBAL_PAUSE_NO_LONGER_ACTIVE\"}'::jsonb WHERE id=$1",[item.id]);return;}
  }
  const payload=item.payload as {strategyId?:unknown};
  const newStrategyId=item.topic==="strategy.changed"&&typeof payload.strategyId==="string"?payload.strategyId:undefined;
  const result=await cancelManagedPending(newStrategyId);
  await query("UPDATE outbox SET status='sent',sent_at=now(),payload=payload||$1::jsonb WHERE id=$2",[JSON.stringify({cancellationResult:result}),item.id]);
}

async function handleOrder(item:Record<string,unknown>){
  const payload=item.payload as {orderId:string;plan:OrderPlan};
  const order=(await query<{state:string;asset_id:string}>("SELECT state,asset_id FROM orders WHERE id=$1",[payload.orderId])).rows[0];
  if(!order){await query("UPDATE outbox SET status='failed' WHERE id=$1",[item.id]);return;}
  let submissionAttempted=false;
  await setState(payload.orderId,order.state,"SUBMITTING","outbox claimed");
  try{
    const requiredMargin=await adapter.minimumMargin(payload.plan);
    const adjusted=adjustMarginForPlatformMinimum(config.DEFAULT_MARGIN_USDC,requiredMargin,config.MAX_MARGIN_USDC,config.LEVERAGE);
    if(!adjusted.accepted){
      await setState(payload.orderId,"SUBMITTING","SUBMISSION_FAILED",adjusted.reason);
      await query("UPDATE outbox SET status='sent',sent_at=now() WHERE id=$1",[item.id]);
      return;
    }
    const plan={...payload.plan,marginUsdc:adjusted.marginUsdc,notionalUsdc:adjusted.notionalUsdc};
    await query("UPDATE orders SET margin_usdc=$1 WHERE id=$2",[adjusted.marginUsdc,payload.orderId]);
    submissionAttempted=true;
    const result=await submitWithInitialProtection(adapter,plan);
    const submitted=result.entry.submittedPrices;
    // The platform's price precision is authoritative; store what was actually
    // submitted so the audit trail and the Dashboard never show a price that
    // Variational never saw.
    if(submitted)await query("UPDATE orders SET platform_order_id=$1,entry_price=$2,take_profit=$3,stop_loss=$4,updated_at=now() WHERE id=$5",[result.entry.id,submitted.entryPrice,submitted.takeProfit,submitted.stopLoss,payload.orderId]);
    else await query("UPDATE orders SET platform_order_id=$1 WHERE id=$2",[result.entry.id,payload.orderId]);
    if(result.status==="PROTECTED"){
      await setState(payload.orderId,"SUBMITTING",result.entry.state,"entry and both protections confirmed",result);
      await query("UPDATE outbox SET status='sent',sent_at=now() WHERE id=$1",[item.id]);
      return;
    }
    const terminal=result.status==="ENTRY_CANCELLED"||result.status==="EMERGENCY_CLOSED";
    await setState(payload.orderId,"SUBMITTING",terminal?"SUBMISSION_FAILED":"UNKNOWN",`initial protection compensation: ${result.status}`,result);
    await recordBusinessError({service:"variational-agent",assetId:order.asset_id,code:`INITIAL_PROTECTION_${result.status}`,message:result.errors.join("; ")||result.status,blocksTrading:result.pauseAsset,context:{orderId:payload.orderId}});
    if(result.pauseAsset)await query("UPDATE assets SET paused=true,pause_reason='VARIATIONAL_PROTECTION_FAILURE',updated_at=now() WHERE id=$1",[order.asset_id]);
    await query("UPDATE outbox SET status='sent',sent_at=now() WHERE id=$1",[item.id]);
  }catch(error){
    const message=error instanceof Error?error.message:String(error);
    const state=submissionAttempted?"UNKNOWN":"SUBMISSION_FAILED";
    await setState(payload.orderId,"SUBMITTING",state,submissionAttempted?"submit response not authoritative":"pre-submit validation failed",{error:message});
    await query("UPDATE outbox SET status='failed',attempts=attempts+1 WHERE id=$1",[item.id]);
  }
}

async function rejectWithoutSubmission(item:Record<string,unknown>,reason:string){
  const payload=item.payload as {orderId:string};
  const order=(await query<{state:string}>("SELECT state FROM orders WHERE id=$1",[payload.orderId])).rows[0];
  if(order?.state==="CREATED_LOCAL")await setState(payload.orderId,"CREATED_LOCAL","SUBMISSION_FAILED",reason);
  await query("UPDATE outbox SET status='sent',sent_at=now(),payload=payload||$1::jsonb WHERE id=$2",[JSON.stringify({rejectedWithoutSubmission:true,reason}),item.id]);
}

async function tick(){
  const previousSession=(await query<{value:Record<string,unknown>}>("SELECT value FROM app_state WHERE key='variational_session'")).rows[0]?.value??{};
  const valid=await adapter.sessionValid();
  const discoveryComplete=config.VARIATIONAL_ADAPTER_MODE==="browser-fetch";
  if(previousSession.loggedIn&&!valid)await query("INSERT INTO outbox(topic,payload) VALUES('notification.variational_session_lost',$1)",[JSON.stringify({detectedAt:new Date().toISOString()})]);
  const accountError=valid?await refreshAccount():undefined;
  const reconciliationError=valid?await reconcileOpenOrders():undefined;
  const reconciled=valid&&(Boolean(previousSession.reconciled)||!reconciliationError);
  await query("UPDATE app_state SET value=$1,updated_at=now() WHERE key='variational_session'",[JSON.stringify({loggedIn:valid,discoveryComplete,reconciled})]);
  const item=await claimWork();
  if(item){
    if(item.topic==="order.submit"){
      if(valid&&reconciled&&config.LIVE_TRADING_ENABLED)await handleOrder(item);
      else await rejectWithoutSubmission(item,!valid?"VARIATIONAL_SESSION_INVALID":!reconciled?"STARTUP_RECONCILIATION_INCOMPLETE":"LIVE_TRADING_DISABLED");
    }else await handleControl(item);
  }
  if(!valid||!config.LIVE_TRADING_ENABLED){await recordHealth("variational-agent",false,!valid?"Variational session invalid":"Live trading disabled",true);return;}
  const readError=accountError??reconciliationError;
  await recordHealth("variational-agent",!readError,readError,false);
}

async function recoverInterruptedWork(){
  await transaction(async(client)=>{
    const interrupted=await client.query<{id:string}>("SELECT id FROM orders WHERE state='SUBMITTING' FOR UPDATE");
    for(const order of interrupted.rows){
      await client.query("UPDATE orders SET state='UNKNOWN',updated_at=now() WHERE id=$1",[order.id]);
      await client.query("INSERT INTO order_events(order_id,from_state,to_state,reason,payload) VALUES($1,'SUBMITTING','UNKNOWN','agent restarted during an ambiguous submission',NULL)",[order.id]);
      await client.query("INSERT INTO outbox(topic,payload) VALUES('notification.order_failed',$1)",[JSON.stringify({orderId:order.id,reason:"AMBIGUOUS_SUBMISSION_AFTER_RESTART",manualIntervention:true})]);
    }
    await client.query("UPDATE outbox SET status='failed',attempts=attempts+1 WHERE topic='order.submit' AND status='processing'");
    await client.query("UPDATE outbox SET status='pending' WHERE topic<>'order.submit' AND status='processing'");
  });
}

let shuttingDown=false;
async function shutdown(){if(shuttingDown)return;shuttingDown=true;await adapter.close?.();await pool.end();process.exit(0);}
process.on("SIGTERM",shutdown);
process.on("SIGINT",shutdown);
await query("UPDATE app_state SET value=value||'{\"loggedIn\":false,\"reconciled\":false}'::jsonb,updated_at=now() WHERE key='variational_session'");
await recoverInterruptedWork();
while(true){try{await tick();}catch(error){await recordHealth("variational-agent",false,error,true);}await sleep(fixedRules.variationalPollMs);}
