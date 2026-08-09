import { describe, expect, it } from "vitest";
import type { Direction, HeatmapRegion, OrderPlan } from "@huxtrade/shared-types";
import { assetsInStructuralBackoff, biasDecision, breakevenStopPrice, breakevenThroughMarket, chooseEntryLevel, stopClearsSpread, classifyExitByPrice, directionAllowedAfterMove, haltedDirections, limitArmedAssets, makeRestingOrderPlan, neutralBias, resolveRestingEntry, restingEntryDefaults, revalidateWorkingOrder, scaleOutDecision, type BiasState, type EntryCandidate } from "./index.js";

const region=(low:number,high:number,percentile:number,intensity=percentile*100):HeatmapRegion=>
  ({price:(low+high)/2,lowPrice:low,highPrice:high,intensity,percentile,rank:1});

describe("bias arming",()=>{
  // 15m scans, biasPersistenceScans=4 -> a bias survives exactly one hour.
  const at=(minutes:number)=>new Date(Date.UTC(2026,7,7,0,0,0)+minutes*60_000).toISOString();
  const scan=(minutes:number,...passedDirections:Direction[])=>({closedAt:at(minutes),passedDirections});

  it("arms, refreshes, holds, then expires",()=>{
    const armed=biasDecision(neutralBias,scan(0,"LONG"));
    expect(armed).toMatchObject({action:"ARM",direction:"LONG",armedAt:at(0),armedUntil:at(60)});

    const refreshed=biasDecision(armed,scan(15,"LONG"));
    expect(refreshed).toMatchObject({action:"REFRESH",direction:"LONG",armedAt:at(0),armedUntil:at(75)});

    const held=biasDecision(refreshed,scan(30));
    expect(held).toMatchObject({action:"HOLD",direction:"LONG",armedUntil:at(75)});

    // armedUntil is exclusive: the scan that lands exactly on it is already past.
    expect(biasDecision(held,scan(74))).toMatchObject({action:"HOLD",direction:"LONG"});
    expect(biasDecision(held,scan(75))).toMatchObject({action:"EXPIRE",direction:null,armedUntil:null});
  });

  it("flips only once the reversal has been confirmed",()=>{
    // Superseded the old flip-on-sight rule: see the "reversal confirmation"
    // block for why one counter-signal is not a reversal.
    const armed=biasDecision(neutralBias,scan(0,"LONG"));
    const flipped=biasDecision(biasDecision(armed,scan(15,"SHORT")),scan(30,"SHORT"));
    expect(flipped).toMatchObject({action:"FLIP",direction:"SHORT",armedAt:at(30),armedUntil:at(90)});
    expect(flipped.reason).toContain("reversed the LONG bias to SHORT");
  });

  it("re-arms rather than flips once the old bias has already expired",()=>{
    const expired:BiasState={direction:"LONG",armedAt:at(0),armedUntil:at(60)};
    expect(biasDecision(expired,scan(90,"SHORT"))).toMatchObject({action:"ARM",direction:"SHORT",armedUntil:at(150)});
  });

  it("stays neutral, and treats a two-way scan as no evidence at all",()=>{
    expect(biasDecision(neutralBias,scan(0))).toMatchObject({action:"NONE",direction:null});
    expect(biasDecision(neutralBias,scan(0,"LONG","SHORT"))).toMatchObject({action:"NONE",direction:null});
    const armed=biasDecision(neutralBias,scan(0,"LONG"));
    expect(biasDecision(armed,scan(15,"LONG","SHORT"))).toMatchObject({action:"HOLD",direction:"LONG",armedUntil:at(60)});
  });
});

describe("entry level selection",()=>{
  // price 100, atr 2 -> LONG band [95, 99.4], offset 0.2, merge distance 0.7.
  const long={direction:"LONG" as const,price:100,atr1h:2,regions:[] as HeatmapRegion[]};

  it("takes the near edge of a liquidation zone plus the offset",()=>{
    const zone=region(96,97,0.9);
    expect(chooseEntryLevel({...long,regions:[zone]})).toMatchObject({level:97.2,score:0.9,sources:["HEATMAP"],region:zone});
  });

  it("takes a swing point when no zone qualifies",()=>{
    expect(chooseEntryLevel({...long,swing:96})).toMatchObject({level:96.2,score:0.55,sources:["SWING"],swing:96});
  });

  it("takes the EMA last, and never offsets it",()=>{
    expect(chooseEntryLevel({...long,ema:98})).toMatchObject({level:98,score:0.3,sources:["EMA"],ema:98});
    // A swing 1.8 away is beyond the 0.7 merge distance, so the two stay
    // separate candidates and the higher-scoring swing wins outright.
    expect(chooseEntryLevel({...long,ema:98,swing:96})).toMatchObject({level:96.2,score:0.55,sources:["SWING"]});
  });

  it("adds the scores of confluent candidates and keeps the zone's level",()=>{
    const zone=region(96,97,0.9);
    const chosen=chooseEntryLevel({...long,regions:[zone],swing:97.1,ema:97.4});
    expect(chosen).toMatchObject({level:97.2,swing:97.1,ema:97.4,region:zone});
    expect(chosen!.score).toBeCloseTo(0.9+0.55+0.3,9);
    expect([...chosen!.sources].sort()).toEqual(["EMA","HEATMAP","SWING"]);
  });

  it("prefers the deeper level when scores tie",()=>{
    const near=region(96.8,97,0.9),far=region(95.8,96,0.9);
    expect(chooseEntryLevel({...long,regions:[near,far]})!.level).toBe(96.2);
  });

  it("returns nothing when every candidate falls outside the band",()=>{
    // 99.5 -> level 99.7 is nearer than 0.3 ATR; 90 -> level 90.2 is farther
    // than 2.5 ATR; the EMA sits above price entirely.
    expect(chooseEntryLevel({...long,regions:[region(99,99.5,1)],swing:90,ema:101})).toBeNull();
    expect(chooseEntryLevel({...long,regions:[],swing:null,ema:null})).toBeNull();
    // A zone price is already inside offers nothing to wait for.
    expect(chooseEntryLevel({...long,regions:[region(99,101,1)]})).toBeNull();
    expect(chooseEntryLevel({...long,atr1h:0,swing:96})).toBeNull();
  });

  it("mirrors for SHORT",()=>{
    // price 100, atr 2 -> SHORT band [100.6, 105], entry below the zone's low edge.
    const short={direction:"SHORT" as const,price:100,atr1h:2,regions:[region(103,104,0.9)]};
    expect(chooseEntryLevel(short)).toMatchObject({level:102.8,score:0.9,sources:["HEATMAP"]});
    expect(chooseEntryLevel({...short,regions:[],swing:104})).toMatchObject({level:103.8,sources:["SWING"]});
    // Tie on score picks the deeper — for a SHORT, the higher — level.
    expect(chooseEntryLevel({...short,regions:[region(101,102,0.9),region(103.5,104,0.9)]})!.level).toBe(103.3);
  });
});

describe("resting order plans",()=>{
  const entryZone=region(96,97,0.9,50),targetZone=region(104.5,105.5,1,100);
  const base={symbol:"BTCUSDT",direction:"LONG" as const,closedAt:"2026-08-07T00:00:00Z",price:100,atr1h:2,marginUsdc:10,leverage:5};

  it("prices the stop and target off the resting level, not the market price",()=>{
    const candidate=chooseEntryLevel({direction:"LONG",price:100,atr1h:2,regions:[entryZone,targetZone],swing:96.5})!;
    expect(candidate.level).toBe(97.2);
    const plan=makeRestingOrderPlan({...base,candidate,regions:[entryZone,targetZone]});
    // Stop clears the deeper of {zone low 96, swing 96.5} by 0.5 ATR.
    expect(plan.stopLoss).toBeCloseTo(95,9);
    // Target is the far zone less the 0.15 ATR offset — measured from 97.2,
    // which is what makes the ratio real rather than aspirational.
    expect(plan.takeProfit).toBeCloseTo(104.7,9);
    expect(plan.expectedRiskReward).toBeCloseTo(7.5/2.2,9);
    expect(plan.entryKind).toBe("RESTING_LIMIT");
    expect(plan.entryProvenance).toMatchObject({sources:["HEATMAP","SWING"],level:97.2,referencePrice:100,bandNear:99.4,bandFar:95});
  });

  it("refuses a level that leans on no structure at all",()=>{
    // An EMA-only candidate gives the stop nothing to sit behind. There is no
    // margin-fraction fallback any more: a stop invented from position size
    // has no relationship to the chart, so its ratio measures nothing.
    const candidate:EntryCandidate={level:98,score:0.3,sources:["EMA"],ema:98};
    expect(()=>makeRestingOrderPlan({...base,candidate,regions:[targetZone]})).toThrow(/no price structure/);
  });

  it("keys on the level so a replacement at a moved level is a distinct order",()=>{
    // swing 2 below the level, so the stop is wide enough that the 105 zone
    // pays 2.5x rather than 6.25x and clears the ratio ceiling.
    const plan=(level:number)=>makeRestingOrderPlan({...base,candidate:{level,score:1,sources:["SWING"],swing:level-2},regions:[targetZone]}).idempotencyKey;
    expect(plan(97.2)).toBe(plan(97.2));
    expect(plan(97.2)).not.toBe(plan(97.9));
  });

  it("refuses the trade when the nearest real cluster does not pay the floor",()=>{
    // SHORT from 102.8, stop 104 (swing 103 + 0.5 ATR), risk 1.2. The 102.4
    // band carries the full intensity of the only zone ahead, so it IS the
    // objective — and at 102.1 after the offset it pays well under 1.4x.
    expect(()=>makeRestingOrderPlan({...base,direction:"SHORT",candidate:{level:102.8,score:1,sources:["SWING"],swing:103},regions:[region(102.3,102.5,1)]}))
      .toThrow(/only pays/);
  });

  it("aims past a weak cluster but stops at a strong one",()=>{
    const weak=region(96.5,97,0.5,20),strong=region(96.5,97,0.5,70),objective=region(94.5,95.5,1,100);
    const candidate:EntryCandidate={level:98.5,score:1,sources:["SWING"],swing:98.5};
    // SHORT from 98.5, stop 99.5, risk 1. The weak band is run through, so the
    // objective is the 95 cluster; the strong one becomes the objective itself.
    expect(makeRestingOrderPlan({...base,direction:"SHORT",candidate,regions:[weak,objective]}).heatmapTarget?.price).toBe(95);
    expect(makeRestingOrderPlan({...base,direction:"SHORT",candidate,regions:[strong,objective]}).heatmapTarget?.price).toBe(96.75);
  });

  it("mirrors the SHORT stop off the zone's high edge",()=>{
    const zone=region(103,104,0.9,50);
    const candidate=chooseEntryLevel({direction:"SHORT",price:100,atr1h:2,regions:[zone],swing:103.5})!;
    expect(candidate.level).toBe(102.8);
    const plan=makeRestingOrderPlan({...base,direction:"SHORT",candidate,regions:[zone,region(94.5,95.5,1,100)]});
    // Stop clears the higher of {zone high 104, swing 103.5} by 0.5 ATR.
    expect(plan.stopLoss).toBeCloseTo(105,9);
    expect(plan.takeProfit).toBeCloseTo(95.3,9);
  });
});

describe("working order revalidation",()=>{
  const armed=(direction:Direction):BiasState=>({direction,armedAt:"2026-08-07T00:00:00Z",armedUntil:"2026-08-07T01:00:00Z"});
  const planAt=(level:number,direction:Direction="LONG"):OrderPlan=>({
    idempotencyKey:`key-${level}`,symbol:"BTCUSDT",direction,entryPrice:level,
    stopLoss:direction==="LONG"?level-2:level+2,takeProfit:direction==="LONG"?level+3.2:level-3.2,
    expectedRiskReward:1.6,marginUsdc:10,leverage:5,notionalUsdc:50,entryKind:"RESTING_LIMIT"
  });
  const working={orderId:"order-1",direction:"LONG" as const,level:100,stopLoss:95};
  // atr 2 -> the replace hysteresis band is 0.5.
  const base={bias:armed("LONG"),closePrice:101,atr1h:2,tradable:true};

  it("cancels a working order and does nothing otherwise when the bias is gone",()=>{
    expect(revalidateWorkingOrder({...base,bias:neutralBias,workingOrder:working,newPlan:planAt(100)})).toMatchObject({action:"CANCEL"});
    expect(revalidateWorkingOrder({...base,bias:neutralBias,newPlan:planAt(100)})).toMatchObject({action:"NONE"});
  });

  it("cancels while the asset is not tradable and names why",()=>{
    const blocked={...base,tradable:false,blockedReasons:["ASSET_PAUSED","STALE_DATA"]};
    expect(revalidateWorkingOrder({...blocked,workingOrder:working,newPlan:planAt(100)})).toMatchObject({action:"CANCEL",reason:expect.stringContaining("ASSET_PAUSED, STALE_DATA")});
    expect(revalidateWorkingOrder({...blocked,newPlan:planAt(100)})).toMatchObject({action:"NONE"});
  });

  it("never stacks onto a same-direction position on the same asset",()=>{
    const held={orderId:"position-1",direction:"LONG" as const};
    expect(revalidateWorkingOrder({...base,newPlan:planAt(100),openPosition:held})).toMatchObject({action:"NONE",reason:expect.stringContaining("open LONG position")});
    expect(revalidateWorkingOrder({...base,workingOrder:working,newPlan:planAt(100),openPosition:held})).toMatchObject({action:"CANCEL"});
  });

  it("leaves an opposite position to its own stop and target",()=>{
    // Reversal closes booked +0.25R on average against plans built for 1.6R
    // and up, while the one trade allowed to reach its stop paid the full
    // -1R. The direction signal keeps its say over orders that have not
    // filled, where being wrong costs a cancel rather than a realised loss.
    const opposing={orderId:"position-2",direction:"SHORT" as const};
    expect(revalidateWorkingOrder({...base,newPlan:planAt(97.2),openPosition:opposing}))
      .toMatchObject({action:"NONE",reason:expect.stringContaining("left to its own stop and target")});
    expect(revalidateWorkingOrder({...base,openPosition:opposing})).toMatchObject({action:"NONE"});
    // An unfilled order on the new side still goes, since the signal now
    // contradicts the reason it was placed.
    expect(revalidateWorkingOrder({...base,workingOrder:working,newPlan:planAt(100),openPosition:opposing})).toMatchObject({action:"CANCEL"});
  });

  it("places when nothing is working, and does nothing without a candidate",()=>{
    expect(revalidateWorkingOrder({...base,newPlan:planAt(97.2)})).toMatchObject({action:"PLACE",plan:{entryPrice:97.2}});
    expect(revalidateWorkingOrder({...base})).toMatchObject({action:"NONE"});
  });

  it("replaces on a bias flip and cancels when the new side has no candidate yet",()=>{
    expect(revalidateWorkingOrder({...base,bias:armed("SHORT"),workingOrder:working,newPlan:planAt(103,"SHORT")})).toMatchObject({action:"REPLACE",plan:{direction:"SHORT"}});
    expect(revalidateWorkingOrder({...base,bias:armed("SHORT"),workingOrder:working})).toMatchObject({action:"CANCEL",reason:expect.stringContaining("flipped")});
  });

  it("replaces when the close breaks the structure the order leaned on",()=>{
    const broken={...base,closePrice:94.9,workingOrder:working};
    expect(revalidateWorkingOrder({...broken,newPlan:planAt(93)})).toMatchObject({action:"REPLACE",reason:expect.stringContaining("crossed the working order's stop")});
    expect(revalidateWorkingOrder(broken)).toMatchObject({action:"CANCEL",reason:expect.stringContaining("crossed the working order's stop")});
    // SHORT mirrors: the close runs up through the stop instead.
    const shortWorking={orderId:"order-2",direction:"SHORT" as const,level:100,stopLoss:105};
    expect(revalidateWorkingOrder({...base,bias:armed("SHORT"),closePrice:105.1,workingOrder:shortWorking,newPlan:planAt(107,"SHORT")})).toMatchObject({action:"REPLACE"});
  });

  it("holds inside the hysteresis band and replaces just outside it",()=>{
    expect(revalidateWorkingOrder({...base,workingOrder:working,newPlan:planAt(100.498)})).toMatchObject({action:"KEEP"});
    expect(revalidateWorkingOrder({...base,workingOrder:working,newPlan:planAt(100.502)})).toMatchObject({action:"REPLACE",plan:{entryPrice:100.502}});
    expect(revalidateWorkingOrder({...base,workingOrder:working,newPlan:planAt(99.502)})).toMatchObject({action:"KEEP"});
    // Same 0.498 drift, half the ATR: the band is relative, never absolute.
    expect(revalidateWorkingOrder({...base,workingOrder:working,newPlan:planAt(99.502),atr1h:1})).toMatchObject({action:"REPLACE"});
  });

  it("replaces when the working level no longer clears the ratio floor",()=>{
    const stale={...working,recomputedRiskReward:1.39};
    expect(revalidateWorkingOrder({...base,workingOrder:stale,newPlan:planAt(100.1)})).toMatchObject({action:"REPLACE",reason:expect.stringContaining("below 1.4")});
    expect(revalidateWorkingOrder({...base,workingOrder:{...working,recomputedRiskReward:1.4},newPlan:planAt(100.1)})).toMatchObject({action:"KEEP"});
    expect(revalidateWorkingOrder({...base,workingOrder:stale})).toMatchObject({action:"CANCEL",reason:expect.stringContaining("below 1.4")});
  });

  it("cancels a working order once no candidate remains in the band",()=>{
    expect(revalidateWorkingOrder({...base,workingOrder:working})).toMatchObject({action:"CANCEL",reason:"no entry candidate inside the entry band this scan"});
  });
});

describe("per-strategy settings",()=>{
  it("defaults to arming every tracked asset",()=>{
    expect(restingEntryDefaults.maxArmedAssets).toBe(15);
  });

  it("layers stored overrides over the defaults, key by key",()=>{
    expect(resolveRestingEntry({maxArmedAssets:8})).toMatchObject({maxArmedAssets:8,entryBandAtrMax:restingEntryDefaults.entryBandAtrMax});
    expect(resolveRestingEntry(null)).toEqual(restingEntryDefaults);
    expect(resolveRestingEntry({})).toEqual(restingEntryDefaults);
  });

  it("refuses persisted values that would silently disable the model",()=>{
    // An inverted or collapsed band admits nothing at all, which is
    // indistinguishable from a broken candidate search at the call site.
    expect(resolveRestingEntry({entryBandAtrMin:3,entryBandAtrMax:1})).toMatchObject({entryBandAtrMin:0.3,entryBandAtrMax:2.5});
    expect(resolveRestingEntry({maxArmedAssets:Number.NaN,swingScore:-1})).toEqual(restingEntryDefaults);
    expect(resolveRestingEntry({biasPersistenceScans:4.6,maxArmedAssets:8.2})).toMatchObject({biasPersistenceScans:5,maxArmedAssets:8});
  });

  it("actually changes the decisions the pure functions make",()=>{
    // A level 0.6 ATR from price is outside the default 0.3-2.5 band's near
    // edge only once the band is narrowed; widening the hysteresis turns a
    // REPLACE into a KEEP.
    const tight=resolveRestingEntry({entryBandAtrMin:1.0});
    const long={direction:"LONG" as const,price:100,atr1h:2,regions:[] as HeatmapRegion[],swing:98.5};
    expect(chooseEntryLevel(long)).toMatchObject({level:98.7});
    expect(chooseEntryLevel(long,tight)).toBeNull();

    const scan={closedAt:"2026-08-07T00:00:00Z",passedDirections:["LONG" as const]};
    expect(biasDecision(neutralBias,scan,resolveRestingEntry({biasPersistenceScans:1})).armedUntil).toBe("2026-08-07T00:15:00.000Z");

    const working={orderId:"order-1",direction:"LONG" as const,level:100,stopLoss:95};
    const moved={bias:{direction:"LONG" as const,armedAt:null,armedUntil:"2026-09-01T00:00:00Z"},closePrice:101,atr1h:2,tradable:true,workingOrder:working,
      newPlan:{idempotencyKey:"k",symbol:"BTCUSDT",direction:"LONG" as const,entryPrice:100.6,stopLoss:98,takeProfit:104,expectedRiskReward:1.6,marginUsdc:10,leverage:5,notionalUsdc:50}};
    expect(revalidateWorkingOrder(moved)).toMatchObject({action:"REPLACE"});
    expect(revalidateWorkingOrder(moved,resolveRestingEntry({replaceThresholdAtr:0.5}))).toMatchObject({action:"KEEP"});
  });
});

describe("armed asset cap",()=>{
  it("keeps the strongest signals and drops the rest deterministically",()=>{
    const armed=Array.from({length:10},(_,index)=>({assetId:`asset-${index}`,score:index}));
    expect(limitArmedAssets(armed).dropped).toHaveLength(0); // default 15 arms everything
    const {kept,dropped}=limitArmedAssets(armed,resolveRestingEntry({maxArmedAssets:8}).maxArmedAssets);
    expect(kept).toHaveLength(8);
    expect(kept[0]!.assetId).toBe("asset-9");
    expect(dropped.map((item)=>item.assetId)).toEqual(["asset-1","asset-0"]);
    expect(limitArmedAssets([{assetId:"b",score:1},{assetId:"a",score:1}],1).kept[0]!.assetId).toBe("a");
  });
});

describe("incumbency",()=>{
  // The live BTC shape: an incumbent cluster of one zone + a swing (score
  // ~1.45) against two merged zones 1.2 ATR deeper (score 1.91). The gap is
  // 0.46, so the order teleported 325 points every time the deeper pair
  // drifted across the entry band's far edge and back.
  const long={direction:"LONG" as const,price:100,atr1h:2,swing:97.1};
  const near=region(96.8,97,0.9),far=[region(95.6,95.8,0.96),region(95.3,95.5,0.95)];

  it("lets the stronger rival win outright when nothing is sitting there yet",()=>{
    const chosen=chooseEntryLevel({...long,regions:[near,...far]})!;
    expect(chosen.score).toBeCloseTo(1.91,2);
    expect(chosen.level).toBeCloseTo(96,2);
  });

  it("makes the incumbent structure defend its place",()=>{
    const chosen=chooseEntryLevel({...long,regions:[near,...far],incumbentLevel:97.2})!;
    expect(chosen.level).toBe(97.2);
    // 0.9 zone + 0.55 swing + 0.5 incumbency = 1.95, just past the rival's 1.91.
    expect(chosen.score).toBeCloseTo(1.95,9);
  });

  it("still yields to a decisively better rival",()=>{
    // The bonus is a tiebreaker, not a veto: a third merged zone wins anyway.
    const overwhelming=[...far,region(95.0,95.2,0.94)];
    expect(chooseEntryLevel({...long,regions:[near,...overwhelming],incumbentLevel:97.2})!.level).toBeCloseTo(96,2);
  });

  it("only protects the structure the order actually sits on",()=>{
    // An incumbent level nowhere near any cluster confers nothing on anyone.
    expect(chooseEntryLevel({...long,regions:[near,...far],incumbentLevel:90})!.level).toBeCloseTo(96,2);
  });

  it("is tunable, including effectively off",()=>{
    expect(chooseEntryLevel({...long,regions:[near,...far],incumbentLevel:97.2},resolveRestingEntry({incumbentScoreBonus:0.0001}))!.level).toBeCloseTo(96,2);
    expect(chooseEntryLevel({...long,regions:[near,...far],incumbentLevel:97.2},resolveRestingEntry({incumbentScoreBonus:3}))!.level).toBe(97.2);
  });
});

describe("reversal confirmation",()=>{
  const at=(minutes:number)=>new Date(Date.UTC(2026,7,7,0,0,0)+minutes*60_000).toISOString();
  const scan=(minutes:number,...passedDirections:Direction[])=>({closedAt:at(minutes),passedDirections});

  it("does not reverse on a single counter-signal",()=>{
    const armed=biasDecision(neutralBias,scan(0,"LONG"));
    const contested=biasDecision(armed,scan(15,"SHORT"));
    expect(contested).toMatchObject({action:"CONTEST",direction:"LONG",pendingFlipDirection:"SHORT",pendingFlipCount:1});
    // The old bias is held but deliberately not extended, so a persistent
    // contradiction lets it lapse instead of ruling forever.
    expect(contested.armedUntil).toBe(armed.armedUntil);
  });

  it("reverses once the counter-direction has asserted itself enough",()=>{
    const armed=biasDecision(neutralBias,scan(0,"LONG"));
    const contested=biasDecision(armed,scan(15,"SHORT"));
    const flipped=biasDecision(contested,scan(30,"SHORT"));
    expect(flipped).toMatchObject({action:"FLIP",direction:"SHORT",pendingFlipCount:0,pendingFlipDirection:null});
    expect(flipped.reason).toContain("after 2 counter-signals");
  });

  it("lets the original direction reassert itself and drop the argument",()=>{
    const armed=biasDecision(neutralBias,scan(0,"LONG"));
    const contested=biasDecision(armed,scan(15,"SHORT"));
    const reconfirmed=biasDecision(contested,scan(30,"LONG"));
    expect(reconfirmed).toMatchObject({action:"REFRESH",direction:"LONG",pendingFlipCount:0,pendingFlipDirection:null});
    // Having been reset, the next counter-signal starts the count over.
    expect(biasDecision(reconfirmed,scan(45,"SHORT"))).toMatchObject({action:"CONTEST",pendingFlipCount:1});
  });

  it("treats silent scans as neither confirming nor resetting",()=>{
    // Most scans pass nothing, so requiring adjacent bars would make a
    // genuine reversal practically unreachable.
    const armed=biasDecision(neutralBias,scan(0,"LONG"));
    const contested=biasDecision(armed,scan(15,"SHORT"));
    const quiet=biasDecision(contested,scan(30));
    expect(quiet).toMatchObject({action:"HOLD",direction:"LONG",pendingFlipCount:1});
    expect(biasDecision(quiet,scan(45,"SHORT"))).toMatchObject({action:"FLIP",direction:"SHORT"});
  });

  it("is tunable — 1 restores the old flip-on-sight behaviour",()=>{
    const armed=biasDecision(neutralBias,scan(0,"LONG"));
    expect(biasDecision(armed,scan(15,"SHORT"),resolveRestingEntry({flipConfirmationScans:1}))).toMatchObject({action:"FLIP",direction:"SHORT"});
    expect(biasDecision(armed,scan(15,"SHORT"),resolveRestingEntry({flipConfirmationScans:4}))).toMatchObject({action:"CONTEST",pendingFlipCount:1});
  });
});

describe("an open position defends itself",()=>{
  const at=(minutes:number)=>new Date(Date.UTC(2026,7,7,0,0,0)+minutes*60_000).toISOString();
  const scan=(minutes:number,...passedDirections:Direction[])=>({closedAt:at(minutes),passedDirections});
  const lapsed=neutralBias;

  it("needs the same confirmation once the bias has lapsed",()=>{
    // The hole this closes: a bias expires after 2h but positions outlive it,
    // so a single counter-scan used to ARM the opposite side from neutral —
    // which is not a flip, so the gate never saw it — and the position was
    // closed on one bar with no confirmation at all.
    const contested=biasDecision(lapsed,scan(0,"SHORT"),restingEntryDefaults,"LONG");
    expect(contested).toMatchObject({action:"CONTEST",pendingFlipDirection:"SHORT",pendingFlipCount:1});
    // Still neutral: the model may not open on this side, it merely may not close.
    expect(contested.direction).toBeNull();
    expect(contested.reason).toContain("open LONG position");
  });

  it("reverses once the counter-direction has argued it away",()=>{
    const once=biasDecision(lapsed,scan(0,"SHORT"),restingEntryDefaults,"LONG");
    const twice=biasDecision(once,scan(15,"SHORT"),restingEntryDefaults,"LONG");
    expect(twice).toMatchObject({action:"FLIP",direction:"SHORT",pendingFlipCount:0});
  });

  it("arms freely in the direction it is already holding",()=>{
    expect(biasDecision(lapsed,scan(0,"LONG"),restingEntryDefaults,"LONG")).toMatchObject({action:"ARM",direction:"LONG"});
  });

  it("changes nothing when no position is held",()=>{
    expect(biasDecision(lapsed,scan(0,"SHORT"),restingEntryDefaults,null)).toMatchObject({action:"ARM",direction:"SHORT"});
  });
});

describe("refusing to trade with a move that has already run",()=>{
  it("blocks a short once the asset is far enough up on the day",()=>{
    expect(directionAllowedAfterMove(38,"SHORT")).toBe(false);
    expect(directionAllowedAfterMove(15,"SHORT")).toBe(false);
    expect(directionAllowedAfterMove(14.9,"SHORT")).toBe(true);
  });

  it("mirrors it on the long side at the same threshold",()=>{
    expect(directionAllowedAfterMove(-38,"LONG")).toBe(false);
    expect(directionAllowedAfterMove(-15,"LONG")).toBe(false);
    expect(directionAllowedAfterMove(-14.9,"LONG")).toBe(true);
  });

  it("never blocks trading AGAINST the move, only with it",()=>{
    // Buying a crash and shorting a spike are what the model is for.
    expect(directionAllowedAfterMove(38,"LONG")).toBe(true);
    expect(directionAllowedAfterMove(-38,"SHORT")).toBe(true);
  });

  it("vetoes a measured condition, never ignorance",()=>{
    // A newly tracked asset has no 24h history yet; that must not read as calm.
    for(const direction of ["LONG","SHORT"] as const){
      expect(directionAllowedAfterMove(null,direction)).toBe(true);
      expect(directionAllowedAfterMove(undefined,direction)).toBe(true);
      expect(directionAllowedAfterMove(Number.NaN,direction)).toBe(true);
    }
  });

  it("is tunable, and 0 turns it off for both sides",()=>{
    expect(directionAllowedAfterMove(12,"SHORT",resolveRestingEntry({extremeMoveBlockPercent:10}))).toBe(false);
    expect(directionAllowedAfterMove(-12,"LONG",resolveRestingEntry({extremeMoveBlockPercent:10}))).toBe(false);
    expect(directionAllowedAfterMove(999,"SHORT",resolveRestingEntry({extremeMoveBlockPercent:0}))).toBe(true);
    expect(directionAllowedAfterMove(-999,"LONG",resolveRestingEntry({extremeMoveBlockPercent:0}))).toBe(true);
    expect(resolveRestingEntry({extremeMoveBlockPercent:0}).extremeMoveBlockPercent).toBe(0);
  });
});

describe("halting a direction after a run of losses",()=>{
  const at=(hours:number)=>new Date(Date.UTC(2026,7,9,0,0,0)+hours*3_600_000).toISOString();
  const loss=(direction:"LONG"|"SHORT",hours:number)=>({direction,closedAt:at(hours)});

  it("halts the direction on the third loss inside the window",()=>{
    const halts=haltedDirections([loss("SHORT",0),loss("SHORT",1),loss("SHORT",2)],at(3));
    // The halt runs from the qualifying loss, not from now, so a restart can
    // neither extend nor reset it.
    expect(halts).toEqual([{direction:"SHORT",until:at(14),count:3}]);
  });

  it("leaves the other direction free to trade",()=>{
    const halts=haltedDirections([loss("SHORT",0),loss("SHORT",1),loss("SHORT",2)],at(3));
    expect(halts.some((halt)=>halt.direction==="LONG")).toBe(false);
  });

  it("does not fire on two losses, or on three spread beyond the window",()=>{
    expect(haltedDirections([loss("SHORT",0),loss("SHORT",1)],at(2))).toEqual([]);
    // 0, 5 and 7 hours: no three of them sit inside a 6-hour window.
    expect(haltedDirections([loss("SHORT",0),loss("SHORT",5),loss("SHORT",7)],at(8))).toEqual([]);
  });

  it("counts a mixed streak per direction, not in total",()=>{
    // Three losses, but only two of them one way.
    expect(haltedDirections([loss("SHORT",0),loss("LONG",1),loss("SHORT",2)],at(3))).toEqual([]);
  });

  it("expires the halt once the configured hours have passed",()=>{
    const streak=[loss("SHORT",0),loss("SHORT",1),loss("SHORT",2)];
    expect(haltedDirections(streak,at(13.9))).toHaveLength(1);
    expect(haltedDirections(streak,at(14))).toEqual([]);
  });

  it("re-arms the halt from the newest qualifying window",()=>{
    // A fourth loss at hour 4 completes a fresher 2..4 window, so the halt
    // runs from there rather than from the original third loss.
    const halts=haltedDirections([loss("SHORT",0),loss("SHORT",1),loss("SHORT",2),loss("SHORT",4)],at(5));
    expect(halts[0]).toMatchObject({direction:"SHORT",until:at(16)});
  });

  it("can halt both directions independently",()=>{
    const halts=haltedDirections([
      loss("SHORT",0),loss("SHORT",1),loss("SHORT",2),
      loss("LONG",1),loss("LONG",2),loss("LONG",3)
    ],at(4));
    expect(halts.map((halt)=>halt.direction).sort()).toEqual(["LONG","SHORT"]);
  });

  it("is switched off by a zero count and ignores unusable timestamps",()=>{
    const streak=[loss("SHORT",0),loss("SHORT",1),loss("SHORT",2)];
    expect(haltedDirections(streak,at(3),resolveRestingEntry({lossStreakCount:0}))).toEqual([]);
    expect(resolveRestingEntry({lossStreakCount:0}).lossStreakCount).toBe(0);
    expect(haltedDirections([{direction:"SHORT",closedAt:"not-a-date"},...streak.slice(0,2)],at(3))).toEqual([]);
  });
});

describe("scaling out of an open position",()=>{
  // A 100/98 LONG: one stop-width is 2.0, which is 2% of price, so the
  // minimum-stop-width guard is satisfied and the trigger sits at 101.0.
  const long={direction:"LONG" as const,entryPrice:100,stopLoss:98,alreadyScaledOut:false};
  const short={direction:"SHORT" as const,entryPrice:100,stopLoss:102,alreadyScaledOut:false};

  const cases:Array<[string,Parameters<typeof scaleOutDecision>[0],"SCALE_OUT"|"NONE"]>=[
    ["LONG exactly at the trigger fires",{...long,markPrice:101},"SCALE_OUT"],
    ["LONG a tick under the trigger does not",{...long,markPrice:100.99},"NONE"],
    ["LONG well past the trigger fires",{...long,markPrice:104},"SCALE_OUT"],
    ["LONG in the red does not",{...long,markPrice:99},"NONE"],
    ["SHORT mirrors the LONG trigger",{...short,markPrice:99},"SCALE_OUT"],
    ["SHORT a tick under the trigger does not",{...short,markPrice:99.01},"NONE"],
    ["a position already scaled out never fires again",{...long,markPrice:104,alreadyScaledOut:true},"NONE"]
  ];
  for(const [name,input,expected] of cases)it(name,()=>expect(scaleOutDecision(input).action).toBe(expected));

  it("reports profit in stop-widths so the reason line is auditable",()=>{
    expect(scaleOutDecision({...long,markPrice:103}).profitR).toBeCloseTo(1.5,10);
    expect(scaleOutDecision({...short,markPrice:101}).profitR).toBeCloseTo(-0.5,10);
  });

  it("skips a stop too narrow for the spread the close would pay",()=>{
    // 0.3% stop, far under the 0.8% floor, and deep in profit: still refused.
    const narrow={direction:"LONG" as const,entryPrice:100,stopLoss:99.7,markPrice:101,alreadyScaledOut:false};
    expect(scaleOutDecision(narrow)).toMatchObject({action:"NONE"});
    expect(scaleOutDecision(narrow).reason).toMatch(/under 0\.8%/);
  });

  it("refuses to measure profit when the stop is on the wrong side of the entry",()=>{
    expect(scaleOutDecision({direction:"LONG",entryPrice:100,stopLoss:104,markPrice:110,alreadyScaledOut:false}).action).toBe("NONE");
  });

  it("is switched off by a zero trigger or a zero fraction",()=>{
    const off=resolveRestingEntry({scaleOutTriggerR:0});
    expect(scaleOutDecision({...long,markPrice:104},off).action).toBe("NONE");
    expect(scaleOutDecision({...long,markPrice:104},resolveRestingEntry({scaleOutFraction:0})).action).toBe("NONE");
  });

  it("honours a per-strategy trigger from the settings, not a hardcoded 0.5",()=>{
    const later=resolveRestingEntry({scaleOutTriggerR:1.5});
    expect(scaleOutDecision({...long,markPrice:102},later).action).toBe("NONE");
    expect(scaleOutDecision({...long,markPrice:103},later).action).toBe("SCALE_OUT");
  });
});

describe("the surviving half's breakeven stop",()=>{
  it("sits just beyond entry in the trade's favour, never exactly at it",()=>{
    // Exactly at the entry would still pay the spread to exit, turning a
    // scratch into a small loss.
    expect(breakevenStopPrice("LONG",100,98)).toBeGreaterThan(100);
    expect(breakevenStopPrice("SHORT",100,102)).toBeLessThan(100);
  });
  it("scales the offset with the stop width rather than with price",()=>{
    expect(breakevenStopPrice("LONG",100,98)).toBeCloseTo(100.1,10);
    expect(breakevenStopPrice("LONG",100,90)).toBeCloseTo(100.5,10);
  });
});

describe("settings validation for the scale-out",()=>{
  it("keeps an explicit zero instead of restoring the default",()=>{
    expect(resolveRestingEntry({scaleOutTriggerR:0}).scaleOutTriggerR).toBe(0);
  });
  it("clamps a fraction that would close the whole position",()=>{
    // Closing everything is a nearer take-profit, not a scale-out: it
    // abandons the target the plan was built around.
    expect(resolveRestingEntry({scaleOutFraction:1}).scaleOutFraction).toBe(0.9);
    expect(resolveRestingEntry({scaleOutFraction:5}).scaleOutFraction).toBe(0.9);
    expect(resolveRestingEntry({scaleOutFraction:0.25}).scaleOutFraction).toBe(0.25);
  });
  it("falls back to the default when a stored override is not a finite number",()=>{
    expect(resolveRestingEntry({scaleOutTriggerR:Number.NaN}).scaleOutTriggerR).toBe(restingEntryDefaults.scaleOutTriggerR);
    expect(resolveRestingEntry({scaleOutTriggerR:-1}).scaleOutTriggerR).toBe(restingEntryDefaults.scaleOutTriggerR);
  });
});

describe("a breakeven stop that price has already retraced through",()=>{
  // The scale-out takes seconds to fill; price can come back through
  // breakeven inside that window. A LONG stop at or above the market cannot
  // rest there, and neither can a SHORT stop at or below it.
  const cases:Array<[string,"LONG"|"SHORT",number,number,boolean]>=[
    ["LONG breakeven below the market can rest","LONG",100.1,101,false],
    ["LONG breakeven above the market cannot","LONG",100.1,100,true],
    ["LONG breakeven exactly at the market cannot","LONG",100,100,true],
    ["SHORT breakeven above the market can rest","SHORT",99.9,99,false],
    ["SHORT breakeven below the market cannot","SHORT",99.9,100,true],
    ["SHORT breakeven exactly at the market cannot","SHORT",100,100,true]
  ];
  for(const [name,direction,breakeven,mark,expected] of cases)
    it(name,()=>expect(breakevenThroughMarket(direction,breakeven,mark)).toBe(expected));

  it("treats an unusable mark as no evidence rather than as a retrace",()=>{
    // Guessing "retraced" on a missing price would close a healthy remainder.
    expect(breakevenThroughMarket("LONG",100.1,Number.NaN)).toBe(false);
    expect(breakevenThroughMarket("SHORT",99.9,Number.NaN)).toBe(false);
  });
});

describe("attributing an exit to a protection by price",()=>{
  // ZRO as it actually happened: SHORT 0.8383, stop 0.8453, target 0.8079.
  // The venue filled the stop at 0.8460 and the rfq lookup failed, so it was
  // booked as a manual reversal and never counted as a loss.
  const zro={direction:"SHORT" as const,entryPrice:0.8383,stopLoss:0.8453,takeProfit:0.8079};
  // SOL as it actually happened: an operator closing by hand, mid-trade.
  const sol={direction:"SHORT" as const,entryPrice:74.0856,stopLoss:75.5673,takeProfit:71.7148};

  it("recognises the ZRO stop-out the rfq lookup missed",()=>{
    expect(classifyExitByPrice({...zro,exitPrice:0.846})).toBe("CLOSED_SL");
  });

  it("still leaves the SOL manual close unattributed",()=>{
    // 74.80 is 0.52R short of the stop — a price-relative tolerance wide
    // enough for ZRO's 0.84% stop would have swallowed SOL's 2.0% one.
    expect(classifyExitByPrice({...sol,exitPrice:74.8015})).toBeNull();
  });

  const cases:Array<[string,Parameters<typeof classifyExitByPrice>[0],string|null]>=[
    ["a LONG filling at its target",{direction:"LONG",entryPrice:100,stopLoss:98,takeProfit:106,exitPrice:106},"CLOSED_TP"],
    ["a LONG target filled slightly early",{direction:"LONG",entryPrice:100,stopLoss:98,takeProfit:106,exitPrice:105.6},"CLOSED_TP"],
    ["a LONG stop filled past its trigger",{direction:"LONG",entryPrice:100,stopLoss:98,takeProfit:106,exitPrice:97.7},"CLOSED_SL"],
    ["a LONG closed in the middle",{direction:"LONG",entryPrice:100,stopLoss:98,takeProfit:106,exitPrice:102},null],
    ["a SHORT filling at its target",{direction:"SHORT",entryPrice:100,stopLoss:102,takeProfit:94,exitPrice:94},"CLOSED_TP"],
    ["a SHORT stop filled past its trigger",{direction:"SHORT",entryPrice:100,stopLoss:102,takeProfit:94,exitPrice:102.3},"CLOSED_SL"],
    ["a SHORT closed in the middle",{direction:"SHORT",entryPrice:100,stopLoss:102,takeProfit:94,exitPrice:98},null]
  ];
  for(const [name,input,expected] of cases)it(name,()=>expect(classifyExitByPrice(input)).toBe(expected));

  it("tests the breakeven stop instead once the scale-out has moved it",()=>{
    // The survivor's stop is at 100.1; an exit there is the breakeven stop
    // firing, and must read as a stop rather than as an unattributed close.
    const scaled={direction:"LONG" as const,entryPrice:100,stopLoss:98,takeProfit:106,breakevenStop:100.1};
    expect(classifyExitByPrice({...scaled,exitPrice:100.05})).toBe("CLOSED_SL");
    expect(classifyExitByPrice({...scaled,exitPrice:106})).toBe("CLOSED_TP");
    // Without the breakeven the same fill is nowhere near either level.
    expect(classifyExitByPrice({direction:"LONG",entryPrice:100,stopLoss:98,takeProfit:106,exitPrice:100.05})).toBeNull();
  });

  it("refuses to guess on a degenerate or unusable set of levels",()=>{
    expect(classifyExitByPrice({direction:"LONG",entryPrice:100,stopLoss:100,takeProfit:106,exitPrice:99})).toBeNull();
    expect(classifyExitByPrice({direction:"LONG",entryPrice:100,stopLoss:98,takeProfit:106,exitPrice:Number.NaN})).toBeNull();
  });
});

describe("refusing a stop too narrow to survive its own round trip",()=>{
  it("refuses PAXG and accepts BTC, which a percentage floor cannot do",()=>{
    // PAXG: 2.77 stop against a 2.56 spread — 1.08x.
    expect(stopClearsSpread(2.77,2.56)).toBe(false);
    // BTC: a 0.21% stop is ~134 in price against a spread near 1.
    expect(stopClearsSpread(134,1)).toBe(true);
    // Same two as a share of price: 0.064% vs 0.21%. Any flat floor that
    // catches the first throws away the second.
  });

  it("takes the multiple from settings and treats the boundary as passing",()=>{
    // Written against the configured multiple, not a literal, so retuning it
    // does not silently turn this into a test of nothing.
    const bar=restingEntryDefaults.minStopSpreadMultiple;
    expect(stopClearsSpread(bar,1)).toBe(true);
    expect(stopClearsSpread(bar-0.01,1)).toBe(false);
    expect(stopClearsSpread(4,1,resolveRestingEntry({minStopSpreadMultiple:4}))).toBe(true);
    expect(stopClearsSpread(3.9,1,resolveRestingEntry({minStopSpreadMultiple:4}))).toBe(false);
  });

  it("is switched off by a zero multiple",()=>{
    expect(stopClearsSpread(0.001,10,resolveRestingEntry({minStopSpreadMultiple:0}))).toBe(true);
    expect(resolveRestingEntry({minStopSpreadMultiple:0}).minStopSpreadMultiple).toBe(0);
  });

  it("does not block on an unusable spread, but does block a zero stop",()=>{
    // A missing quote is ignorance, and the venue's own minimums still apply.
    expect(stopClearsSpread(2.77,Number.NaN)).toBe(true);
    expect(stopClearsSpread(2.77,0)).toBe(true);
    expect(stopClearsSpread(0,1)).toBe(false);
  });
});

describe("resting an asset whose submissions keep being refused on their own structure",()=>{
  const at=(hours:number)=>new Date(Date.UTC(2026,7,9,0,0,0)+hours*3_600_000).toISOString();
  const refusal=(assetId:string,hours:number)=>({assetId,at:at(hours)});

  it("rests the asset on the third refusal, timed from that refusal",()=>{
    // PAXG rebuilt a stop narrower than its own spread every 15 minutes and
    // was refused every time, leaving a dead order row behind each attempt.
    const rested=assetsInStructuralBackoff([refusal("paxg",0),refusal("paxg",0.25),refusal("paxg",0.5)],at(1));
    expect(rested.get("paxg")).toEqual({until:at(6.5),count:3});
  });

  it("leaves an asset with fewer refusals alone",()=>{
    expect(assetsInStructuralBackoff([refusal("paxg",0),refusal("paxg",0.25)],at(1)).size).toBe(0);
  });

  it("counts each asset separately",()=>{
    const rested=assetsInStructuralBackoff([refusal("paxg",0),refusal("paxg",0.25),refusal("paxg",0.5),refusal("bnb",0.5)],at(1));
    expect([...rested.keys()]).toEqual(["paxg"]);
  });

  it("keeps resting while refusals continue, and releases once they stop",()=>{
    const run=[refusal("paxg",0),refusal("paxg",0.25),refusal("paxg",0.5)];
    expect(assetsInStructuralBackoff(run,at(6.4)).size).toBe(1);
    expect(assetsInStructuralBackoff(run,at(6.5)).size).toBe(0);
    // A fourth refusal an hour later pushes the clock out from there.
    expect(assetsInStructuralBackoff([...run,refusal("paxg",1.5)],at(7)).get("paxg")?.until).toBe(at(7.5));
  });

  it("is switched off by a zero limit and ignores unusable timestamps",()=>{
    const run=[refusal("paxg",0),refusal("paxg",0.25),refusal("paxg",0.5)];
    expect(assetsInStructuralBackoff(run,at(1),resolveRestingEntry({structuralRejectionLimit:0})).size).toBe(0);
    expect(resolveRestingEntry({structuralRejectionLimit:0}).structuralRejectionLimit).toBe(0);
    expect(assetsInStructuralBackoff([{assetId:"paxg",at:"not-a-date"},...run.slice(0,2)],at(1)).size).toBe(0);
  });
});
