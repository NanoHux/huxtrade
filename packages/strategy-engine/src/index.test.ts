import { describe, expect, it } from "vitest";
import { adjustMarginForPlatformMinimum, assertOrderTransition, candidateDirections, chooseHeatmapTarget, directionAllowed, eligibleHeatmapRegions, findBlockingRegion, heatmapEntryState, makeOrderPlan, marginPauseTransition, riskGate } from "./index.js";

const region=(price:number,intensity:number)=>({price,lowPrice:price-1,highPrice:price+1,intensity,rank:1,percentile:1});

describe("strategy and risk rules", () => {
  it("enforces BTC direction permission", () => {
    expect(directionAllowed("BULL", "LONG")).toBe(true);
    expect(directionAllowed("BULL", "SHORT")).toBe(false);
    expect(directionAllowed("RANGE", "SHORT")).toBe(true);
  });
  it("evaluates both directions when CVD is absent or allowed to fail in N-of-M",()=>{
    expect(candidateDirections({cvdSelected:true,cvdPassed:true,cvdDirection:"SHORT"})).toEqual(["SHORT"]);
    expect(candidateDirections({cvdSelected:true,cvdPassed:false,cvdDirection:null})).toEqual(["LONG","SHORT"]);
    expect(candidateDirections({cvdSelected:false,cvdPassed:false})).toEqual(["LONG","SHORT"]);
  });
  it("selects eligible regions and preserves 1.5R", () => {
    const regions = eligibleHeatmapRegions(Array.from({ length: 10 }, (_, i) => ({ price: 110 + i * 10, lowPrice:109+i*10, highPrice:111+i*10, intensity: i + 1 })));
    const plan = makeOrderPlan({ symbol: "BTCUSDT", direction: "LONG", closedAt: "2026-08-04T00:00:00Z", entryPrice: 100, swing: 90, atr1h: 2, regions, marginUsdc: 10, leverage: 5 });
    expect(plan.expectedRiskReward).toBeGreaterThanOrEqual(1.5);
    expect(plan.notionalUsdc).toBe(50);
  });
  it("arms only inside a heatmap zone and confirms on a later 15m close",()=>{
    const region={price:100,lowPrice:99,highPrice:101,intensity:10,rank:1,percentile:1};
    expect(heatmapEntryState({region,price:98,closedAt:"2026-08-04T00:00:00Z",conditionsValid:true}).state).toBe("WAITING_ENTRY");
    expect(heatmapEntryState({region,price:100,closedAt:"2026-08-04T00:00:00Z",conditionsValid:true}).state).toBe("ARMED");
    expect(heatmapEntryState({region,price:100,closedAt:"2026-08-04T00:15:00Z",armedAt:"2026-08-04T00:00:00Z",conditionsValid:true}).state).toBe("CONFIRMED");
    expect(heatmapEntryState({region,price:102,closedAt:"2026-08-04T00:15:00Z",armedAt:"2026-08-04T00:00:00Z",conditionsValid:true}).state).toBe("INVALIDATED");
  });
  it("honours the persisted confirm_after boundary",()=>{
    const region={price:100,lowPrice:99,highPrice:101,intensity:10,rank:1,percentile:1};
    const armed={region,price:100,armedAt:"2026-08-04T00:00:00Z",confirmAfter:"2026-08-04T00:15:00Z",conditionsValid:true};
    expect(heatmapEntryState({...armed,closedAt:"2026-08-04T00:14:00Z"}).state).toBe("ARMED");
    expect(heatmapEntryState({...armed,closedAt:"2026-08-04T00:15:00Z"}).state).toBe("CONFIRMED");
  });
  it("rejects a fixed 1.5R fallback when a heatmap region blocks the path",()=>{
    expect(()=>makeOrderPlan({symbol:"BTCUSDT",direction:"LONG",closedAt:"2026-08-04T00:00:00Z",entryPrice:100,swing:90,atr1h:2,regions:[region(110,10)],marginUsdc:10,leverage:5})).toThrow(/blocks the path/);
  });
  it("applies the opposing-region check even when a valid heatmap target exists",()=>{
    // Spec 7.3 anchors the check on the fixed 1.5R level, not on the chosen TP.
    const regions=[region(108,1),region(130,100)];
    expect(findBlockingRegion(regions,"LONG",100,10)?.price).toBe(108);
    expect(()=>makeOrderPlan({symbol:"BTCUSDT",direction:"LONG",closedAt:"2026-08-04T00:00:00Z",entryPrice:100,swing:90,atr1h:0,regions,marginUsdc:10,leverage:5})).toThrow(/blocks the path/);
    expect(findBlockingRegion([region(130,100)],"LONG",100,10)).toBeUndefined();
    expect(findBlockingRegion([region(92,5)],"SHORT",100,10)?.price).toBe(92);
  });
  it("searches farther — never nearer — when the strongest region misses 1.5R",()=>{
    const nearerButStronger=region(105,50),primary=region(110,100),tooClose=region(112,1),valid=region(120,5);
    const chosen=chooseHeatmapTarget([nearerButStronger,primary,tooClose,valid],"LONG",100,90,0);
    expect(chosen?.price).toBe(120);
    // The strongest region is used directly whenever it already clears 1.5R.
    expect(chooseHeatmapTarget([region(130,100),region(140,1)],"LONG",100,90,0)?.price).toBe(130);
    expect(chooseHeatmapTarget([region(105,100)],"LONG",100,90,0)).toBeUndefined();
  });
  it("fails closed on risk gates and invalid state transitions", () => {
    expect(riskGate({ globalPaused:false, assetPaused:false, dataFresh:true, sessionValid:false, liveTrading:true, marginUsage:20, concurrentOrders:0, maxOrders:5 }).passed).toBe(false);
    expect(() => assertOrderTransition("CREATED_LOCAL", "FILLED_OPEN")).toThrow();
  });
  it("applies 80/75 margin hysteresis",()=>{
    expect(marginPauseTransition(false,80)).toBe("PAUSE");
    expect(marginPauseTransition(true,76)).toBe("HOLD");
    expect(marginPauseTransition(true,74.9)).toBe("RESUME");
  });
  it("raises margin only up to the fixed 20 USDC cap",()=>{
    expect(adjustMarginForPlatformMinimum(10,14,20,5)).toMatchObject({accepted:true,marginUsdc:14,notionalUsdc:70});
    expect(adjustMarginForPlatformMinimum(10,21,20,5)).toMatchObject({accepted:false});
  });
});
