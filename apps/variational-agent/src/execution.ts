import type { OrderPlan, OrderState } from "@huxtrade/shared-types";

export type PlatformEntryState="PENDING_ENTRY"|"FILLED_OPEN"|"CANCELLED_EXTERNALLY"|"UNKNOWN";
export interface PlatformEntry{
  id:string;
  state:PlatformEntryState;
  raw:Record<string,unknown>;
  quantity?:number;
  fillPrice?:number;
  openedAt?:string;
  takeProfitPresent?:boolean;
  stopLossPresent?:boolean;
}
export interface PlatformProtection{id:string;raw:Record<string,unknown>}
export type AuthoritativePlatformState="PENDING_ENTRY"|"FILLED_OPEN"|"CLOSED_TP"|"CLOSED_SL"|"LIQUIDATED"|"CANCELLED_EXTERNALLY";
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
  submitEntry(plan:Record<string,unknown>):Promise<PlatformEntry>;
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

/** Implements spec 9.5: entry first, TP and SL immediately after, then compensate. */
export async function submitWithInitialProtection(adapter:ProtectionAdapter,plan:OrderPlan):Promise<InitialProtectionResult>{
  const entry=await adapter.submitEntry(plan as unknown as Record<string,unknown>);
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

export function notificationTopicsForTransition(from:OrderState,to:OrderState):string[]{
  if(to==="PENDING_ENTRY")return ["notification.order_created"];
  if(to==="FILLED_OPEN")return from==="SUBMITTING"?["notification.order_created","notification.entry_filled"]:["notification.entry_filled"];
  if(to==="CLOSED_TP")return ["notification.closed_tp"];
  if(to==="CLOSED_SL"||to==="LIQUIDATED")return ["notification.closed_sl_or_liquidated"];
  if(["SUBMISSION_FAILED","UNKNOWN","RECONCILIATION_REQUIRED","CANCELLED_EXTERNALLY"].includes(to))return ["notification.order_failed"];
  return [];
}
