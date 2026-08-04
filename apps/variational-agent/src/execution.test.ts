import { describe,expect,it,vi } from "vitest";
import type { OrderPlan } from "@huxtrade/shared-types";
import { notificationTopicsForTransition,reconcileProtectionState,submitWithInitialProtection,type PlatformEntry,type ProtectionAdapter } from "./execution.js";

const plan:OrderPlan={idempotencyKey:"key",symbol:"BTCUSDT",direction:"LONG",entryPrice:100,stopLoss:90,takeProfit:115,expectedRiskReward:1.5,marginUsdc:10,leverage:5,notionalUsdc:50};
const entry:PlatformEntry={id:"entry-1",state:"PENDING_ENTRY",raw:{}};
function adapter(overrides:Partial<ProtectionAdapter>={}):ProtectionAdapter{return {
  submitEntry:vi.fn(async()=>entry),
  placeTakeProfit:vi.fn(async()=>({id:"tp-1",raw:{}})),
  placeStopLoss:vi.fn(async()=>({id:"sl-1",raw:{}})),
  orderState:vi.fn(async()=>"PENDING_ENTRY" as const),
  cancelEntry:vi.fn(async()=>({cancelled:true,state:"CANCELLED_EXTERNALLY" as const,raw:{}})),
  cancelOrder:vi.fn(async()=>undefined),
  closeMarket:vi.fn(async()=>({closed:true,raw:{}})),
  ...overrides
};}

describe("Variational initial protection compensation",()=>{
  it("submits the entry then requires both TP and SL",async()=>{
    const result=await submitWithInitialProtection(adapter(),plan);
    expect(result.status).toBe("PROTECTED");
    expect(result.pauseAsset).toBe(false);
  });
  it("cancels an unfilled entry when either initial protection fails",async()=>{
    const a=adapter({placeStopLoss:vi.fn(async()=>{throw new Error("SL rejected");})});
    const result=await submitWithInitialProtection(a,plan);
    expect(result.status).toBe("ENTRY_CANCELLED");
    expect(a.cancelEntry).toHaveBeenCalledWith("entry-1");
    expect(a.closeMarket).not.toHaveBeenCalled();
    expect(a.cancelOrder).toHaveBeenCalledWith("tp-1");
  });
  it("market-closes a filled entry, pauses the asset and notifies",async()=>{
    const a=adapter({placeTakeProfit:vi.fn(async()=>{throw new Error("TP rejected");}),orderState:vi.fn(async()=>"FILLED_OPEN" as const)});
    const result=await submitWithInitialProtection(a,plan);
    expect(result).toMatchObject({status:"EMERGENCY_CLOSED",pauseAsset:true,notify:true});
    expect(a.closeMarket).toHaveBeenCalledWith("entry-1");
    expect(a.cancelEntry).not.toHaveBeenCalled();
  });
  it("fails closed when emergency closure cannot be confirmed",async()=>{
    const a=adapter({placeTakeProfit:vi.fn(async()=>{throw new Error("TP rejected");}),orderState:vi.fn(async()=>"FILLED_OPEN" as const),closeMarket:vi.fn(async()=>({closed:false,raw:{}}))});
    const result=await submitWithInitialProtection(a,plan);
    expect(result).toMatchObject({status:"MANUAL_INTERVENTION",pauseAsset:true,notify:true});
  });
  it("never rebuilds or closes when an existing position loses protection",()=>{
    expect(reconcileProtectionState({localState:"FILLED_OPEN",platformState:"FILLED_OPEN",takeProfitPresent:false,stopLossPresent:true})).toEqual({
      action:"PAUSE_MANUAL_ONLY",reason:"existing protection missing: TP",closeMarket:false,recreateProtection:false
    });
  });
  it("maps authoritative fills and closures to notification topics",()=>{
    expect(notificationTopicsForTransition("SUBMITTING","PENDING_ENTRY")).toEqual(["notification.order_created"]);
    expect(notificationTopicsForTransition("SUBMITTING","FILLED_OPEN")).toEqual(["notification.order_created","notification.entry_filled"]);
    expect(notificationTopicsForTransition("FILLED_OPEN","CLOSED_TP")).toEqual(["notification.closed_tp"]);
    expect(notificationTopicsForTransition("FILLED_OPEN","LIQUIDATED")).toEqual(["notification.closed_sl_or_liquidated"]);
    expect(notificationTopicsForTransition("UNKNOWN","RECONCILIATION_REQUIRED")).toEqual(["notification.order_failed"]);
    expect(notificationTopicsForTransition("CREATED_LOCAL","SUBMITTING")).toEqual([]);
  });
});
