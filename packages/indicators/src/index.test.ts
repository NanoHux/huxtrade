import { describe, expect, it } from "vitest";
import { atr, confirmedDirection, confirmedMarketStructure, cvdAnomaly, ema, findAtrSwing, fundingAnomaly, median, oiAnomaly, robustZScore, rollingChange, rollingDifference } from "./index.js";

describe("deterministic indicators", () => {
  it("computes median and robust z without sensitivity to a single outlier", () => {
    expect(median([9, 1, 2, 3, 4])).toBe(3);
    expect(robustZScore(4, [1, 2, 3, 4, 100])).toBeCloseTo(0.67448975);
  });
  it("confirms 2 of 3 directional samples", () => {
    expect(confirmedDirection([-2, 1, 4], 2, 3)).toBe(1);
    expect(confirmedDirection([-2, -1, 4], 2, 3)).toBe(-1);
  });
  it("computes EMA and ATR", () => {
    expect(ema([1, 2, 3, 4, 5], 3).at(-1)).toBeCloseTo(4);
    const candles = Array.from({ length: 20 }, (_, i) => ({ openTime: i, open: 100+i, high: 102+i, low: 99+i, close: 101+i, volume: 1 }));
    expect(atr(candles, 14).at(-1)).toBeCloseTo(3);
  });
  it("uses a one-hour change for OI and 2-of-3 direction confirmation", () => {
    expect(rollingChange([100, 101, 102, 103, 104], 4)).toEqual([0.04]);
    const values=Array.from({length:30},(_,i)=>100+i*0.1);
    values.push(110,111,112,113,120);
    const result=oiAnomaly({values,baselineSamples:20});
    expect(result.ready).toBe(true);
    expect(result.direction).toBe(1);
    expect(result.passed).toBe(true);
  });
  it("gates CVD and Funding until the requested baseline is ready", () => {
    expect(cvdAnomaly({currentBins:[1,2,3],history:[1,2],baselineSamples:4}).ready).toBe(false);
    expect(fundingAnomaly({values:Array(20).fill(0.001),baselineSamples:10}).ready).toBe(false);
  });
  it("uses an absolute rate difference for the four-hour Funding change",()=>{
    expect(rollingDifference([0.001,0.002,0.004],2)).toEqual([0.003]);
    const values=Array(27).fill(0.001) as number[];
    values[26]=0.003;
    const result=fundingAnomaly({values,baselineSamples:10});
    expect(result.ready).toBe(true);
    expect(result.change4h).toBeCloseTo(0.002);
    expect(result.passed).toBe(true);
  });
  it("uses only confirmed pivot highs and lows for market structure",()=>{
    const closes=[10,14,12,11,15,13,12,16,14,13];
    const candles=closes.map((close,i)=>({openTime:i,open:close,high:close+1,low:close-1,close,volume:1}));
    expect(confirmedMarketStructure(candles)).toBe("BULL");
  });
  it("selects the most recent ATR-confirmed structure swing",()=>{
    const closes=[100,102,99,103,101,105,102,107,104,108];
    const candles=closes.map((close,i)=>({openTime:i,open:close,high:close+1,low:close-1,close,volume:1}));
    expect(findAtrSwing(candles,2,"LONG")).toBe(103);
  });
});
