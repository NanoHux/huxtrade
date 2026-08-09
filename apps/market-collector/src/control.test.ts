import { describe,expect,it } from "vitest";
import { cvdBinsFromCandles,isRetryablePause,scanningPaused } from "./control.js";

describe("scanningPaused",()=>{
  it("stops collection during a manual global pause",()=>{
    expect(scanningPaused({paused:true},{autoPaused:false})).toBe(true);
  });

  it("stops collection during the automatic margin pause",()=>{
    expect(scanningPaused({paused:false},{autoPaused:true})).toBe(true);
  });

  it("allows collection only when both gates are open",()=>{
    expect(scanningPaused({paused:false},{autoPaused:false})).toBe(false);
  });
});

describe("isRetryablePause",()=>{
  it("retries transient data-fetch and prewarm failures",()=>{
    expect(isRetryablePause("DATA_ERROR: fetch failed")).toBe(true);
    expect(isRetryablePause("PREWARM_ERROR: fetch failed")).toBe(true);
  });

  it("never auto-retries a trading-state-risk or manual pause",()=>{
    expect(isRetryablePause("EXISTING_PROTECTION_MISSING")).toBe(false);
    expect(isRetryablePause("VARIATIONAL_PROTECTION_FAILURE")).toBe(false);
    expect(isRetryablePause("STALE_BINANCE_SNAPSHOT")).toBe(false);
    expect(isRetryablePause("manually paused for review")).toBe(false);
    expect(isRetryablePause(null)).toBe(false);
    expect(isRetryablePause(undefined)).toBe(false);
  });
});

describe("CVD from 5m candles",()=>{
  const start=Date.UTC(2026,7,7,12,0,0),end=start+15*60_000;
  const bar=(minute:number,buy:number,sell:number)=>({openTime:start+minute*60_000,quoteVolume:buy+sell,takerBuyQuoteVolume:buy});

  /** The per-trade sum this replaced: +1 when the buyer was the taker, -1 when the seller was. */
  const fromTrades=(trades:Array<{minute:number;quote:number;buyerIsMaker:boolean}>)=>
    trades.reduce((bins,t)=>{
      const i=Math.min(2,Math.max(0,Math.floor(t.minute/5)));
      bins[i]=(bins[i]??0)+(t.buyerIsMaker?-1:1)*t.quote;return bins;
    },[0,0,0]);

  it("computes the same signed flow the per-trade sum did",()=>{
    // Bin 0: 300 taken on the bid, 100 on the ask. Bin 1: the reverse. Bin 2: balanced.
    expect(cvdBinsFromCandles([bar(0,300,100),bar(5,50,150),bar(10,200,200)],start,end))
      .toEqual(fromTrades([
        {minute:1,quote:300,buyerIsMaker:false},{minute:2,quote:100,buyerIsMaker:true},
        {minute:6,quote:50,buyerIsMaker:false},{minute:7,quote:150,buyerIsMaker:true},
        {minute:11,quote:200,buyerIsMaker:false},{minute:12,quote:200,buyerIsMaker:true}
      ]));
  });

  it("keeps each 5m candle in its own direction-confirmation bin",()=>{
    expect(cvdBinsFromCandles([bar(0,300,100),bar(5,50,150),bar(10,200,200)],start,end)).toEqual([200,-100,0]);
  });

  it("ignores anything outside the scan window",()=>{
    // The bar before the window and the one that opens exactly at the close
    // both belong to a different 15-minute scan.
    expect(cvdBinsFromCandles([bar(-5,999,0),bar(0,300,100),bar(15,999,0)],start,end)).toEqual([200,0,0]);
  });

  it("treats a candle with no trades as no flow, not as missing data",()=>{
    expect(cvdBinsFromCandles([bar(0,0,0)],start,end)).toEqual([0,0,0]);
    expect(cvdBinsFromCandles([],start,end)).toEqual([0,0,0]);
  });
});
