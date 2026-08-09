import type { Direction, OrderPlan, OrderState } from "@huxtrade/shared-types";

export type PlatformEntryState="PENDING_ENTRY"|"FILLED_OPEN"|"CANCELLED_EXTERNALLY"|"UNKNOWN";
export interface SubmittedPrices{entryPrice:string;takeProfit:string;stopLoss:string;decimals:number;expectedRiskReward:number}
export interface PlatformEntry{
  id:string;
  state:PlatformEntryState;
  raw:Record<string,unknown>;
  quantity?:number;
  fillPrice?:number;
  openedAt?:string;
  takeProfitPresent?:boolean;
  stopLossPresent?:boolean;
  /** Prices actually accepted by the platform after precision quantization. */
  submittedPrices?:SubmittedPrices;
}
export interface PlatformProtection{id:string;raw:Record<string,unknown>}
export type AuthoritativePlatformState="PENDING_ENTRY"|"FILLED_OPEN"|"CLOSED_TP"|"CLOSED_SL"|"LIQUIDATED"|"CLOSED_REVERSED"|"CANCELLED_EXTERNALLY"|"UNKNOWN";
export interface PlatformPositionSnapshot{
  id:string;quantity:number;entryPrice:number;openedAt:string;takeProfit?:number;stopLoss?:number;
  unrealizedPnl?:number;realizedPnl?:number;closedAt?:string|null;raw:Record<string,unknown>;
}
export interface PlatformFillSnapshot{
  id:string;side:string;price:number;quantity:number;filledAt:string;fee?:number;realizedPnl?:number;raw:Record<string,unknown>;
}
export interface PlatformTrackedOrder extends Omit<PlatformEntry,"state">{
  state:AuthoritativePlatformState;
  position?:PlatformPositionSnapshot;
  fills?:PlatformFillSnapshot[];
}
export interface ProtectionAdapter{
  submitEntry(plan:Record<string,unknown>,options?:{skipProtection?:boolean}):Promise<PlatformEntry>;
  placeTakeProfit(entry:PlatformEntry,plan:OrderPlan):Promise<PlatformProtection>;
  placeStopLoss(entry:PlatformEntry,plan:OrderPlan):Promise<PlatformProtection>;
  orderState(entryId:string):Promise<PlatformEntryState>;
  cancelEntry(entryId:string):Promise<{cancelled:boolean;state:PlatformEntryState;raw:Record<string,unknown>}>;
  cancelOrder(orderId:string):Promise<void>;
  closeMarket(entryId:string):Promise<{closed:boolean;raw:Record<string,unknown>}>;
}

export type InitialProtectionResult={
  status:"PROTECTED"|"ENTRY_CANCELLED"|"EMERGENCY_CLOSED"|"MANUAL_INTERVENTION";
  entry:PlatformEntry;
  takeProfit?:PlatformProtection;
  stopLoss?:PlatformProtection;
  errors:string[];
  pauseAsset:boolean;
  notify:boolean;
};

const message=(error:unknown)=>error instanceof Error?error.message:String(error);

async function cleanupProtections(adapter:ProtectionAdapter,protections:PlatformProtection[],errors:string[]){
  const cleanup=await Promise.allSettled(protections.map((protection)=>adapter.cancelOrder(protection.id)));
  cleanup.forEach((result,index)=>{if(result.status==="rejected")errors.push(`protection cleanup ${protections[index]!.id}: ${message(result.reason)}`);});
}

/**
 * Implements spec 9.5: entry first, TP and SL immediately after, then
 * compensate. `skipProtection` covers the case where this asset already has
 * an active position in the same direction: Variational allows only one
 * auto-resizing TP/SL per instrument, so stacking a second pair on top would
 * be rejected — the existing pair already covers the larger position, so the
 * entry alone is the complete, correct submission (see the asset-conflict
 * resolution in variational-agent's handleOrder).
 */
export async function submitWithInitialProtection(adapter:ProtectionAdapter,plan:OrderPlan,options?:{skipProtection?:boolean}):Promise<InitialProtectionResult>{
  const entry=await adapter.submitEntry(plan as unknown as Record<string,unknown>,options);
  if(options?.skipProtection)return {status:"PROTECTED",entry,errors:[],pauseAsset:false,notify:false};
  const [tpResult,slResult]=await Promise.allSettled([
    adapter.placeTakeProfit(entry,plan),adapter.placeStopLoss(entry,plan)
  ]);
  const takeProfit=tpResult.status==="fulfilled"?tpResult.value:undefined;
  const stopLoss=slResult.status==="fulfilled"?slResult.value:undefined;
  if(takeProfit&&stopLoss)return {status:"PROTECTED",entry,takeProfit,stopLoss,errors:[],pauseAsset:false,notify:false};

  const errors=[
    ...(tpResult.status==="rejected"?[`TP creation: ${message(tpResult.reason)}`]:[]),
    ...(slResult.status==="rejected"?[`SL creation: ${message(slResult.reason)}`]:[])
  ];
  const created=[takeProfit,stopLoss].filter((value):value is PlatformProtection=>Boolean(value));

  let state:PlatformEntryState;
  try{state=await adapter.orderState(entry.id);}catch(error){errors.push(`entry state: ${message(error)}`);await cleanupProtections(adapter,created,errors);return {status:"MANUAL_INTERVENTION",entry,takeProfit,stopLoss,errors,pauseAsset:true,notify:true};}

  if(state==="PENDING_ENTRY"){
    try{
      const cancelled=await adapter.cancelEntry(entry.id);
      state=cancelled.state;
      if(cancelled.cancelled&&state==="CANCELLED_EXTERNALLY"){
        await cleanupProtections(adapter,created,errors);
        return errors.some((error)=>error.startsWith("protection cleanup"))
          ?{status:"MANUAL_INTERVENTION",entry,takeProfit,stopLoss,errors,pauseAsset:true,notify:true}
          :{status:"ENTRY_CANCELLED",entry,takeProfit,stopLoss,errors,pauseAsset:false,notify:true};
      }
    }catch(error){errors.push(`entry cancellation: ${message(error)}`);}
  }

  if(state==="FILLED_OPEN"){
    try{
      const closed=await adapter.closeMarket(entry.id);
      await cleanupProtections(adapter,created,errors);
      if(closed.closed&&!errors.some((error)=>error.startsWith("protection cleanup")))return {status:"EMERGENCY_CLOSED",entry,takeProfit,stopLoss,errors,pauseAsset:true,notify:true};
      if(!closed.closed)errors.push("emergency market close was not confirmed");
    }catch(error){errors.push(`emergency market close: ${message(error)}`);await cleanupProtections(adapter,created,errors);}
  }else{
    await cleanupProtections(adapter,created,errors);
    errors.push(`entry state after protection failure: ${state}`);
  }
  return {status:"MANUAL_INTERVENTION",entry,takeProfit,stopLoss,errors,pauseAsset:true,notify:true};
}

/**
 * Variational allows only one net position (no hedging) and only one
 * auto-resizing TP/SL pair per instrument — never per order. `existing` is
 * whatever other order is currently active (PENDING_ENTRY/FILLED_OPEN) on
 * the same asset, or undefined if none. The decision:
 *  - none active: submit normally, with fresh TP/SL.
 *  - same direction: the existing pair already auto-resizes to cover a
 *    larger position, so a second pair must NOT be created — Variational
 *    would reject it.
 *  - opposite direction, filled: must be market-closed first (which also
 *    cancels its TP/SL platform-side) before the new, opposite entry can go in.
 *  - opposite direction, still pending: must be cancelled first instead —
 *    there's no position yet to close.
 *  - opposite direction but somehow no platform id: a local data gap, not
 *    something safe to act on blindly — proceed as if nothing conflicts
 *    rather than guess at an ID-less cancel/close.
 */
export function decideAssetConflict(existing:{id:string;state:"PENDING_ENTRY"|"FILLED_OPEN";direction:Direction;platformOrderId:string|null}|undefined,direction:Direction){
  if(!existing)return {action:"NONE"as const};
  if(existing.direction===direction)return {action:"SHARE_EXISTING_PROTECTION"as const};
  if(!existing.platformOrderId)return {action:"NONE"as const};
  return existing.state==="FILLED_OPEN"
    ?{action:"CLOSE_EXISTING_POSITION"as const,orderId:existing.id,platformOrderId:existing.platformOrderId}
    :{action:"CANCEL_EXISTING_ENTRY"as const,orderId:existing.id,platformOrderId:existing.platformOrderId};
}

/**
 * Whether a queued reversal close should still be carried out. Under the
 * market-on-signal path the close was a step inside handleOrder, so its
 * preconditions were whatever handleOrder had just read. The resting model
 * queues the close as its own message — the bias reversed, so the position
 * leaves regardless of whether a re-entry exists — which means it can arrive
 * after the position already closed on its own stop, after a redelivery, or
 * after a restart. All three are the same question, and the order's current
 * state answers it: only a FILLED_OPEN order with a platform id is closable.
 *
 * Unreachable states SKIP rather than DEFER, so a close that can never happen
 * is never retried forever.
 */
export function decideReversalClose(input:{
  order?:{state:OrderState;platformOrderId:string|null}|null;
  sessionReady:boolean;
}):{action:"CLOSE";platformOrderId:string;reason:string}|{action:"SKIP";reason:string}|{action:"DEFER";reason:string}{
  if(!input.order)return {action:"SKIP",reason:"the order no longer exists"};
  if(input.order.state!=="FILLED_OPEN")return {action:"SKIP",reason:`the order is already ${input.order.state}; there is no open position to close`};
  if(!input.order.platformOrderId)return {action:"SKIP",reason:"the order has no platform order ID, so nothing can be closed by ID"};
  if(!input.sessionReady)return {action:"DEFER",reason:"Variational session is not ready; the reversal close is retried on the next poll"};
  return {action:"CLOSE",platformOrderId:input.order.platformOrderId,reason:"closed because the direction bias reversed"};
}

export function reconcileProtectionState(input:{localState:OrderState;platformState:OrderState;takeProfitPresent:boolean;stopLossPresent:boolean}){
  if(input.platformState==="FILLED_OPEN"&&(!input.takeProfitPresent||!input.stopLossPresent))return {
    action:"PAUSE_MANUAL_ONLY" as const,
    reason:`existing protection missing: ${!input.takeProfitPresent?"TP":""}${!input.takeProfitPresent&&!input.stopLossPresent?"+":""}${!input.stopLossPresent?"SL":""}`,
    closeMarket:false,recreateProtection:false
  };
  return input.localState===input.platformState
    ?{action:"NO_CHANGE" as const,reason:"platform and local states agree"}
    :{action:"SYNC_STATE" as const,reason:"Variational is authoritative",toState:input.platformState};
}

/**
 * `cause` distinguishes failures that look identical in the state machine but
 * mean different things to whoever gets the alert. A venue limit is refused,
 * unactionable and self-resolving, and the model retries it every scan; a
 * genuine submission failure is none of those. They share SUBMISSION_FAILED,
 * so the transition alone cannot tell them apart.
 */
export function notificationTopicsForTransition(from:OrderState,to:OrderState,cause?:"VENUE_LIMIT"|"REPLACEMENT"):string[]{
  if(to==="SUBMISSION_FAILED"&&cause==="VENUE_LIMIT")return ["notification.venue_limit_rejected"];
  // A replacement is one event, not two. Muting only the cancel half left the
  // re-placed order shouting order_created, so silencing the churn silenced
  // nothing: every hysteresis-driven move still produced a message.
  if(to==="PENDING_ENTRY"&&cause==="REPLACEMENT")return ["notification.resting_order_replaced"];
  if(to==="PENDING_ENTRY")return ["notification.order_created"];
  if(to==="FILLED_OPEN")return from==="SUBMITTING"?["notification.order_created","notification.entry_filled"]:["notification.entry_filled"];
  if(to==="CLOSED_TP")return ["notification.closed_tp"];
  if(to==="CLOSED_SL"||to==="LIQUIDATED")return ["notification.closed_sl_or_liquidated"];
  if(to==="CLOSED_REVERSED")return ["notification.closed_reversed"];
  // Its own topic, not order_failed: a replaced resting order is the model
  // working as designed. The preference row ships disabled — 15 assets
  // revalidating every 15 minutes would otherwise flood the chat.
  if(to==="CANCELLED_REPLACED")return ["notification.resting_order_replaced"];
  // Only a submission that never made it onto the venue is a failed order.
  // The other three are an order that DID reach the venue and whose local
  // bookkeeping has come adrift — ON had filled, scaled out for +7.16 and was
  // still protected when it reported "下单失败", which invites exactly the
  // wrong response from an operator reading it at a glance.
  if(to==="SUBMISSION_FAILED")return ["notification.order_failed"];
  if(["UNKNOWN","RECONCILIATION_REQUIRED","CANCELLED_EXTERNALLY"].includes(to))return ["notification.order_desynced"];
  return [];
}
