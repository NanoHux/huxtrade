import { createHash } from "node:crypto";
import { fixedRules } from "@huxtrade/config";
import type { BtcRegime, ConditionResult, Direction, HeatmapRegion, OrderPlan, Strategy } from "@huxtrade/shared-types";

export function directionAllowed(regime: BtcRegime, direction: Direction): boolean {
  return regime === "RANGE" || regime === "TRANSITION" || (regime === "BULL" && direction === "LONG") || (regime === "BEAR" && direction === "SHORT");
}

export function candidateDirections(input:{cvdSelected:boolean;cvdPassed:boolean;cvdDirection?:Direction|null}):Direction[]{
  return input.cvdSelected&&input.cvdPassed&&input.cvdDirection?[input.cvdDirection]:["LONG","SHORT"];
}

export function evaluateConditions(strategy: Strategy, conditions: ConditionResult[]): boolean {
  const selected = strategy.conditions.map((type) => conditions.find((x) => x.type === type));
  if (selected.some((x) => !x)) return false;
  const passed = selected.filter((x) => x!.passed).length;
  return strategy.logic === "AND" ? passed === selected.length : passed >= (strategy.requiredCount ?? selected.length);
}

export function eligibleHeatmapRegions(regions: Array<Omit<HeatmapRegion, "rank" | "percentile">>): HeatmapRegion[] {
  if (!regions.length) return [];
  const intensities = [...regions].map((x) => x.intensity).sort((a, b) => a - b);
  const ranked = [...regions].sort((a, b) => b.intensity - a.intensity);
  return ranked.map((region, index) => ({
    ...region,
    rank: index + 1,
    percentile: intensities.filter((x) => x <= region.intensity).length / intensities.length
  })).filter((region) => region.rank <= 5 || region.percentile >= 0.8);
}

/**
 * Spec 7.2: entering the region only arms the candidate. Confirmation requires
 * the close of the following 15-minute candle, which is exactly the persisted
 * `confirm_after` boundary (armed close + one scan period).
 */
export function heatmapEntryState(input:{region:HeatmapRegion;price:number;closedAt:string;armedAt?:string|null;confirmAfter?:string|null;conditionsValid:boolean}) {
  if (!input.conditionsValid) return { state:"INVALIDATED" as const, reason:"CONDITIONS_INVALID" };
  const inside=input.price>=input.region.lowPrice&&input.price<=input.region.highPrice;
  if (input.armedAt) {
    if(!inside)return {state:"INVALIDATED" as const,reason:"PRICE_EXITED_REGION"};
    const boundary=input.confirmAfter
      ? new Date(input.confirmAfter).getTime()
      : new Date(input.armedAt).getTime()+fixedRules.scanMinutes*60_000;
    return new Date(input.closedAt).getTime()>=boundary
      ? {state:"CONFIRMED" as const,reason:"NEXT_15M_CLOSE_CONFIRMED"}
      : {state:"ARMED" as const,reason:"WAITING_NEXT_15M_CLOSE"};
  }
  return inside?{state:"ARMED" as const,reason:"PRICE_ENTERED_REGION"}:{state:"WAITING_ENTRY" as const,reason:"PRICE_OUTSIDE_REGION"};
}

/** Spec 7.3: the take-profit sits `0.15 x 1h ATR` in front of the target region. */
export function takeProfitPriceFor(region: Pick<HeatmapRegion, "price">, direction: Direction, atr1h: number): number {
  return direction === "LONG"
    ? region.price - fixedRules.takeProfitAtrOffset * atr1h
    : region.price + fixedRules.takeProfitAtrOffset * atr1h;
}

/**
 * Spec 7.3: the first candidate is the strongest eligible region in the trade
 * direction. When it cannot deliver a 1.5 reward/risk ratio the search
 * continues outward — strictly *farther* regions only, nearest first — so a
 * weaker but closer region can never replace the primary candidate.
 */
export function chooseHeatmapTarget(regions: HeatmapRegion[], direction: Direction, entry: number, stop: number, atr1h: number): HeatmapRegion | undefined {
  const risk = Math.abs(entry - stop);
  if (!(risk > 0)) return undefined;
  const distance = (region: HeatmapRegion) => direction === "LONG" ? region.price - entry : entry - region.price;
  const meetsRiskReward = (region: HeatmapRegion) => {
    const target = takeProfitPriceFor(region, direction, atr1h);
    const reward = direction === "LONG" ? target - entry : entry - target;
    return reward / risk >= fixedRules.minimumRiskReward - 1e-9;
  };
  const ahead = regions.filter((region) => distance(region) > 0).sort((a, b) => distance(a) - distance(b));
  if (!ahead.length) return undefined;
  const primary = [...ahead].sort((a, b) => b.intensity - a.intensity || distance(a) - distance(b))[0]!;
  if (meetsRiskReward(primary)) return primary;
  return ahead.find((region) => distance(region) > distance(primary) && meetsRiskReward(region));
}

/**
 * Spec 7.3 "反向阻挡": a significant liquidation region sitting between the
 * entry and the fixed 1.5R objective rejects the trade. The check is anchored
 * on the fixed 1.5R level and therefore applies to every new order, not only to
 * the fallback take-profit path.
 */
export function findBlockingRegion(regions: HeatmapRegion[], direction: Direction, entry: number, risk: number): HeatmapRegion | undefined {
  const fixedTarget = direction === "LONG" ? entry + risk * fixedRules.minimumRiskReward : entry - risk * fixedRules.minimumRiskReward;
  return regions.find((region) => direction === "LONG"
    ? region.price > entry && region.price < fixedTarget
    : region.price < entry && region.price > fixedTarget);
}

export function makeOrderPlan(input: {
  symbol: string; direction: Direction; closedAt: string; entryPrice: number; swing: number; atr1h: number;
  regions: HeatmapRegion[]; marginUsdc: number; leverage: number;
}): OrderPlan {
  const { direction, entryPrice, atr1h } = input;
  const stopLoss = direction === "LONG" ? input.swing - fixedRules.stopAtrBuffer * atr1h : input.swing + fixedRules.stopAtrBuffer * atr1h;
  const risk = direction === "LONG" ? entryPrice - stopLoss : stopLoss - entryPrice;
  if (risk <= 0) throw new Error("market structure produces an invalid stop");
  const blocking = findBlockingRegion(input.regions, direction, entryPrice, risk);
  if (blocking) throw new Error(`an opposing heatmap region at ${blocking.price} blocks the path to the 1.5R target`);
  const target = chooseHeatmapTarget(input.regions, direction, entryPrice, stopLoss, atr1h);
  const fallback = direction === "LONG" ? entryPrice + risk * fixedRules.minimumRiskReward : entryPrice - risk * fixedRules.minimumRiskReward;
  const takeProfit = target ? takeProfitPriceFor(target, direction, atr1h) : fallback;
  const expectedRiskReward = Math.abs(takeProfit - entryPrice) / risk;
  if (expectedRiskReward < fixedRules.minimumRiskReward - 1e-9) throw new Error("risk/reward below 1.5");
  const key = createHash("sha256").update(`${input.symbol}|${direction}|${input.closedAt}`).digest("hex");
  return { idempotencyKey: key, symbol: input.symbol, direction, entryPrice, stopLoss, takeProfit, expectedRiskReward, marginUsdc: input.marginUsdc, leverage: input.leverage, notionalUsdc: input.marginUsdc * input.leverage, heatmapTarget: target };
}

export function marginPauseTransition(currentPaused:boolean,marginUsage:number):"PAUSE"|"RESUME"|"HOLD"{
  if(!currentPaused&&marginUsage>=80)return "PAUSE";
  if(currentPaused&&marginUsage<75)return "RESUME";
  return "HOLD";
}

export function adjustMarginForPlatformMinimum(defaultMargin:number,requiredMargin:number,maxMargin:number,leverage:number){
  const margin=Math.max(defaultMargin,requiredMargin);
  if(margin>maxMargin)return {accepted:false as const,reason:"PLATFORM_MINIMUM_EXCEEDS_MARGIN_CAP"};
  return {accepted:true as const,marginUsdc:margin,notionalUsdc:margin*leverage};
}

export function riskGate(input: { globalPaused: boolean; assetPaused: boolean; dataFresh: boolean; sessionValid: boolean; liveTrading: boolean; marginUsage: number; marginAutoPaused?:boolean; concurrentOrders: number; maxOrders: number }) {
  const reasons: string[] = [];
  if (input.globalPaused) reasons.push("GLOBAL_PAUSED");
  if (input.assetPaused) reasons.push("ASSET_PAUSED");
  if (!input.dataFresh) reasons.push("STALE_DATA");
  if (!input.sessionValid) reasons.push("VARIATIONAL_SESSION_INVALID");
  if (!input.liveTrading) reasons.push("LIVE_TRADING_DISABLED");
  if (input.marginUsage >= 80 || input.marginAutoPaused) reasons.push("MARGIN_USAGE_LIMIT");
  if (input.concurrentOrders >= input.maxOrders) reasons.push("SYMBOL_SIDE_LIMIT");
  return { passed: reasons.length === 0, reasons };
}

export const validOrderTransitions: Record<string, string[]> = {
  CREATED_LOCAL: ["SUBMITTING", "SUBMISSION_FAILED"],
  SUBMITTING: ["PENDING_ENTRY", "FILLED_OPEN", "SUBMISSION_FAILED", "UNKNOWN"],
  PENDING_ENTRY: ["FILLED_OPEN", "CANCELLED_EXTERNALLY", "UNKNOWN", "RECONCILIATION_REQUIRED"],
  FILLED_OPEN: ["CLOSED_TP", "CLOSED_SL", "LIQUIDATED", "RECONCILIATION_REQUIRED"],
  UNKNOWN: ["PENDING_ENTRY", "FILLED_OPEN", "CLOSED_TP", "CLOSED_SL", "LIQUIDATED", "CANCELLED_EXTERNALLY", "SUBMISSION_FAILED", "RECONCILIATION_REQUIRED"],
  RECONCILIATION_REQUIRED: ["PENDING_ENTRY", "FILLED_OPEN", "CLOSED_TP", "CLOSED_SL", "LIQUIDATED", "CANCELLED_EXTERNALLY", "UNKNOWN"]
};

export function assertOrderTransition(from: string, to: string) {
  if (!validOrderTransitions[from]?.includes(to)) throw new Error(`invalid order transition ${from} -> ${to}`);
}
