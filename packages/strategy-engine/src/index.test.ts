import { describe, expect, it } from "vitest";
import { adjustMarginForPlatformMinimum, assertOrderTransition, candidateDirections, directionAllowed, eligibleHeatmapRegions, heatmapEntryState, makeOrderPlan, marginPauseTransition, riskGate } from "./index.js";

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
  it("rejects a fixed 1.5R fallback when a heatmap region blocks the path",()=>{
    const region={price:110,lowPrice:109,highPrice:111,intensity:10,rank:1,percentile:1};
    expect(()=>makeOrderPlan({symbol:"BTCUSDT",direction:"LONG",closedAt:"2026-08-04T00:00:00Z",entryPrice:100,swing:90,atr1h:2,regions:[region],marginUsdc:10,leverage:5})).toThrow(/blocked/);
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
