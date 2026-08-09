import { fixedRules,getConfig } from "@huxtrade/config";
import { claimRestartRequest,pool,query,recordBusinessError,recordHealth,transaction } from "@huxtrade/database";
import { adjustMarginForPlatformMinimum,assertOrderTransition,breakevenStopPrice,breakevenThroughMarket,marginPauseTransition,resolveRestingEntry,scaleOutDecision,stopClearsSpread } from "@huxtrade/strategy-engine";
import { variationalUnderlying } from "@huxtrade/exchange-clients";
import type { OrderPlan,OrderState } from "@huxtrade/shared-types";
import { decideAssetConflict,decideReversalClose,notificationTopicsForTransition,reconcileProtectionState,submitWithInitialProtection,type PlatformEntry,type PlatformEntryState,type PlatformProtection,type PlatformTrackedOrder,type ProtectionAdapter } from "./execution.js";
import { BrowserFetchTransport,isRetryableEntryRejection,isTransientVenueRejection,VariationalRequestError } from "./browser-fetch-transport.js";
import { OmniBrowserAdapter,type TrackedOrderRef,type VariationalAdapter } from "./omni-adapter.js";

const config=getConfig();
const sleep=(ms:number)=>new Promise((resolve)=>setTimeout(resolve,ms));
class DisabledAdapter implements VariationalAdapter{
  async sessionValid(){return false;}
  async account():Promise<{balanceUsdc:number;marginUsagePercent:number}>{throw new Error("Variational adapter is disabled");}
  async minimumMargin(_plan:OrderPlan):Promise<number>{throw new Error("Variational adapter is disabled");}
  async quotedSpread(_plan:OrderPlan):Promise<number|undefined>{return undefined;}
  async submitEntry(_plan:Record<string,unknown>):Promise<PlatformEntry>{throw new Error("Variational adapter is disabled");}
  async placeTakeProfit(_entry:PlatformEntry,_plan:OrderPlan):Promise<PlatformProtection>{throw new Error("Variational adapter is disabled");}
  async placeStopLoss(_entry:PlatformEntry,_plan:OrderPlan):Promise<PlatformProtection>{throw new Error("Variational adapter is disabled");}
  async orderState(_entryId:string):Promise<PlatformEntryState>{throw new Error("Variational adapter is disabled");}
  async cancelEntry(_entryId:string):Promise<{cancelled:boolean;state:PlatformEntryState;raw:Record<string,unknown>}>{throw new Error("Variational adapter is disabled");}
  async cancelOrder(_orderId:string){throw new Error("Variational adapter is disabled");}
  async closeMarket(_entryId:string):Promise<{closed:boolean;raw:Record<string,unknown>}>{throw new Error("Variational adapter is disabled");}
  async listTracked(_orders:TrackedOrderRef[]){return[];}
  async cancelPending():Promise<Array<{id:string;cancelled:boolean}>>{throw new Error("Variational adapter is disabled");}
  async activeProtectionCount(_symbol:string){return 0;}
  async closeSettlement(_closeRfqId:string){return {};}
  async closeMarketPartial(_entryId:string,_fraction:number):Promise<{closed:boolean;raw:unknown}>{throw new Error("Variational adapter is disabled");}
  async cancelProtection(_symbol:string,_kind:"take_profit"|"stop_loss"):Promise<{cancelled:number}>{throw new Error("Variational adapter is disabled");}
  async placeProtection(_input:{symbol:string;kind:"take_profit"|"stop_loss";direction:"LONG"|"SHORT";triggerPrice:number}):Promise<{id:string;triggerPrice:string;raw:unknown}>{throw new Error("Variational adapter is disabled");}
}

const adapter:VariationalAdapter=config.VARIATIONAL_ADAPTER_MODE==="browser-fetch"
  ?new OmniBrowserAdapter(new BrowserFetchTransport(config),config)
  :new DisabledAdapter();

const closedOrderStates=["CLOSED_TP","CLOSED_SL","CLOSED_REVERSED","LIQUIDATED","CANCELLED_EXTERNALLY"];

async function setState(orderId:string,from:string,to:string,reason:string,payload?:unknown,cause?:"VENUE_LIMIT"|"REPLACEMENT"){
  assertOrderTransition(from,to);
  await transaction(async(client)=>{
    await client.query("UPDATE orders SET state=$1,raw_platform_state=$2,updated_at=now() WHERE id=$3",[to,payload?JSON.stringify(payload):null,orderId]);
    // The platform's /api/positions only ever lists open positions, so a
    // closed order's positions row would otherwise stay frozen open forever,
    // stale unrealized PnL included.
    if(closedOrderStates.includes(to))await client.query("UPDATE positions SET closed_at=now(),unrealized_pnl=NULL,updated_at=now() WHERE order_id=$1 AND closed_at IS NULL",[orderId]);
    await client.query("INSERT INTO order_events(order_id,from_state,to_state,reason,payload) VALUES($1,$2,$3,$4,$5)",[orderId,from,to,reason,payload?JSON.stringify(payload):null]);
    for(const topic of notificationTopicsForTransition(from as Parameters<typeof notificationTopicsForTransition>[0],to as Parameters<typeof notificationTopicsForTransition>[1],cause))await client.query("INSERT INTO outbox(topic,payload) VALUES($1,$2)",[topic,JSON.stringify({orderId,fromState:from,toState:to,reason,details:payload??null})]);
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
      // The venue's aggregate rpnl already contains whatever the scale-out
      // realised, and scaled_out_pnl records that separately — copying it
      // wholesale counted ON's +7.16 twice. realized_pnl means "the final
      // exit" (see migration 016), so the banked half is subtracted back out.
      if(position.realizedPnl!==undefined)await client.query("UPDATE orders SET realized_pnl=$1-coalesce(scaled_out_pnl,0),updated_at=now() WHERE id=$2",[position.realizedPnl,order.id]);
    }
    for(const fill of remote.fills??[]){
      await client.query(`INSERT INTO fills(order_id,position_id,platform_fill_id,side,price,quantity,fee,realized_pnl,filled_at,raw_platform_state)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(platform_fill_id) DO UPDATE SET position_id=EXCLUDED.position_id,fee=EXCLUDED.fee,realized_pnl=EXCLUDED.realized_pnl,raw_platform_state=EXCLUDED.raw_platform_state`,[
        order.id,positionId,fill.id,fill.side,fill.price,fill.quantity,fill.fee??null,fill.realizedPnl??null,fill.filledAt,JSON.stringify(fill.raw)
      ]);
      if(fill.realizedPnl!==undefined){
        // An exit trade closes the platform's aggregate position, so its
        // realized PnL covers every stacked order at once; each order only
        // books its quantity share, mirroring apportionPosition.
        const share=remote.quantity&&fill.quantity?Math.min(1,Math.abs(remote.quantity)/Math.abs(fill.quantity)):1;
        await client.query("UPDATE orders SET realized_pnl=$1,updated_at=now() WHERE id=$2",[fill.realizedPnl*share,order.id]);
      }
    }
  });
}

const unknownReleaseMissLimit=10;

async function reconcileOpenOrders():Promise<unknown>{
  try{
    const local=await query<ReconcilableOrder>(`SELECT o.id,o.asset_id,o.platform_order_id,o.state,o.direction,o.entry_price,o.stop_loss,o.take_profit,o.scaled_out_at,o.breakeven_stop_price,o.reconcile_misses,a.code,a.binance_symbol,a.variational_url
      FROM orders o JOIN assets a ON a.id=o.asset_id WHERE o.state IN ('PENDING_ENTRY','FILLED_OPEN','UNKNOWN','RECONCILIATION_REQUIRED')`);
    if(!local.rows.length)return undefined;
    // The local levels travel with the id so listTracked can attribute an exit
    // by where it printed when the venue's rfq trail comes up empty.
    const platform=await adapter.listTracked(local.rows.flatMap((order)=>order.platform_order_id?[{
      id:order.platform_order_id,direction:order.direction==="LONG"?"LONG" as const:"SHORT" as const,
      entryPrice:Number(order.entry_price),stopLoss:Number(order.stop_loss),takeProfit:Number(order.take_profit),
      breakevenStop:order.breakeven_stop_price!==null&&order.breakeven_stop_price!==undefined?Number(order.breakeven_stop_price):null
    }]:[]));
    const byId=new Map(platform.map((order)=>[order.id,order]));
    for(const order of local.rows){
      const remote=order.platform_order_id?byId.get(order.platform_order_id):undefined;
      if(!remote){
        // An UNKNOWN order that never got an rfq_id can never be matched by
        // ID, so reconciliation would otherwise keep it (and its slot in the
        // per-side order cap) occupied forever. Sustained absence of platform
        // evidence across consecutive authoritative syncs (~5 minutes) is
        // treated as proof nothing was created; the resulting order_failed
        // notification still tells the operator to double-check the platform.
        if(order.state==="UNKNOWN"&&!order.platform_order_id){
          const misses=await query<{reconcile_misses:number}>("UPDATE orders SET reconcile_misses=reconcile_misses+1,updated_at=now() WHERE id=$1 RETURNING reconcile_misses",[order.id]);
          if((misses.rows[0]?.reconcile_misses??0)>=unknownReleaseMissLimit)await setState(order.id,"UNKNOWN","SUBMISSION_FAILED",`no platform evidence after ${unknownReleaseMissLimit} authoritative reconciliations; verify manually on Variational`);
          continue;
        }
        if(order.state!=="UNKNOWN"&&order.state!=="RECONCILIATION_REQUIRED")await setState(order.id,order.state,"RECONCILIATION_REQUIRED","30-second reconciliation did not find active platform order");continue;}
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
      // A filled position that the venue momentarily does not report is the
      // normal shape of a settling partial close, not a lost order. Condemning
      // it on the first sweep flipped a healthy, protected ON position into
      // UNKNOWN — from which orders carrying an rfq id are never released.
      if(remote.state==="UNKNOWN"&&order.state==="FILLED_OPEN"){
        const misses=await query<{reconcile_misses:number}>("UPDATE orders SET reconcile_misses=reconcile_misses+1,updated_at=now() WHERE id=$1 RETURNING reconcile_misses",[order.id]);
        if((misses.rows[0]?.reconcile_misses??0)<filledOpenMissLimit)continue;
      }
      if(remote.state!==order.state){
        try{
          await setState(order.id,order.state,remote.state,"30-second Variational authoritative sync",remote.raw);
          await query("UPDATE orders SET reconcile_misses=0 WHERE id=$1",[order.id]);
        }
        catch{if(order.state!=="RECONCILIATION_REQUIRED")await setState(order.id,order.state,"RECONCILIATION_REQUIRED","platform state cannot follow local transition table",remote.raw);}
      }else if(order.reconcile_misses>0)await query("UPDATE orders SET reconcile_misses=0 WHERE id=$1",[order.id]);
      // Only after the sync above, so a position that has just reached its
      // target or stop is booked as closed rather than scaled out of.
      if(remote.state==="FILLED_OPEN"&&order.state==="FILLED_OPEN")await maybeScaleOut(order,remote);
    }
    return undefined;
  }catch(error){return error;}
}

interface ReconcilableOrder{
  id:string;asset_id:string;platform_order_id:string;state:string;
  direction:string;entry_price:string;stop_loss:string;take_profit:string;scaled_out_at:string|null;breakeven_stop_price:string|null;reconcile_misses:number;
  code:string;binance_symbol:string;variational_url:string|null;
}

/**
 * Per-strategy scale-out settings, re-read each sweep so a change made in the
 * management UI takes effect without restarting the agent.
 */
async function scaleOutSettings(){
  const row=await query<{resting_entry:Record<string,number>|null}>("SELECT resting_entry FROM strategies WHERE enabled LIMIT 1");
  return resolveRestingEntry(row.rows[0]?.resting_entry??null);
}

/**
 * Takes part of a winning position off and moves the rest's stop to breakeven.
 *
 * Ordering is the whole design. The reduce happens FIRST and the stop is moved
 * only once it has actually filled, because the two failure modes are not
 * symmetric: a stop moved on a trigger whose half-close never filled hands
 * over all of the "scratched out early" cost and none of the locked profit.
 * And because Variational has no amend-in-place, moving the stop means
 * cancelling the old one and taking the slot back — so if the replacement
 * cannot be armed, the remainder is closed outright rather than left running
 * naked. The worst case is a flat trade near breakeven, never an unprotected
 * position.
 */
async function maybeScaleOut(order:ReconcilableOrder,remote:PlatformTrackedOrder){
  if(order.scaled_out_at||!order.platform_order_id)return;
  const markPrice=Number((remote.position?.raw as Record<string,unknown>|undefined)?.mark_price);
  if(!Number.isFinite(markPrice))return;
  const settings=await scaleOutSettings();
  const direction=order.direction==="LONG"?"LONG":"SHORT";
  const decision=scaleOutDecision({
    direction,entryPrice:Number(order.entry_price),stopLoss:Number(order.stop_loss),
    markPrice,alreadyScaledOut:false
  },settings);
  if(decision.action!=="SCALE_OUT")return;

  const venueSymbol=variationalUnderlying(order.variational_url,order.binance_symbol);
  const reduced=await adapter.closeMarketPartial(order.platform_order_id,settings.scaleOutFraction);
  if(!reduced.closed){
    // A remainder the venue would refuse as dust is permanent, not transient:
    // recording it as a zero-quantity scale-out stops the trigger from firing
    // again on every 30-second sweep for the life of the position.
    if(reduced.tooSmall){
      await transaction(async(client)=>{
        await client.query("UPDATE orders SET scaled_out_at=now(),scaled_out_quantity=0,updated_at=now() WHERE id=$1",[order.id]);
        await client.query("INSERT INTO order_events(order_id,from_state,to_state,reason,payload) VALUES($1,'FILLED_OPEN','FILLED_OPEN',$2,$3)",
          [order.id,`scale-out skipped: ${order.code} cannot be reduced without leaving a sub-minimum remainder`,JSON.stringify(reduced.raw)]);
      });
      return;
    }
    await recordBusinessError({service:"variational-agent",assetId:order.asset_id,code:"SCALE_OUT_NOT_CONFIRMED",
      message:`${order.code} partial close did not confirm; will retry on the next sync`,blocksTrading:false,context:{orderId:order.id,raw:reduced.raw}});
    return;
  }

  const settled=reduced.rfqId?await adapter.closeSettlement(reduced.rfqId):{realizedPnl:undefined,fill:undefined};
  const breakeven=breakevenStopPrice(direction,Number(order.entry_price),Number(order.stop_loss),settings);
  // Booked before the stop is touched: a row with scaled_out_at set and
  // breakeven_stop_at still null is exactly the state that needs a human.
  await transaction(async(client)=>{
    await client.query(`UPDATE orders SET scaled_out_at=now(),scaled_out_price=$1,scaled_out_quantity=$2,scaled_out_pnl=$3,scaled_out_rfq_id=$4,updated_at=now() WHERE id=$5`,
      [settled.fill?.price??null,reduced.quantity??null,settled.realizedPnl??null,reduced.rfqId??null,order.id]);
    await client.query("INSERT INTO order_events(order_id,from_state,to_state,reason,payload) VALUES($1,'FILLED_OPEN','FILLED_OPEN',$2,$3)",
      [order.id,decision.reason,JSON.stringify({scaledOut:reduced.raw,settled})]);
  });

  // The reduce's own fill is the freshest transactable price there is — it is
  // literally where we just traded — so it, not the mark read at the top of
  // the sweep, is what decides whether breakeven is still reachable.
  const reference=Number(settled.fill?.price??markPrice);
  if(breakevenThroughMarket(direction,breakeven,reference)){
    // Price came back through breakeven while the half was filling. The stop
    // we were about to arm would fire the moment it existed, so skip the
    // round trip and take the same outcome directly. This is the breakeven
    // stop working, not failing — it must not raise the manual-intervention
    // alarm, which would then cry wolf on an ordinary retrace.
    let closeError:string|null=null;
    try{await closeReversedPosition(order.id,order.platform_order_id,`price retraced through breakeven (${breakeven}) while the scale-out was filling; remainder closed at market`);}
    catch(error){closeError=error instanceof Error?error.message:String(error);}
    await query("INSERT INTO outbox(topic,payload) VALUES('notification.scaled_out',$1)",[JSON.stringify({
      orderId:order.id,code:order.code,direction,profitR:decision.profitR,
      fraction:settings.scaleOutFraction,quantity:reduced.quantity,price:settled.fill?.price,
      realizedPnl:settled.realizedPnl,breakevenStop:breakeven,remainderClosedAtBreakeven:true,closeError
    })]);
    return;
  }

  let armed=false,lastError:unknown=null;
  try{
    await adapter.cancelProtection(venueSymbol,"stop_loss");
    for(let attempt=0;attempt<3&&!armed;attempt+=1){
      try{await adapter.placeProtection({symbol:venueSymbol,kind:"stop_loss",direction,triggerPrice:breakeven});armed=true;}
      catch(error){lastError=error;await sleep(protectionSlotDelayMs);}
    }
  }catch(error){lastError=error;}

  if(armed){
    await transaction(async(client)=>{
      await client.query("UPDATE orders SET breakeven_stop_at=now(),breakeven_stop_price=$1,updated_at=now() WHERE id=$2",[breakeven,order.id]);
      await client.query("INSERT INTO outbox(topic,payload) VALUES('notification.scaled_out',$1)",[JSON.stringify({
        orderId:order.id,code:order.code,direction,profitR:decision.profitR,
        fraction:settings.scaleOutFraction,quantity:reduced.quantity,price:settled.fill?.price,
        realizedPnl:settled.realizedPnl,breakevenStop:breakeven,remaining:reduced.remaining
      })]);
    });
    return;
  }

  // The half is banked and the remainder has no stop. Close it rather than
  // leave it running, and say so loudly — this is the one path in the feature
  // that ends with a human checking the venue.
  const message=lastError instanceof Error?lastError.message:String(lastError);
  await recordBusinessError({service:"variational-agent",assetId:order.asset_id,code:"BREAKEVEN_STOP_FAILED",
    message:`${order.code}: could not arm the breakeven stop after the scale-out (${message}); closing the remainder`,
    blocksTrading:false,context:{orderId:order.id,breakeven}});
  // The alert has to survive the close failing too — that is the worst case in
  // the whole feature (banked half, unprotected remainder) and the one where
  // an operator most needs to hear about it.
  let closeError:string|null=null;
  try{await closeReversedPosition(order.id,order.platform_order_id,`breakeven stop could not be armed after scaling out: ${message}`);}
  catch(error){closeError=error instanceof Error?error.message:String(error);}
  await query("INSERT INTO outbox(topic,payload) VALUES('notification.breakeven_stop_failed',$1)",[JSON.stringify({
    orderId:order.id,code:order.code,direction,breakevenStop:breakeven,error:message,
    remainderClosed:!closeError,closeError,manualIntervention:Boolean(closeError)
  })]);
}

/**
 * How many consecutive sweeps may fail to see a filled position before it is
 * treated as gone. Three is ~90 seconds — long enough to ride out the gap
 * while a partial close settles, short enough that a genuinely lost order is
 * still surfaced inside two minutes.
 */
const filledOpenMissLimit=3;

/**
 * Marks a refusal the same plan will reproduce, so signal-engine can rest the
 * asset instead of rebuilding it every 15 minutes. Deliberately NOT recorded
 * for transient venue refusals or network errors — retrying is right there.
 */
async function recordStructuralRejection(assetId:string,reason:string){
  await recordBusinessError({service:"variational-agent",assetId,code:"ORDER_STRUCTURALLY_REJECTED",
    message:reason,blocksTrading:false,context:{}});
}

const reversalBackfillWindowMinutes=30;

/**
 * An order we close ourselves leaves the reconciliation sweep the instant it
 * is marked terminal, so the exit trade and the realized-PnL transfer that
 * settle seconds later are never fetched — 12 of 45 historical
 * CLOSED_REVERSED orders carry no PnL, silently under-reporting every
 * reversal in the statistics. TP/SL exits are immune because reconciliation
 * *discovers* them: state and PnL land in the same sweep.
 *
 * Attribution goes through the close's own rfq id — stored on the order when
 * closeMarket returned — and never through listTracked. listTracked matches
 * positions by instrument, so on an instrument that already has a NEW
 * position it hands back that position for the old, closed order: an earlier
 * version of this function reopened a settled positions row and overwrote its
 * quantity with another order's. Only the rfq we ourselves submitted
 * identifies this close.
 */
async function backfillReversalDetails():Promise<unknown>{
  try{
    const pending=await query<{id:string;close_rfq:string}>(
      `SELECT id, raw_platform_state->>'rfq_id' close_rfq FROM orders
       WHERE state='CLOSED_REVERSED' AND coalesce(realized_pnl,0)=0
         AND raw_platform_state->>'rfq_id' IS NOT NULL
         AND updated_at > now() - ($1 || ' minutes')::interval`,[String(reversalBackfillWindowMinutes)]);
    for(const order of pending.rows){
      const settlement=await adapter.closeSettlement(order.close_rfq);
      if(settlement.realizedPnl===undefined&&!settlement.fill)continue;
      await transaction(async(client)=>{
        if(settlement.fill){
          const fill=settlement.fill;
          await client.query(`INSERT INTO fills(order_id,position_id,platform_fill_id,side,price,quantity,fee,realized_pnl,filled_at,raw_platform_state)
            SELECT $1,p.id,$2,$3,$4,$5,$6,$7,$8,$9 FROM (SELECT id FROM positions WHERE order_id=$1) p
            ON CONFLICT(platform_fill_id) DO UPDATE SET fee=EXCLUDED.fee,realized_pnl=EXCLUDED.realized_pnl,raw_platform_state=EXCLUDED.raw_platform_state`,
            [order.id,fill.id,fill.side,fill.price,fill.quantity,fill.fee??null,fill.realizedPnl??null,fill.filledAt,JSON.stringify(fill.raw)]);
        }
        // Positions are deliberately untouched here: this order's row is
        // already closed, and the instrument's live position belongs to a
        // different order.
        if(settlement.realizedPnl!==undefined)await client.query("UPDATE orders SET realized_pnl=$1,updated_at=updated_at WHERE id=$2",[settlement.realizedPnl,order.id]);
      });
    }
    return undefined;
  }catch(error){return error;}
}

async function claimWork(){
  return transaction(async(client)=>{
    // available_at is honoured so a message that defers itself back to pending
    // (a reversal close waiting on the session) yields its place at the head of
    // the queue instead of starving everything behind it. Everything else
    // inserts with the now() default and is unaffected.
    const result=await client.query<Record<string,unknown>>("SELECT * FROM outbox WHERE topic IN ('order.submit','order.place_resting','order.cancel_replace','order.cancel_working','order.close_opposite','control.global_pause','control.global_resume','strategy.changed') AND status='pending' AND available_at<=now() ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1");
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

const submissionRetryDelayMs=5_000;
const repeatedSubmissionFailurePauseCount=3;

/**
 * When Variational structurally rejects an asset (e.g. LIT's unsupported
 * leverage returning 422 on every attempt), each new signal would otherwise
 * retry forever and fail forever. Three consecutive SUBMISSION_FAILED orders
 * on the same asset pause it, mirroring the data-anomaly single-asset pause:
 * the reason has no retryable prefix, so only a human can resume it.
 */
async function pauseAssetIfSubmissionsKeepFailing(assetId:string){
  const recent=await query<{state:string}>("SELECT state FROM orders WHERE asset_id=$1 ORDER BY created_at DESC LIMIT $2",[assetId,repeatedSubmissionFailurePauseCount]);
  if(recent.rows.length<repeatedSubmissionFailurePauseCount||recent.rows.some((row)=>row.state!=="SUBMISSION_FAILED"))return;
  const paused=await query("UPDATE assets SET paused=true,pause_reason='REPEATED_SUBMISSION_FAILURE',updated_at=now() WHERE id=$1 AND paused=false",[assetId]);
  if(!paused.rowCount)return;
  await recordBusinessError({service:"variational-agent",assetId,code:"REPEATED_SUBMISSION_FAILURE",message:`${repeatedSubmissionFailurePauseCount} consecutive submissions for this asset failed; paused until manually resumed`,blocksTrading:true,context:{}});
}

/**
 * The single implementation of "market-close a position and book it as
 * reversed", shared by the market-on-signal path (which closes as a step
 * inside its own submission) and by the resting model's standalone
 * order.close_opposite message. Throws when the platform will not confirm the
 * close, so both callers can decide their own compensation.
 */
async function closeReversedPosition(orderId:string,platformOrderId:string,reason:string){
  const closed=await adapter.closeMarket(platformOrderId);
  if(!closed.closed)throw new Error(`could not close the existing position on this asset before reversing (order ${orderId})`);
  await setState(orderId,"FILLED_OPEN","CLOSED_REVERSED",reason,closed.raw);
}

/**
 * The resting model does not submit on a bias flip, so the exit it wants can
 * no longer ride along with a submission — it arrives here as its own
 * message. Every outcome is decided from the order's current state (see
 * decideReversalClose), which is what makes a redelivered or restart-replayed
 * message harmless.
 */
async function handleCloseOpposite(item:Record<string,unknown>,sessionReady:boolean){
  const payload=item.payload as {orderId:string;reason?:string};
  const order=(await query<{state:string;asset_id:string;platform_order_id:string|null}>("SELECT state,asset_id,platform_order_id FROM orders WHERE id=$1",[payload.orderId])).rows[0];
  const decision=decideReversalClose({order:order?{state:order.state as OrderState,platformOrderId:order.platform_order_id}:null,sessionReady});
  if(decision.action==="DEFER"){
    // Back to pending rather than failed: the close still needs doing, and the
    // next poll re-claims it once the session is back. available_at moves out
    // so it stops being re-claimed every 30 seconds ahead of everything else.
    await query("UPDATE outbox SET status='pending',available_at=now()+interval '1 minute',payload=payload||$1::jsonb WHERE id=$2",[JSON.stringify({deferred:decision.reason}),item.id]);
    return;
  }
  if(decision.action==="SKIP"){
    await query("UPDATE outbox SET status='sent',sent_at=now(),payload=payload||$1::jsonb WHERE id=$2",[JSON.stringify({skipped:decision.reason}),item.id]);
    return;
  }
  try{
    await closeReversedPosition(payload.orderId,decision.platformOrderId,payload.reason??decision.reason);
    await query("UPDATE outbox SET status='sent',sent_at=now() WHERE id=$1",[item.id]);
  }catch(error){
    // The position stays open and stays wrong-way. No in-place retry: the next
    // 15m scan still sees an opposite position under a reversed bias and
    // queues a fresh close, so retrying here would only race that message.
    await recordBusinessError({service:"variational-agent",assetId:order!.asset_id,code:"REVERSAL_CLOSE_FAILED",message:error instanceof Error?error.message:String(error),blocksTrading:false,context:{orderId:payload.orderId}});
    await query("UPDATE outbox SET status='failed',attempts=attempts+1 WHERE id=$1",[item.id]);
  }
}

/**
 * Runs decideAssetConflict against whatever else is currently active on this
 * asset, then carries out whichever platform action it calls for before the
 * new order gets submitted. See decideAssetConflict's own comment for the
 * full reasoning; this is purely the DB-lookup/adapter-call plumbing around it.
 */
async function resolveAssetConflict(assetId:string,direction:"LONG"|"SHORT",excludeOrderId:string):Promise<{skipProtection:boolean}>{
  const row=(await query<{id:string;state:"PENDING_ENTRY"|"FILLED_OPEN";direction:"LONG"|"SHORT";platform_order_id:string|null}>(
    `SELECT id,state,direction,platform_order_id FROM orders WHERE asset_id=$1 AND id<>$2 AND state IN ('PENDING_ENTRY','FILLED_OPEN') ORDER BY created_at DESC LIMIT 1`,
    [assetId,excludeOrderId]
  )).rows[0];
  const existing=row?{id:row.id,state:row.state,direction:row.direction,platformOrderId:row.platform_order_id}:undefined;
  const decision=decideAssetConflict(existing,direction);
  if(decision.action==="SHARE_EXISTING_PROTECTION")return {skipProtection:true};
  if(decision.action==="CLOSE_EXISTING_POSITION"){
    await closeReversedPosition(decision.orderId,decision.platformOrderId,"closed to open the opposite direction");
  }else if(decision.action==="CANCEL_EXISTING_ENTRY"){
    const cancelled=await adapter.cancelEntry(decision.platformOrderId);
    if(!cancelled.cancelled)throw new Error(`could not cancel the existing pending entry on this asset before reversing (order ${decision.orderId})`);
    await setState(decision.orderId,"PENDING_ENTRY","CLOSED_REVERSED","cancelled to open the opposite direction",cancelled.raw);
  }
  return {skipProtection:false};
}

const protectionSlotAttempts=30;
const protectionSlotDelayMs=1_500;

/**
 * Variational allows one TP/SL pair per instrument, arms an entry's pair the
 * moment the entry is accepted rather than when it fills, and reaps a
 * cancelled entry's pair asynchronously — tens of seconds after the cancel
 * itself has been confirmed (Phase 0 P0-3: 2 orphans immediately after a
 * confirmed cancel, 0 a minute later). Submitting into that window is
 * rejected outright with a 400.
 *
 * This affects the resting model's replace path most, since it cancels and
 * re-places on the same instrument by design, but the market-on-signal path
 * has the same race whenever it cancels or closes a conflicting order first.
 *
 * Timing out is not fatal: the caller's normal failure path applies, and the
 * next scan re-queues the work against the real state.
 */
async function waitForProtectionSlot(symbol:string,assetId:string){
  for(let attempt=0;attempt<protectionSlotAttempts;attempt+=1){
    if(await adapter.activeProtectionCount(symbol)===0)return;
    await sleep(protectionSlotDelayMs);
  }
  await recordBusinessError({service:"variational-agent",assetId,code:"PROTECTION_SLOT_NOT_RELEASED",
    message:`${symbol} still has an active TP/SL pair after ${Math.round(protectionSlotAttempts*protectionSlotDelayMs/1000)}s; submitting anyway and letting the platform arbitrate`,
    blocksTrading:false,context:{symbol}});
}

async function handleOrder(item:Record<string,unknown>){
  const payload=item.payload as {orderId:string;plan:OrderPlan};
  await submitOrder(item,payload.orderId,payload.plan);
}

/**
 * The submission machinery, shared by the market-on-signal path and the
 * resting model. The only thing that differs between them is where
 * plan.entryPrice came from — the market price at signal time, or a structural
 * level chosen up to 2.5 ATR away — and nothing below cares which.
 */
async function submitOrder(item:Record<string,unknown>,orderId:string,orderPlan:OrderPlan,cause?:"REPLACEMENT"){
  const payload={orderId,plan:orderPlan};
  const order=(await query<{state:string;asset_id:string}>("SELECT state,asset_id FROM orders WHERE id=$1",[payload.orderId])).rows[0];
  if(!order){await query("UPDATE outbox SET status='failed' WHERE id=$1",[item.id]);return;}
  let submissionAttempted=false;
  await setState(payload.orderId,order.state,"SUBMITTING","outbox claimed");
  for(let attempt=1;attempt<=2;attempt+=1){
    try{
      const requiredMargin=await adapter.minimumMargin(payload.plan);
      const adjusted=adjustMarginForPlatformMinimum(config.DEFAULT_MARGIN_USDC,requiredMargin,config.MAX_MARGIN_USDC,config.LEVERAGE);
      if(!adjusted.accepted){
        // Structural too: the venue's minimum exceeds the margin cap and will
        // keep doing so until one of the two numbers changes.
        await setState(payload.orderId,"SUBMITTING","SUBMISSION_FAILED",adjusted.reason);
        await recordStructuralRejection(order.asset_id,adjusted.reason);
        await query("UPDATE outbox SET status='sent',sent_at=now() WHERE id=$1",[item.id]);
        return;
      }
      // Refused here rather than in the plan: only the venue knows the spread,
      // and a stop that cannot clear it turns the trade into a round trip paid
      // out of its own risk budget. PAXG planned a 0.064% stop against a
      // 0.059% spread — it would have opened most of the way to its stop.
      const spread=await adapter.quotedSpread(payload.plan);
      const stopDistance=Math.abs(payload.plan.entryPrice-payload.plan.stopLoss);
      const settings=await scaleOutSettings();
      if(!stopClearsSpread(stopDistance,spread??0,settings)){
        const why=`the ${stopDistance.toPrecision(6)} stop is under ${settings.minStopSpreadMultiple}x the ${spread?.toPrecision(6)} quoted spread`;
        await setState(payload.orderId,"SUBMITTING","SUBMISSION_FAILED",why,undefined,"VENUE_LIMIT");
        await recordStructuralRejection(order.asset_id,why);
        await query("UPDATE outbox SET status='sent',sent_at=now() WHERE id=$1",[item.id]);
        return;
      }
      const plan={...payload.plan,marginUsdc:adjusted.marginUsdc,notionalUsdc:adjusted.notionalUsdc};
      await query("UPDATE orders SET margin_usdc=$1 WHERE id=$2",[adjusted.marginUsdc,payload.orderId]);
      submissionAttempted=true;
      const conflict=await resolveAssetConflict(order.asset_id,plan.direction,payload.orderId);
      // Only when this submission is about to create its own pair. A
      // SHARE_EXISTING_PROTECTION submission deliberately rides an existing
      // pair that is supposed to be there and would wait forever.
      if(!conflict.skipProtection)await waitForProtectionSlot(plan.venueSymbol??plan.symbol,order.asset_id);
      const result=await submitWithInitialProtection(adapter,plan,{skipProtection:conflict.skipProtection});
      const submitted=result.entry.submittedPrices;
      // The platform's price precision is authoritative; store what was actually
      // submitted so the audit trail and the Dashboard never show a price that
      // Variational never saw.
      if(submitted)await query("UPDATE orders SET platform_order_id=$1,entry_price=$2,take_profit=$3,stop_loss=$4,updated_at=now() WHERE id=$5",[result.entry.id,submitted.entryPrice,submitted.takeProfit,submitted.stopLoss,payload.orderId]);
      else await query("UPDATE orders SET platform_order_id=$1 WHERE id=$2",[result.entry.id,payload.orderId]);
      if(result.status==="PROTECTED"){
        await setState(payload.orderId,"SUBMITTING",result.entry.state,conflict.skipProtection?"entry submitted; sharing the existing same-direction position's TP/SL":"entry and both protections confirmed",result,cause);
        await query("UPDATE outbox SET status='sent',sent_at=now() WHERE id=$1",[item.id]);
        return;
      }
      const terminal=result.status==="ENTRY_CANCELLED"||result.status==="EMERGENCY_CLOSED";
      await setState(payload.orderId,"SUBMITTING",terminal?"SUBMISSION_FAILED":"UNKNOWN",`initial protection compensation: ${result.status}`,result);
      await recordBusinessError({service:"variational-agent",assetId:order.asset_id,code:`INITIAL_PROTECTION_${result.status}`,message:result.errors.join("; ")||result.status,blocksTrading:result.pauseAsset,context:{orderId:payload.orderId}});
      if(result.pauseAsset)await query("UPDATE assets SET paused=true,pause_reason='VARIATIONAL_PROTECTION_FAILURE',updated_at=now() WHERE id=$1",[order.asset_id]);
      await query("UPDATE outbox SET status='sent',sent_at=now() WHERE id=$1",[item.id]);
      return;
    }catch(error){
      if(attempt===1&&isRetryableEntryRejection(error)){
        adapter.forgetPreparation?.(payload.plan.idempotencyKey);
        await sleep(submissionRetryDelayMs);
        continue;
      }
      const message=error instanceof Error?error.message:String(error);
      // A definite 4xx means Variational parsed and rejected the request —
      // by HTTP convention nothing was created server-side — so it is
      // SUBMISSION_FAILED even after a submit attempt. UNKNOWN stays reserved
      // for genuinely ambiguous failures (timeouts, 5xx, lost responses)
      // where something may exist and only reconciliation can decide.
      const definiteRejection=error instanceof VariationalRequestError&&error.status>=400&&error.status<500;
      const state=submissionAttempted&&!definiteRejection?"UNKNOWN":"SUBMISSION_FAILED";
      const transientVenue=isTransientVenueRejection(error);
      await setState(payload.orderId,"SUBMITTING",state,state==="UNKNOWN"?"submit response not authoritative":transientVenue?"venue refused this side of the book for now":submissionAttempted?"platform rejected the request outright":"pre-submit validation failed",{error:message},transientVenue?"VENUE_LIMIT":undefined);
      await query("UPDATE outbox SET status='failed',attempts=attempts+1 WHERE id=$1",[item.id]);
      // A venue limit that clears on its own must not disable the asset: the
      // structural pause needs a human to lift it, and this does not.
      if(transientVenue)await recordBusinessError({service:"variational-agent",assetId:order.asset_id,code:"VENUE_LIMIT_REJECTED",message,blocksTrading:false,context:{orderId:payload.orderId}});
      else if(state==="SUBMISSION_FAILED")await pauseAssetIfSubmissionsKeepFailing(order.asset_id);
      return;
    }
  }
}

interface RestingContext{plan:OrderPlan;assetId:string;strategyId:string;signalId:string|null;reason?:string}

/**
 * Creates (or finds) the local order row for a resting entry. The agent owns
 * this row rather than the signal engine because a cancel_replace must not
 * leave an orphaned CREATED_LOCAL row behind when the cancel half fails —
 * that row would sit in openOrderStates forever, holding a slot for an order
 * that was never submitted.
 *
 * plan.idempotencyKey already hashes symbol|direction|level|closedAt, so a
 * redelivered outbox message lands on the same row instead of a second order.
 */
async function ensureRestingOrder(context:RestingContext):Promise<{id:string;state:string;platformOrderId:string|null}|null>{
  const plan=context.plan;
  const created=await transaction(async(client)=>{
    const inserted=await client.query<{id:string}>(`INSERT INTO orders(signal_id,asset_id,strategy_id,idempotency_key,direction,state,entry_price,stop_loss,take_profit,margin_usdc,leverage,entry_kind,entry_provenance)
      VALUES($1,$2,$3,$4,$5,'CREATED_LOCAL',$6,$7,$8,$9,$10,'RESTING_LIMIT',$11) ON CONFLICT(idempotency_key) DO NOTHING RETURNING id`,
      [context.signalId,context.assetId,context.strategyId,plan.idempotencyKey,plan.direction,plan.entryPrice,plan.stopLoss,plan.takeProfit,plan.marginUsdc,plan.leverage,JSON.stringify(plan.entryProvenance??null)]);
    if(inserted.rows[0])await client.query("INSERT INTO order_events(order_id,from_state,to_state,reason,payload) VALUES($1,NULL,'CREATED_LOCAL',$2,$3)",[inserted.rows[0].id,context.reason??"resting entry planned",JSON.stringify(plan)]);
    return inserted.rows[0]?.id??null;
  });
  const id=created??(await query<{id:string}>("SELECT id FROM orders WHERE idempotency_key=$1",[plan.idempotencyKey])).rows[0]?.id;
  if(!id)return null;
  const row=(await query<{state:string;platform_order_id:string|null}>("SELECT state,platform_order_id FROM orders WHERE id=$1",[id])).rows[0];
  return row?{id,state:row.state,platformOrderId:row.platform_order_id}:null;
}

/** A redelivery must never submit twice; only a fresh local row is submittable. */
function restingOrderIsSubmittable(order:{state:string;platformOrderId:string|null}){
  return order.state==="CREATED_LOCAL"&&!order.platformOrderId;
}

async function handlePlaceResting(item:Record<string,unknown>){
  const context=item.payload as RestingContext;
  const order=await ensureRestingOrder(context);
  if(!order||!restingOrderIsSubmittable(order)){
    await query("UPDATE outbox SET status='sent',sent_at=now(),payload=payload||$1::jsonb WHERE id=$2",[JSON.stringify({skipped:order?`order already ${order.state}`:"order row could not be created"}),item.id]);
    return;
  }
  await submitOrder(item,order.id,context.plan);
}

/**
 * Cancel the working order, then submit its replacement — in that order, so
 * the asset never holds two resting entries at once.
 *
 * Compensation (spec 4-2): if the cancel is not confirmed, the old order is
 * left exactly as it was and nothing new is submitted. The next 15m scan
 * revalidates from the real state and re-queues whatever is still needed, so
 * there is deliberately no retry here to race it with.
 */
async function handleCancelReplace(item:Record<string,unknown>){
  const context=item.payload as RestingContext&{oldOrderId:string};
  const previous=(await query<{state:string;asset_id:string;platform_order_id:string|null}>("SELECT state,asset_id,platform_order_id FROM orders WHERE id=$1",[context.oldOrderId])).rows[0];
  if(previous&&previous.state==="PENDING_ENTRY"){
    if(!previous.platform_order_id){
      await recordBusinessError({service:"variational-agent",assetId:context.assetId,code:"RESTING_REPLACE_CANCEL_FAILED",message:"the working order has no platform order ID, so it cannot be cancelled by ID",blocksTrading:false,context:{orderId:context.oldOrderId}});
      await query("UPDATE outbox SET status='failed',attempts=attempts+1 WHERE id=$1",[item.id]);
      return;
    }
    try{
      const cancelled=await adapter.cancelEntry(previous.platform_order_id);
      if(!cancelled.cancelled){
        await recordBusinessError({service:"variational-agent",assetId:context.assetId,code:"RESTING_REPLACE_CANCEL_FAILED",message:`Variational still reports the working entry as ${cancelled.state} after a cancellation attempt; the replacement was not submitted`,blocksTrading:false,context:{orderId:context.oldOrderId}});
        await query("UPDATE outbox SET status='failed',attempts=attempts+1 WHERE id=$1",[item.id]);
        return;
      }
      await setState(context.oldOrderId,"PENDING_ENTRY","CANCELLED_REPLACED",context.reason??"the structural level moved; replaced by a new resting entry",cancelled.raw);
    }catch(error){
      await recordBusinessError({service:"variational-agent",assetId:context.assetId,code:"RESTING_REPLACE_CANCEL_FAILED",message:error instanceof Error?error.message:String(error),blocksTrading:false,context:{orderId:context.oldOrderId}});
      await query("UPDATE outbox SET status='failed',attempts=attempts+1 WHERE id=$1",[item.id]);
      return;
    }
  }
  const order=await ensureRestingOrder(context);
  if(!order||!restingOrderIsSubmittable(order)){
    await query("UPDATE outbox SET status='sent',sent_at=now(),payload=payload||$1::jsonb WHERE id=$2",[JSON.stringify({skipped:order?`replacement already ${order.state}`:"replacement row could not be created"}),item.id]);
    return;
  }
  // Only now that the replacement exists can the audit trail point at it.
  if(previous)await query("UPDATE orders SET replaced_by=$1,updated_at=now() WHERE id=$2",[order.id,context.oldOrderId]);
  await submitOrder(item,order.id,context.plan,"REPLACEMENT");
}

/**
 * Withdraw a working order the model no longer wants: bias gone, structure
 * broken, or no candidate left inside the entry band. CANCELLED_REPLACED
 * covers this as well as an actual replacement — both are the model
 * withdrawing its own order, both belong on the quiet notification topic, and
 * the reason text carries which one it was. What matters is that neither is
 * CANCELLED_EXTERNALLY, which means the platform did something we did not ask for.
 */
async function handleCancelWorking(item:Record<string,unknown>){
  const payload=item.payload as {orderId:string;assetId:string;reason?:string};
  const order=(await query<{state:string;platform_order_id:string|null}>("SELECT state,platform_order_id FROM orders WHERE id=$1",[payload.orderId])).rows[0];
  if(!order||order.state!=="PENDING_ENTRY"||!order.platform_order_id){
    await query("UPDATE outbox SET status='sent',sent_at=now(),payload=payload||$1::jsonb WHERE id=$2",[JSON.stringify({skipped:!order?"the order no longer exists":order.state!=="PENDING_ENTRY"?`the order is already ${order.state}`:"the order has no platform order ID"}),item.id]);
    return;
  }
  try{
    const cancelled=await adapter.cancelEntry(order.platform_order_id);
    if(!cancelled.cancelled){
      if(cancelled.state!=="PENDING_ENTRY")await setState(payload.orderId,"PENDING_ENTRY",cancelled.state,"withdrawal found the order already settled on the platform",cancelled.raw);
      else await recordBusinessError({service:"variational-agent",assetId:payload.assetId,code:"RESTING_CANCEL_FAILED",message:"Variational still reports the working entry as pending after a cancellation attempt",blocksTrading:false,context:{orderId:payload.orderId}});
      await query("UPDATE outbox SET status='failed',attempts=attempts+1 WHERE id=$1",[item.id]);
      return;
    }
    await setState(payload.orderId,"PENDING_ENTRY","CANCELLED_REPLACED",payload.reason??"withdrawn by the resting model",cancelled.raw);
    await query("UPDATE outbox SET status='sent',sent_at=now() WHERE id=$1",[item.id]);
  }catch(error){
    await recordBusinessError({service:"variational-agent",assetId:payload.assetId,code:"RESTING_CANCEL_FAILED",message:error instanceof Error?error.message:String(error),blocksTrading:false,context:{orderId:payload.orderId}});
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
  if(valid)await backfillReversalDetails();
  const reconciled=valid&&(Boolean(previousSession.reconciled)||!reconciliationError);
  await query("UPDATE app_state SET value=$1,updated_at=now() WHERE key='variational_session'",[JSON.stringify({loggedIn:valid,discoveryComplete,reconciled})]);
  const item=await claimWork();
  if(item){
    const submitReady=valid&&reconciled&&config.LIVE_TRADING_ENABLED;
    const submitBlocker=!valid?"VARIATIONAL_SESSION_INVALID":!reconciled?"STARTUP_RECONCILIATION_INCOMPLETE":"LIVE_TRADING_DISABLED";
    if(item.topic==="order.submit"){
      if(submitReady)await handleOrder(item);
      else await rejectWithoutSubmission(item,submitBlocker);
    }else if(item.topic==="order.place_resting"){
      if(submitReady)await handlePlaceResting(item);
      else await query("UPDATE outbox SET status='sent',sent_at=now(),payload=payload||$1::jsonb WHERE id=$2",[JSON.stringify({rejectedWithoutSubmission:true,reason:submitBlocker}),item.id]);
    }else if(item.topic==="order.cancel_replace"){
      if(submitReady)await handleCancelReplace(item);
      else await query("UPDATE outbox SET status='sent',sent_at=now(),payload=payload||$1::jsonb WHERE id=$2",[JSON.stringify({rejectedWithoutSubmission:true,reason:submitBlocker}),item.id]);
    // Withdrawing and closing are reductions, so they follow the same rule as
    // global_pause's cancelManagedPending: gated on the session, not on
    // LIVE_TRADING_ENABLED, which exists to stop new exposure.
    }else if(item.topic==="order.cancel_working"){
      if(valid&&reconciled)await handleCancelWorking(item);
      else await query("UPDATE outbox SET status='pending',available_at=now()+interval '1 minute' WHERE id=$1",[item.id]);
    // Not gated on LIVE_TRADING_ENABLED: that flag stops new exposure, and so
    // does global_pause, which likewise only cancels pending entries and
    // leaves open positions on their TP/SL. Closing is the reduction, and the
    // signal side already refuses to queue one for a paused asset.
    }else if(item.topic==="order.close_opposite")await handleCloseOpposite(item,valid&&reconciled);
    else await handleControl(item);
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
    // A restart during a submission is ambiguous — something may exist on the
    // platform — so those messages are never silently replayed. Withdrawals
    // and closes are idempotent by order state, so they go back on the queue.
    await client.query("UPDATE outbox SET status='failed',attempts=attempts+1 WHERE topic IN ('order.submit','order.place_resting','order.cancel_replace') AND status='processing'");
    await client.query("UPDATE outbox SET status='pending' WHERE topic NOT IN ('order.submit','order.place_resting','order.cancel_replace') AND status='processing'");
  });
}

let shuttingDown=false;
async function shutdown(){if(shuttingDown)return;shuttingDown=true;await adapter.close?.();await pool.end();process.exit(0);}
process.on("SIGTERM",shutdown);
process.on("SIGINT",shutdown);
await query("UPDATE app_state SET value=value||'{\"loggedIn\":false,\"reconciled\":false}'::jsonb,updated_at=now() WHERE key='variational_session'");
await recoverInterruptedWork();
while(true){
  // Credential/config updates (e.g. LIVE_TRADING_ENABLED) only take effect on
  // a fresh process, since config is read once and cached at startup; exit
  // and let launchd/Docker's restart policy relaunch with the current .env.
  if(await claimRestartRequest("variational-agent")){await shutdown();}
  try{await tick();}catch(error){await recordHealth("variational-agent",false,error,true);}
  await sleep(fixedRules.variationalPollMs);
}
