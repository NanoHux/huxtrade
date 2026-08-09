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
    // Dispersed on purpose. A smooth ramp makes every 1h change identical,
    // which shrinks the MAD to a rounding artefact and yields a z in the
    // thousands — a fixture that would assert nothing about the threshold.
    const values=Array.from({length:30},(_,i)=>100+i*0.1+(i%3===0?1.5:i%3===1?-0.9:0.4));
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
    // Irregular by design. A constant funding baseline has a MAD of zero on
    // both the level and the 4h difference, which is the CYS pathology, not a
    // fixture: the z comes back infinite and passes every threshold. Real
    // funding does move — BTC's baseline MAD is 1.78e-5.
    const steps=[0,2,1,4,2,5,1,3,6,2,4,1,5,3,2,6,1,4,2,5,3,1,6,2,4,3,0];
    const values=steps.map((step)=>0.001+step*0.00002);
    values[26]=values[10]!+0.002;
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

describe("CVD direction requires every bin to agree",()=>{
  // A two-value alternation still has a real MAD (110), so the baseline is
  // usable; the bins are what these tests are about.
  const history=Array.from({length:2880},(_,i)=>i%2?120:-100);

  it("confirms only when all three five-minute bins point the same way",()=>{
    expect(cvdAnomaly({currentBins:[-900,-800,-700],history}).direction).toBe(-1);
    expect(cvdAnomaly({currentBins:[900,800,700],history}).direction).toBe(1);
  });

  it("abstains when one large bin sets the total against the other two",()=>{
    // The shape a 2-of-3 majority let through: the sum is positive, so the
    // z-score reads as a buying anomaly, while the vote called it selling —
    // strength and direction from opposite evidence, on the same bar.
    const contradictory={currentBins:[5000,-40,-40],history};
    expect(cvdAnomaly(contradictory).value).toBeGreaterThan(0);
    expect(cvdAnomaly(contradictory).direction).toBe(0);
    expect(cvdAnomaly(contradictory).passed).toBe(false);
  });

  it("never lets the confirmed direction contradict the sum",()=>{
    // Structural, not incidental: three same-signed bins must sum to that sign.
    for(const bins of [[3,1,2],[-3,-1,-2],[900,1,1],[-1,-900,-1]]){
      const result=cvdAnomaly({currentBins:bins,history});
      if(result.direction!==0)expect(Math.sign(result.value)).toBe(result.direction);
    }
  });

  it("treats a silent bin as no agreement rather than as assent",()=>{
    expect(cvdAnomaly({currentBins:[-500,-400,0],history}).direction).toBe(0);
    expect(cvdAnomaly({currentBins:[0,0,0],history}).direction).toBe(0);
    expect(cvdAnomaly({currentBins:[],history}).direction).toBe(0);
  });
});

describe("a baseline with no scale cannot judge anything",()=>{
  // CYS's funding sat on one value for more than half of 3006 samples, so the
  // MAD was exactly zero and the z came back infinite — which passed every
  // |z| >= threshold test it was fed into, on an asset the statistic could
  // not actually speak about.
  it("reports funding as un-warmed rather than infinitely anomalous",()=>{
    const flat=Array(200).fill(0.0001);
    const result=fundingAnomaly({values:[...flat,0.05],baselineSamples:100});
    expect(result.ready).toBe(false);
    expect(result.passed).toBe(false);
  });

  it("does the same for OI and CVD",()=>{
    expect(oiAnomaly({values:[...Array(200).fill(100),140],baselineSamples:100}).ready).toBe(false);
    expect(cvdAnomaly({currentBins:[9,9,9],history:Array(200).fill(50),baselineSamples:100}).ready).toBe(false);
  });

  it("still accepts a genuinely extreme reading on a baseline that has scale",()=>{
    // 24x the typical magnitude, on a baseline with a real MAD: extreme, not
    // degenerate, and the model is entitled to act on it.
    const history=Array.from({length:2880},(_,i)=>i%2?120:-100);
    const result=cvdAnomaly({currentBins:[-800,-800,-800],history});
    expect(result.ready).toBe(true);
    expect(Math.abs(result.zScore)).toBeGreaterThan(10);
    expect(result.direction).toBe(-1);
  });
});
