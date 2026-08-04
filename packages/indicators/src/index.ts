import type { BtcRegime } from "@huxtrade/shared-types";

export interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteVolume?: number;
  takerBuyQuoteVolume?: number;
}

export function median(values: number[]): number {
  if (!values.length) throw new Error("median requires values");
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function robustZScore(value: number, history: number[]): number {
  if (history.length < 5) throw new Error("robustZScore requires at least 5 observations");
  const center = median(history);
  const mad = median(history.map((x) => Math.abs(x - center)));
  if (mad === 0) return value === center ? 0 : Math.sign(value - center) * Number.POSITIVE_INFINITY;
  return 0.67448975 * (value - center) / mad;
}

export function ema(values: number[], period: number): number[] {
  if (period <= 0 || values.length < period) return [];
  const seed = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const result = Array(period - 1).fill(Number.NaN) as number[];
  result.push(seed);
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i += 1) result.push(values[i]! * k + result[i - 1]! * (1 - k));
  return result;
}

export function atr(candles: Candle[], period = 14): number[] {
  if (candles.length < period + 1) return [];
  const tr = candles.map((c, i) => i === 0 ? c.high - c.low : Math.max(
    c.high - c.low,
    Math.abs(c.high - candles[i - 1]!.close),
    Math.abs(c.low - candles[i - 1]!.close)
  ));
  const result = Array(period - 1).fill(Number.NaN) as number[];
  let current = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result.push(current);
  for (let i = period; i < tr.length; i += 1) {
    current = (current * (period - 1) + tr[i]!) / period;
    result.push(current);
  }
  return result;
}

export function adx(candles: Candle[], period = 14): number {
  if (candles.length < period * 2 + 1) return Number.NaN;
  const tr: number[] = [], plusDm: number[] = [], minusDm: number[] = [];
  for (let i = 1; i < candles.length; i += 1) {
    const c = candles[i]!, p = candles[i - 1]!;
    const up = c.high - p.high, down = p.low - c.low;
    plusDm.push(up > down && up > 0 ? up : 0);
    minusDm.push(down > up && down > 0 ? down : 0);
    tr.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  const dx: number[] = [];
  for (let i = period - 1; i < tr.length; i += 1) {
    const trSum = tr.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0);
    const plus = 100 * plusDm.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / trSum;
    const minus = 100 * minusDm.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / trSum;
    dx.push(100 * Math.abs(plus - minus) / Math.max(plus + minus, Number.EPSILON));
  }
  return dx.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function slope(values: number[], lookback = 5) {
  if (values.length < lookback) return 0;
  const recent = values.slice(-lookback);
  return recent[recent.length - 1]! - recent[0]!;
}

export function confirmedMarketStructure(candles:Candle[]):"BULL"|"BEAR"|"MIXED"{
  const highs:number[]=[],lows:number[]=[];
  for(let i=2;i<candles.length-2;i+=1){
    const window=candles.slice(i-2,i+3),current=candles[i]!;
    if(current.high===Math.max(...window.map((c)=>c.high)))highs.push(current.high);
    if(current.low===Math.min(...window.map((c)=>c.low)))lows.push(current.low);
  }
  if(highs.length<2||lows.length<2)return "MIXED";
  const higherHigh=highs.at(-1)!>highs.at(-2)!,higherLow=lows.at(-1)!>lows.at(-2)!;
  const lowerHigh=highs.at(-1)!<highs.at(-2)!,lowerLow=lows.at(-1)!<lows.at(-2)!;
  return higherHigh&&higherLow?"BULL":lowerHigh&&lowerLow?"BEAR":"MIXED";
}

export function classifyBtcRegime(daily: Candle[], fourHour: Candle[], previous: BtcRegime = "TRANSITION"):
  { regime: BtcRegime; adxState: "TREND" | "RANGE" | "TRANSITION"; adx: number } {
  const dClose = daily.map((x) => x.close), hClose = fourHour.map((x) => x.close);
  const d50 = ema(dClose, 50), d200 = ema(dClose, 200), h20 = ema(hClose, 20), h50 = ema(hClose, 50);
  if (!d200.length || !h50.length) return { regime: "TRANSITION", adxState: "TRANSITION", adx: Number.NaN };
  const structure=confirmedMarketStructure(daily);
  const dailyBull = d50.at(-1)! > d200.at(-1)! && slope(d50) > 0 && structure==="BULL";
  const dailyBear = d50.at(-1)! < d200.at(-1)! && slope(d50) < 0 && structure==="BEAR";
  const confirmBull = h20.at(-1)! > h50.at(-1)!;
  const confirmBear = h20.at(-1)! < h50.at(-1)!;
  const adxValue = adx(fourHour);
  const adxState = adxValue >= 25 ? "TREND" : adxValue <= 18 ? "RANGE" : "TRANSITION";
  if (adxState === "RANGE") return { regime: "RANGE", adxState, adx: adxValue };
  if (adxState === "TRANSITION") return { regime: previous, adxState, adx: adxValue };
  return { regime: dailyBull && confirmBull ? "BULL" : dailyBear && confirmBear ? "BEAR" : "TRANSITION", adxState, adx: adxValue };
}

export function confirmedDirection(values: number[], minimumAligned: number, lookback: number): -1 | 0 | 1 {
  const recent = values.slice(-lookback).map(Math.sign);
  const positive = recent.filter((x) => x > 0).length;
  const negative = recent.filter((x) => x < 0).length;
  return positive >= minimumAligned ? 1 : negative >= minimumAligned ? -1 : 0;
}

export function rollingChange(values: number[], periods: number): number[] {
  if (periods <= 0) throw new Error("periods must be positive");
  const result: number[] = [];
  for (let i = periods; i < values.length; i += 1) {
    const previous = values[i - periods]!;
    result.push(previous === 0 ? 0 : (values[i]! - previous) / Math.abs(previous));
  }
  return result;
}

export function rollingDifference(values: number[], periods: number): number[] {
  if (periods <= 0) throw new Error("periods must be positive");
  const result: number[] = [];
  for (let i = periods; i < values.length; i += 1) result.push(values[i]! - values[i - periods]!);
  return result;
}

export function oiAnomaly(input: { values: number[]; baselineSamples?: number; zThreshold?: number }) {
  const baselineSamples = input.baselineSamples ?? 30 * 24 * 4;
  const changes = rollingChange(input.values, 4);
  if (changes.length < baselineSamples + 1) {
    return { ready: false, value: changes.at(-1) ?? 0, zScore: 0, direction: 0 as -1 | 0 | 1, passed: false, sampleCount: changes.length };
  }
  const current = changes.at(-1)!;
  const baseline = changes.slice(-(baselineSamples + 1), -1);
  const zScore = robustZScore(current, baseline);
  const direction = confirmedDirection(changes, 2, 3);
  return { ready: true, value: current, zScore, direction, passed: Math.abs(zScore) >= (input.zThreshold ?? 1) && direction !== 0, sampleCount: baseline.length };
}

export function cvdAnomaly(input: { currentBins: number[]; history: number[]; baselineSamples?: number; zThreshold?: number }) {
  const baselineSamples = input.baselineSamples ?? 30 * 24 * 4;
  const value = input.currentBins.reduce((sum, x) => sum + x, 0);
  if (input.history.length < baselineSamples) return { ready:false, value, zScore:0, direction:0 as -1|0|1, passed:false, sampleCount:input.history.length };
  const baseline = input.history.slice(-baselineSamples);
  const zScore = robustZScore(value, baseline);
  const direction = confirmedDirection(input.currentBins, 2, 3);
  return { ready:true, value, zScore, direction, passed:Math.abs(zScore)>=(input.zThreshold??1)&&direction!==0, sampleCount:baseline.length };
}

export function fundingAnomaly(input: { values: number[]; baselineSamples?: number; zThreshold?: number }) {
  const baselineSamples = input.baselineSamples ?? 30 * 24 * 4;
  if (input.values.length < baselineSamples + 17) return { ready:false, value:input.values.at(-1)??0, change4h:0, currentZ:0, changeZ:0, score:0, passed:false, sampleCount:Math.max(0,input.values.length-17) };
  const current = input.values.at(-1)!;
  // Funding is already a rate. The requirement calls for its absolute 4h
  // change, not a percentage change whose denominator can be near zero.
  const changes4h = rollingDifference(input.values, 16);
  const currentBaseline = input.values.slice(-(baselineSamples + 1), -1);
  const changeBaseline = changes4h.slice(-(baselineSamples + 1), -1);
  const change4h = changes4h.at(-1)!;
  const currentZ = robustZScore(current, currentBaseline);
  const changeZ = robustZScore(change4h, changeBaseline);
  const score = Math.max(Math.abs(currentZ), Math.abs(changeZ));
  return { ready:true, value:current, change4h, currentZ, changeZ, score, passed:score>=(input.zThreshold??1), sampleCount:Math.min(currentBaseline.length,changeBaseline.length) };
}

export function findAtrSwing(candles: Candle[], atrValue: number, direction: "LONG" | "SHORT"): number {
  if (!Number.isFinite(atrValue) || atrValue <= 0 || candles.length < 3) throw new Error("invalid ATR swing input");
  const recent = candles.slice(-48);
  if (direction === "LONG") {
    for(let i=recent.length-2;i>=1;i-=1){const candidate=recent[i]!.low;const local=Math.min(...recent.slice(i-1,i+2).map((c)=>c.low));const futureHigh=Math.max(...recent.slice(i+1).map((c)=>c.high));if(candidate===local&&futureHigh-candidate>=atrValue)return candidate;}
    return Math.min(...recent.map((c) => c.low));
  }
  for(let i=recent.length-2;i>=1;i-=1){const candidate=recent[i]!.high;const local=Math.max(...recent.slice(i-1,i+2).map((c)=>c.high));const futureLow=Math.min(...recent.slice(i+1).map((c)=>c.low));if(candidate===local&&candidate-futureLow>=atrValue)return candidate;}
  return Math.max(...recent.map((c) => c.high));
}
