import { describe, expect, it } from "vitest";
import { fixedRules } from "@huxtrade/config";
import { adjustMarginForPlatformMinimum, assertOrderTransition, candidateDirections, chooseHeatmapTarget, directionAllowed, eligibleHeatmapRegions, heatmapEntryState, makeOrderPlan, marginPauseTransition, riskGate } from "./index.js";

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
  it("selects eligible regions and keeps the ratio inside both bounds", () => {
    const regions = eligibleHeatmapRegions(Array.from({ length: 10 }, (_, i) => ({ price: 110 + i * 10, lowPrice:109+i*10, highPrice:111+i*10, intensity: i + 1 })));
    // The swing sits 20 below the entry so the stop is wide enough that the
    // objective is reached on its own merits; with a nearer swing the same
    // target would pay 6.3x and be brought back in to the cap instead.
    const plan = makeOrderPlan({ symbol: "BTCUSDT", direction: "LONG", closedAt: "2026-08-04T00:00:00Z", entryPrice: 100, swing: 80, atr1h: 2, regions, marginUsdc: 10, leverage: 5 });
    expect(plan.expectedRiskReward).toBeGreaterThanOrEqual(fixedRules.minimumRiskReward);
    expect(plan.expectedRiskReward).toBeLessThanOrEqual(fixedRules.maximumRiskReward);
    expect(plan.notionalUsdc).toBe(50);
  });

  it("brings a target too far away in to the ratio cap instead of refusing it", () => {
    // Same regions, but a stop tight enough that the peak would pay 6.3x. 25
    // fills planned at 4.0x or better resolved 0 take-profits and 25 stops, so
    // the peak is not where this trade can collect — the trade is still worth
    // taking with the objective brought in to exactly the cap.
    const regions = eligibleHeatmapRegions(Array.from({ length: 10 }, (_, i) => ({ price: 110 + i * 10, lowPrice:109+i*10, highPrice:111+i*10, intensity: i + 1 })));
    const plan = makeOrderPlan({ symbol: "BTCUSDT", direction: "LONG", closedAt: "2026-08-04T00:00:00Z", entryPrice: 100, swing: 90, atr1h: 2, regions, marginUsdc: 10, leverage: 5 });
    expect(plan.expectedRiskReward).toBeCloseTo(fixedRules.maximumRiskReward, 9);
    // Risk is 11 (entry 100, stop 90 - 0.5 x 2), so the cap sits at 100 + 4x11.
    expect(plan.takeProfit).toBeCloseTo(144, 9);
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
  it("runs through a weak cluster on the way to the objective",()=>{
    // Risk 11 (entry 100, swing 90, atr 2). The peak at 130 is the objective;
    // the band at 110 carries only a fifth of its intensity, so the move is
    // assumed to consume it rather than end there.
    const plan=makeOrderPlan({symbol:"BTCUSDT",direction:"LONG",closedAt:"2026-08-04T00:00:00Z",entryPrice:100,swing:90,atr1h:2,regions:[region(110,20),region(130,100)],marginUsdc:10,leverage:5});
    expect(plan.heatmapTarget?.price).toBe(130);
    // 0.15 ATR in front of the zone.
    expect(plan.takeProfit).toBeCloseTo(130 - fixedRules.takeProfitAtrOffset * 2, 9);
  });
  it("stops at a cluster strong enough to be where the move ends",()=>{
    // Same shape, but the intervening band now carries 70% of the peak — over
    // the 60% bar — so it becomes the objective and the ratio is measured
    // against it instead.
    const plan=makeOrderPlan({symbol:"BTCUSDT",direction:"LONG",closedAt:"2026-08-04T00:00:00Z",entryPrice:100,swing:90,atr1h:2,regions:[region(120,70),region(130,100)],marginUsdc:10,leverage:5});
    expect(plan.heatmapTarget?.price).toBe(120);
    const target = 120 - fixedRules.takeProfitAtrOffset * 2;
    expect(plan.takeProfit).toBeCloseTo(target, 9);
    expect(plan.expectedRiskReward).toBeCloseTo((target - 100) / 11, 9);
  });
  it("refuses the trade when the demoted objective no longer pays the floor",()=>{
    // The real objective is 130, but a 70%-strength cluster at 112 gets in the
    // way first and only pays 1.06x the stop distance. The floor still refuses
    // outright: a target too NEAR cannot be fixed by moving it, unlike one
    // that is too far.
    expect(()=>makeOrderPlan({symbol:"BTCUSDT",direction:"LONG",closedAt:"2026-08-04T00:00:00Z",entryPrice:100,swing:90,atr1h:2,regions:[region(112,70),region(130,100)],marginUsdc:10,leverage:5}))
      .toThrow(/only pays 1.06x/);
  });
  it("takes the nearest qualifying obstacle, and never recurses past it",()=>{
    // Expressed against the threshold rather than a hardcoded intensity, so
    // this keeps asserting the rule rather than one tuning of it.
    const bar=100*fixedRules.falsePeakIntensityRatio;
    // Two clusters clear the bar; price meets 112 first, so that is where the
    // move is assumed to end. 115 is not then re-examined as an obstacle to
    // the NEW objective — exactly one hop, or the search never terminates.
    expect(chooseHeatmapTarget([region(112,bar+5),region(115,bar+15),region(130,100)],"LONG",100)?.price).toBe(112);
    // Exactly at the bar counts; a hair under is assumed to be run through.
    expect(chooseHeatmapTarget([region(112,bar),region(130,100)],"LONG",100)?.price).toBe(112);
    expect(chooseHeatmapTarget([region(112,bar-1),region(130,100)],"LONG",100)?.price).toBe(130);
  });
  it("refuses the trade when the structure cannot place a stop",()=>{
    expect(()=>makeOrderPlan({symbol:"BTCUSDT",direction:"LONG",closedAt:"2026-08-04T00:00:00Z",entryPrice:100,swing:105,atr1h:2,regions:[region(200,10)],marginUsdc:10,leverage:5}))
      .toThrow(/wrong side of the entry/);
  });
  it("aims at the ratio cap when there is no zone ahead at all",()=>{
    // Nothing overhead is what a runaway move looks like, not a reason to
    // refuse: the structural stop is already placed, so the trade runs to 4R.
    const plan=makeOrderPlan({symbol:"BTCUSDT",direction:"SHORT",closedAt:"2026-08-04T00:00:00Z",entryPrice:100,swing:105,atr1h:2,regions:[],marginUsdc:10,leverage:5});
    expect(plan.heatmapTarget).toBeUndefined();
    expect(plan.expectedRiskReward).toBeCloseTo(fixedRules.maximumRiskReward,9);
    // Risk is 6 (stop 105 + 0.5 x 2), so a SHORT's cap is 100 - 4x6.
    expect(plan.takeProfit).toBeCloseTo(76,9);
  });
  it("aims at the strongest zone ahead, not the nearest",()=>{
    expect(chooseHeatmapTarget([region(130,100),region(140,1)],"LONG",100)?.price).toBe(130);
    expect(chooseHeatmapTarget([region(95,100)],"LONG",100)).toBeUndefined();
    // SHORT mirrors: ahead means below.
    expect(chooseHeatmapTarget([region(80,100),region(90,20)],"SHORT",100)?.price).toBe(80);
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
