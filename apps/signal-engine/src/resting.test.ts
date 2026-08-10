import { describe, expect, it } from "vitest";
import { fixedRules } from "@huxtrade/config";
import type { Candle } from "@huxtrade/indicators";
import { neutralBias, resolveRestingEntry, type BiasState } from "@huxtrade/strategy-engine";
import type { ConditionResult, Direction, HeatmapRegion } from "@huxtrade/shared-types";
import { decideRestingScan, recomputeWorkingRiskReward, restingOutboxMessage, structureFrom, type RestingAssetInput } from "./resting.js";

// A gently declining series: enough range for a usable ATR and a swing low
// inside the entry band, with the last close at 100.
const candles:Candle[]=Array.from({length:80},(_,index)=>{
  const base=110-index*0.125;
  return {openTime:index*3_600_000,open:base,high:base+1.2,low:base-1.2,close:base,volume:100};
});

// With the margin-fraction fallback gone, every plan needs a real objective:
// a strong zone ahead of the entry that pays the ratio floor. Far enough not
// to be an entry candidate itself, and past the floor multiple so it is not a
// blocking region either.
const targetZone:HeatmapRegion={price:105,lowPrice:104.5,highPrice:105.5,intensity:9e8,percentile:1,rank:1};
const settings=resolveRestingEntry(null);
const condition=(type:ConditionResult["type"],passed:boolean,zScore:number):ConditionResult=>({type,passed,zScore,reason:"test"});

function asset(overrides:Partial<RestingAssetInput>={}):RestingAssetInput{
  return {
    assetId:"asset-1",code:"BTCUSDT",closedAt:"2026-08-07T00:00:00.000Z",closePrice:100,
    previousBias:neutralBias,passedDirections:["LONG"],
    conditions:[condition("OI",true,2),condition("CVD",true,1.5)],
    regions:[targetZone],candles,workingOrder:null,openPosition:null,
    structurallyTradable:true,structuralBlockers:[],emitAllowed:true,emitBlockers:[],
    ...overrides
  };
}
const options={settings,mode:"live" as const,marginUsdc:10,leverage:5};

describe("scan structure",()=>{
  it("derives ATR, EMA and the swing from the candles the scan already has",()=>{
    const structure=structureFrom(candles,"LONG")!;
    expect(structure.atr1h).toBeGreaterThan(0);
    expect(structure.ema).toBeGreaterThan(0);
    expect(structure.swing).not.toBeNull();
  });

  it("returns nothing rather than a half-warmed indicator",()=>{
    expect(structureFrom(candles.slice(0,5),"LONG")).toBeNull();
    expect(structureFrom([],"LONG")).toBeNull();
  });
});

describe("resting scan decisions",()=>{
  it("arms and places, recording the bias on the decision",()=>{
    const [decision]=decideRestingScan([asset()],options);
    expect(decision).toMatchObject({action:"PLACE",mode:"live"});
    expect(decision!.bias.direction).toBe("LONG");
    expect(decision!.plan!.entryPrice).toBeLessThan(100);
    expect(decision!.strength).toBeCloseTo(3.5,9);
  });

  it("records a shadow row when the asset could not have emitted",()=>{
    // Not cleared for live trading yet: spec 6-3 rolls out 2-3 assets at a
    // time, and the rest still have to produce a comparable ledger.
    const [decision]=decideRestingScan([asset({emitAllowed:false,emitBlockers:["LIVE_TRADING_DISABLED"]})],options);
    expect(decision).toMatchObject({action:"PLACE",mode:"shadow"});
    expect(restingOutboxMessage(decision!,{strategyId:"s",signalId:null})).toBeNull();
  });

  it("emits nothing at all in shadow mode",()=>{
    const [decision]=decideRestingScan([asset()],{...options,mode:"shadow"});
    expect(decision!.action).toBe("PLACE");
    expect(decision!.mode).toBe("shadow");
    expect(restingOutboxMessage(decision!,{strategyId:"s",signalId:null})).toBeNull();
  });

  it("keeps deciding for a structurally blocked asset but never emits", ()=>{
    const [decision]=decideRestingScan([asset({structurallyTradable:false,structuralBlockers:["ASSET_PAUSED"]})],options);
    expect(decision).toMatchObject({action:"NONE"});
    expect(decision!.reason).toContain("ASSET_PAUSED");
  });

  it("caps how many assets can be armed at once, strongest first",()=>{
    const assets=Array.from({length:4},(_,index)=>asset({
      assetId:`asset-${index}`,code:`SYM${index}USDT`,
      conditions:[condition("OI",true,index+1)]
    }));
    const decisions=decideRestingScan(assets,{...options,settings:resolveRestingEntry({maxArmedAssets:2})});
    const placed=decisions.filter((decision)=>decision.action==="PLACE").map((decision)=>decision.assetId);
    expect(placed).toEqual(["asset-2","asset-3"]);
    // The suppressed assets keep their armed bias — the cap withholds action,
    // it does not un-arm them, so they resume the moment a stronger one leaves.
    const suppressed=decisions.find((decision)=>decision.assetId==="asset-0")!;
    expect(suppressed.bias.direction).toBe("LONG");
    expect(suppressed.action).toBe("NONE");
    expect(suppressed.biasReason).toContain("arming cap");
  });

  it("withdraws a working order once the bias expires",()=>{
    const expired:BiasState={direction:"LONG",armedAt:"2026-08-06T00:00:00.000Z",armedUntil:"2026-08-06T01:00:00.000Z"};
    const [decision]=decideRestingScan([asset({
      passedDirections:[],previousBias:expired,
      workingOrder:{orderId:"order-1",direction:"LONG",level:98,stopLoss:95}
    })],options);
    expect(decision).toMatchObject({action:"CANCEL"});
    expect(restingOutboxMessage(decision!,{strategyId:"s",signalId:null})).toMatchObject({topic:"order.cancel_working",payload:{orderId:"order-1"}});
  });

  it("never closes a filled position, however confirmed the reversal",()=>{
    const held={orderId:"order-9",direction:"SHORT" as const};
    const single=decideRestingScan([asset({openPosition:held})],options)[0]!;
    const confirmed=decideRestingScan([asset({openPosition:held,
      previousBias:{direction:null,armedAt:null,armedUntil:null,pendingFlipDirection:"LONG",pendingFlipCount:9}})],options)[0]!;
    for(const decision of [single,confirmed]){
      expect(decision.action).toBe("NONE");
      expect(restingOutboxMessage(decision,{strategyId:"s",signalId:null})).toBeNull();
    }
  });

  it("replaces through cancel_replace, carrying both the old order and the new plan",()=>{
    const [decision]=decideRestingScan([asset({
      workingOrder:{orderId:"order-1",direction:"LONG",level:80,stopLoss:75}
    })],options);
    expect(decision!.action).toBe("REPLACE");
    const message=restingOutboxMessage(decision!,{strategyId:"strategy-1",signalId:"signal-1"});
    expect(message).toMatchObject({topic:"order.cancel_replace",payload:{oldOrderId:"order-1",strategyId:"strategy-1",signalId:"signal-1"}});
    expect((message!.payload as {plan:{entryPrice:number}}).plan.entryPrice).toBeGreaterThan(80);
  });

  it("does nothing when no candidate lands inside the entry band",()=>{
    // A hard vertical rally: every swing low and the EMA are far below the
    // 2.5 ATR band, and the only zone is further below still.
    const far:HeatmapRegion[]=[{price:10,lowPrice:9,highPrice:11,intensity:5,percentile:1,rank:1}];
    const rally:Candle[]=Array.from({length:80},(_,index)=>{
      const base=20+index;
      return {openTime:index*3_600_000,open:base,high:base+1.2,low:base-1.2,close:base,volume:1};
    });
    const [decision]=decideRestingScan([asset({regions:far,candles:rally})],options);
    expect(decision!.action).toBe("NONE");
    expect(restingOutboxMessage(decision!,{strategyId:"s",signalId:null})).toBeNull();
  });

  it("treats a two-way scan as no evidence and stays neutral",()=>{
    const directions:Direction[]=["LONG","SHORT"];
    const [decision]=decideRestingScan([asset({passedDirections:directions})],options);
    expect(decision!.bias.direction).toBeNull();
    expect(decision!.action).toBe("NONE");
  });
});

describe("shadow provenance",()=>{
  it("records why a decision stayed shadow, so the comparison is explainable",()=>{
    const blocked=asset({emitAllowed:false,emitBlockers:["LIVE_TRADING_DISABLED","VARIATIONAL_SESSION_INVALID"]});
    expect(decideRestingScan([blocked],options)[0]!.emitBlockers).toEqual(["LIVE_TRADING_DISABLED","VARIATIONAL_SESSION_INVALID"]);
    expect(decideRestingScan([blocked],{...options,mode:"shadow"})[0]!.emitBlockers[0]).toBe("STRATEGY_EXECUTION_MODE_SHADOW");
    expect(decideRestingScan([asset()],options)[0]!.emitBlockers).toEqual([]);
  });
});

describe("re-pricing a working order",()=>{
  const working={orderId:"order-1",direction:"SHORT" as const,level:0.0742,stopLoss:0.0748};
  const base={working,symbol:"ARCUSDT",closedAt:"2026-08-08T11:30:00.000Z",atr1h:0.001,
    marginUsdc:100,leverage:5,settings};

  it("reports an un-rebuildable level as unknown rather than as worthless",()=>{
    // No structure to anchor a stop behind. Returning 0 made the caller read
    // it as "below the floor" and replace the order every single scan,
    // bypassing the hysteresis band entirely — 30 needless replaces.
    expect(recomputeWorkingRiskReward({...base,swing:null,regions:[targetZone]})).toBeUndefined();
  });

  it("prices a level with no zone ahead, rather than reporting it as unknown",()=>{
    // Nothing ahead used to make the plan un-buildable, which read downstream
    // as "below the floor" and replaced the order every scan. The target is a
    // fixed multiple of the stop now, so an empty heatmap prices normally.
    expect(recomputeWorkingRiskReward({...base,swing:0.0748,regions:[]})).toBeCloseTo(settings.takeProfitRiskReward,9);
  });

  it("returns the real ratio when the level can still be priced",()=>{
    const objective:HeatmapRegion={price:0.070,lowPrice:0.0699,highPrice:0.0701,intensity:9e8,percentile:1,rank:1};
    const ratio=recomputeWorkingRiskReward({...base,swing:0.0748,regions:[objective]});
    expect(ratio).toBeGreaterThan(1);
  });
});
