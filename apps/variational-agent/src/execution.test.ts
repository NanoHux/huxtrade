import { describe,expect,it,vi } from "vitest";
import type { OrderPlan } from "@huxtrade/shared-types";
import { decideAssetConflict,decideReversalClose,notificationTopicsForTransition,reconcileProtectionState,submitWithInitialProtection,type PlatformEntry,type ProtectionAdapter } from "./execution.js";

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
  it("skips TP/SL entirely when stacking onto an existing same-direction position",async()=>{
    const a=adapter();
    const result=await submitWithInitialProtection(a,plan,{skipProtection:true});
    expect(result).toMatchObject({status:"PROTECTED",entry,errors:[],pauseAsset:false});
    expect(a.placeTakeProfit).not.toHaveBeenCalled();
    expect(a.placeStopLoss).not.toHaveBeenCalled();
    // The flag has to reach the adapter's own submitEntry call, not just skip
    // the read-back — that's the actual mechanism that keeps Variational from
    // seeing a second TP/SL request on an instrument that already has one.
    expect(a.submitEntry).toHaveBeenCalledWith(plan,{skipProtection:true});
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
  it("decides the asset-conflict action from what's already active on the instrument (no hedging, one TP/SL per instrument)",()=>{
    expect(decideAssetConflict(undefined,"LONG")).toEqual({action:"NONE"});
    expect(decideAssetConflict({id:"o1",state:"FILLED_OPEN",direction:"LONG",platformOrderId:"p1"},"LONG")).toEqual({action:"SHARE_EXISTING_PROTECTION"});
    expect(decideAssetConflict({id:"o1",state:"PENDING_ENTRY",direction:"LONG",platformOrderId:"p1"},"LONG")).toEqual({action:"SHARE_EXISTING_PROTECTION"});
    expect(decideAssetConflict({id:"o1",state:"FILLED_OPEN",direction:"LONG",platformOrderId:"p1"},"SHORT")).toEqual({action:"CLOSE_EXISTING_POSITION",orderId:"o1",platformOrderId:"p1"});
    expect(decideAssetConflict({id:"o1",state:"PENDING_ENTRY",direction:"LONG",platformOrderId:"p1"},"SHORT")).toEqual({action:"CANCEL_EXISTING_ENTRY",orderId:"o1",platformOrderId:"p1"});
    // A local data gap (no platform id yet) isn't something to act on blindly.
    expect(decideAssetConflict({id:"o1",state:"PENDING_ENTRY",direction:"LONG",platformOrderId:null},"SHORT")).toEqual({action:"NONE"});
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
    expect(notificationTopicsForTransition("FILLED_OPEN","CLOSED_REVERSED")).toEqual(["notification.closed_reversed"]);
    // Bookkeeping drift, not a failed submission: the order reached the venue
    // and may still hold a protected position, so it must not read as "下单失败".
    expect(notificationTopicsForTransition("UNKNOWN","RECONCILIATION_REQUIRED")).toEqual(["notification.order_desynced"]);
    expect(notificationTopicsForTransition("FILLED_OPEN","UNKNOWN")).toEqual(["notification.order_desynced"]);
    expect(notificationTopicsForTransition("CREATED_LOCAL","SUBMITTING")).toEqual([]);
    // A replaced resting order is the model working, not a failure.
    expect(notificationTopicsForTransition("PENDING_ENTRY","CANCELLED_REPLACED")).toEqual(["notification.resting_order_replaced"]);
    expect(notificationTopicsForTransition("PENDING_ENTRY","CANCELLED_EXTERNALLY")).toEqual(["notification.order_desynced"]);
    // A venue limit is refused, unactionable and self-resolving, and retried
    // every scan — it must be mutable without silencing real failures.
    expect(notificationTopicsForTransition("SUBMITTING","SUBMISSION_FAILED","VENUE_LIMIT")).toEqual(["notification.venue_limit_rejected"]);
    expect(notificationTopicsForTransition("SUBMITTING","SUBMISSION_FAILED")).toEqual(["notification.order_failed"]);
    // Both halves of a replacement land on the same muted topic, so a
    // hysteresis-driven move is one silent event rather than one silent and
    // one loud.
    expect(notificationTopicsForTransition("SUBMITTING","PENDING_ENTRY","REPLACEMENT")).toEqual(["notification.resting_order_replaced"]);
    expect(notificationTopicsForTransition("PENDING_ENTRY","CANCELLED_REPLACED")).toEqual(["notification.resting_order_replaced"]);
    // A genuinely new entry still announces itself.
    expect(notificationTopicsForTransition("SUBMITTING","PENDING_ENTRY")).toEqual(["notification.order_created"]);
    // The cause never leaks into unrelated transitions.
    expect(notificationTopicsForTransition("SUBMITTING","FILLED_OPEN","VENUE_LIMIT")).toEqual(["notification.order_created","notification.entry_filled"]);
  });

  describe("queued reversal closes",()=>{
    const open={state:"FILLED_OPEN" as const,platformOrderId:"rfq-1"};

    it("closes an open position once the session is ready",()=>{
      expect(decideReversalClose({order:open,sessionReady:true})).toMatchObject({action:"CLOSE",platformOrderId:"rfq-1"});
    });

    it("defers only while the close is still possible",()=>{
      expect(decideReversalClose({order:open,sessionReady:false})).toMatchObject({action:"DEFER"});
      // An unreachable close must never queue forever behind a session check.
      expect(decideReversalClose({order:{state:"CLOSED_SL",platformOrderId:"rfq-1"},sessionReady:false})).toMatchObject({action:"SKIP"});
      expect(decideReversalClose({order:null,sessionReady:false})).toMatchObject({action:"SKIP"});
    });

    it("skips whatever a redelivery or a restart already settled",()=>{
      // The stop got there first, or reconciliation did.
      expect(decideReversalClose({order:{state:"CLOSED_REVERSED",platformOrderId:"rfq-1"},sessionReady:true})).toMatchObject({action:"SKIP",reason:expect.stringContaining("CLOSED_REVERSED")});
      expect(decideReversalClose({order:{state:"CLOSED_SL",platformOrderId:"rfq-1"},sessionReady:true})).toMatchObject({action:"SKIP"});
      expect(decideReversalClose({order:{state:"PENDING_ENTRY",platformOrderId:"rfq-1"},sessionReady:true})).toMatchObject({action:"SKIP"});
      // No platform id means nothing can be closed by ID; reconciliation owns it.
      expect(decideReversalClose({order:{state:"FILLED_OPEN",platformOrderId:null},sessionReady:true})).toMatchObject({action:"SKIP",reason:expect.stringContaining("platform order ID")});
    });
  });
});
