import { createHash } from "node:crypto";
import { fixedRules } from "@huxtrade/config";
import type { BtcRegime, ConditionResult, Direction, EntryCandidateSource, HeatmapRegion, OrderPlan, RestingEntrySettings, Strategy } from "@huxtrade/shared-types";

export function directionAllowed(regime: BtcRegime, direction: Direction): boolean {
  return regime === "RANGE" || regime === "TRANSITION" || (regime === "BULL" && direction === "LONG") || (regime === "BEAR" && direction === "SHORT");
}

/**
 * Refuses to trade WITH a move that has already run.
 *
 * The CVD read that arms a SHORT — takers hitting the bid harder than the ask —
 * means something different inside a strong advance: it is holders taking
 * profit while buyers absorb, and price keeps going. Measured over seven days
 * and ten assets, the identical signal returned -4.66% against the position in
 * the next hour on assets up 10%+ over 24h, versus -0.11% on quiet ones.
 *
 * The long side is filtered on the same threshold, by operator decision rather
 * than by measurement: the mirror case had only 14 observations, which is not
 * evidence either way, so this half rests on the symmetry argument. Worth
 * re-measuring once enough longs into 15% dumps have resolved.
 *
 * An unknown 24h change (a newly tracked asset with no history yet) does not
 * block: the filter exists to veto a measured condition, not to veto ignorance.
 */
export function directionAllowedAfterMove(change24hPercent:number|null|undefined,direction:Direction,settings:RestingEntrySettings=restingEntryDefaults):boolean{
  if(!(settings.extremeMoveBlockPercent>0))return true;
  if(typeof change24hPercent!=="number"||!Number.isFinite(change24hPercent))return true;
  return direction==="SHORT"
    ? change24hPercent<settings.extremeMoveBlockPercent
    : change24hPercent>-settings.extremeMoveBlockPercent;
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
 * Where the move is actually heading.
 *
 * OI and CVD have already argued the direction, so the objective is the
 * strongest liquidation cluster ahead — selected by intensity peak alone, with
 * no aggregation of neighbouring bands into a rival candidate, and with no
 * search past it for something farther and weaker that happens to pay better
 * (that is inventing a target to justify a trade).
 *
 * One correction is applied. A cluster standing between the entry and that
 * peak either gets run through or stops the move, and its own intensity
 * relative to the peak is the evidence: below `falsePeakIntensityRatio` it is
 * assumed to be consumed on the way, at or above it the move is assumed to end
 * there and it becomes the objective instead. The nearest qualifying one wins,
 * because that is the first thing price meets.
 *
 * Exactly one hop: the demoted objective is not re-scanned for obstacles of
 * its own, which would recurse with no natural stopping point.
 *
 * No ratio test here — this answers "where", and composePlan answers "is that
 * far enough to be worth the stop", so a rejection can say which it was.
 */
export function chooseHeatmapTarget(regions: HeatmapRegion[], direction: Direction, entry: number): HeatmapRegion | undefined {
  const distance = (region: HeatmapRegion) => direction === "LONG" ? region.price - entry : entry - region.price;
  const ahead = regions.filter((region) => distance(region) > 0);
  if (!ahead.length) return undefined;
  const peak = [...ahead].sort((a, b) => b.intensity - a.intensity || distance(a) - distance(b))[0]!;
  const obstacle = ahead
    .filter((region) => distance(region) < distance(peak) && region.intensity >= peak.intensity * fixedRules.falsePeakIntensityRatio)
    .sort((a, b) => distance(a) - distance(b))[0];
  return obstacle ?? peak;
}

/** The market-on-signal path, kept selectable as the rollback from the resting model. */
export function makeOrderPlan(input: {
  symbol: string; venueSymbol?: string; direction: Direction; closedAt: string; entryPrice: number; swing: number; atr1h: number;
  regions: HeatmapRegion[]; marginUsdc: number; leverage: number;
}): OrderPlan {
  return {
    venueSymbol: input.venueSymbol,
    ...composePlan({
      ...input,
      idempotencyKey: createHash("sha256").update(`${input.symbol}|${input.direction}|${input.closedAt}`).digest("hex"),
      structuralAnchor: input.swing
    }),
    entryKind: "MARKET_ON_SIGNAL"
  };
}

/**
 * The stop/target/ratio half of a plan: structure decides the stop, the peak
 * decides the target, and anything that cannot be built from both is not a
 * trade.
 *
 * The stop is set FIRST, from price structure alone — `structuralAnchor` is
 * whatever the stop must sit beyond (the ATR swing for a market entry, the
 * deeper of {chosen zone's far edge, swing} for a resting entry). Only then is
 * the objective read off the heatmap, so the ratio is a measurement of the
 * setup rather than something reverse-engineered to hit a number.
 *
 * Every failure here rejects the order. The previous margin-fraction fallback
 * — a stop sized off the position rather than off the chart, with a target
 * reverse-derived from it — produced orders whose stop had no relationship to
 * anything on the price axis, so its "risk/reward" measured nothing.
 */
function composePlan(input: {
  idempotencyKey: string; symbol: string; direction: Direction; entryPrice: number; structuralAnchor?: number;
  atr1h: number; regions: HeatmapRegion[]; marginUsdc: number; leverage: number;
}, settings: RestingEntrySettings = restingEntryDefaults): OrderPlan {
  const { direction, entryPrice, atr1h, structuralAnchor } = input;
  if (structuralAnchor === undefined) throw new Error("no price structure to place a stop behind");
  const stopLoss = direction === "LONG" ? structuralAnchor - fixedRules.stopAtrBuffer * atr1h : structuralAnchor + fixedRules.stopAtrBuffer * atr1h;
  const risk = direction === "LONG" ? entryPrice - stopLoss : stopLoss - entryPrice;
  if (!(risk > 0)) throw new Error("the structural stop sits on the wrong side of the entry");
  const target = chooseHeatmapTarget(input.regions, direction, entryPrice);
  // The furthest the target may ever sit. Beyond this the ratio stops
  // measuring the quality of the setup and starts measuring how far away the
  // peak happens to be, and the trade resolves to a stop every time.
  const ratioCap = direction === "LONG"
    ? entryPrice + fixedRules.maximumRiskReward * risk
    : entryPrice - fixedRules.maximumRiskReward * risk;
  // No zone ahead is not a reason to refuse: nothing overhead is what a
  // runaway move looks like, and the structural stop is already placed. Aim
  // at the cap and let the trade run to it.
  const atTarget = target ? takeProfitPriceFor(target, direction, atr1h) : ratioCap;
  const takeProfit = direction === "LONG" ? Math.min(atTarget, ratioCap) : Math.max(atTarget, ratioCap);
  const expectedRiskReward = Math.abs(takeProfit - entryPrice) / risk;
  // The floor still refuses outright — a target too near to pay for its own
  // stop cannot be fixed by moving it, unlike one that is too far.
  if (expectedRiskReward < fixedRules.minimumRiskReward - 1e-9) throw new Error(`the objective at ${target?.price ?? takeProfit} only pays ${expectedRiskReward.toFixed(2)}x the stop distance, under ${fixedRules.minimumRiskReward}`);
  return { idempotencyKey: input.idempotencyKey, symbol: input.symbol, direction, entryPrice, stopLoss, takeProfit, expectedRiskReward, marginUsdc: input.marginUsdc, leverage: input.leverage, notionalUsdc: input.marginUsdc * input.leverage, heatmapTarget: target };
}

// ---------------------------------------------------------------------------
// Resting limit entry model
// ---------------------------------------------------------------------------

export const restingEntryDefaults:RestingEntrySettings=Object.freeze({...fixedRules.restingEntry});

/**
 * Layers a strategy's stored overrides onto the defaults. Persisted values
 * are re-checked here rather than trusted: a band that has collapsed or
 * inverted would silently reject every candidate, which looks exactly like a
 * broken candidate search instead of a bad setting.
 */
export function resolveRestingEntry(overrides?:Partial<RestingEntrySettings>|null):RestingEntrySettings{
  const resolved={...restingEntryDefaults};
  for(const key of Object.keys(restingEntryDefaults) as Array<keyof RestingEntrySettings>){
    const value=overrides?.[key];
    if(typeof value==="number"&&Number.isFinite(value)&&value>0)resolved[key]=value;
  }
  if(resolved.entryBandAtrMin>=resolved.entryBandAtrMax){
    resolved.entryBandAtrMin=restingEntryDefaults.entryBandAtrMin;
    resolved.entryBandAtrMax=restingEntryDefaults.entryBandAtrMax;
  }
  resolved.biasPersistenceScans=Math.max(1,Math.round(resolved.biasPersistenceScans));
  resolved.flipConfirmationScans=Math.max(1,Math.round(resolved.flipConfirmationScans));
  resolved.maxArmedAssets=Math.max(1,Math.round(resolved.maxArmedAssets));
  // 0 is a meaningful value here — it turns the filter off — so the
  // positive-only merge above would have silently ignored it.
  // 0 is meaningful for each of these — it switches the rule off — so the
  // positive-only merge above would silently restore the default instead.
  for(const key of ["extremeMoveBlockPercent","lossStreakCount"] as const){
    const value=overrides?.[key];
    if(typeof value==="number"&&Number.isFinite(value)&&value>=0)resolved[key]=value;
  }
  resolved.lossStreakCount=Math.max(0,Math.round(resolved.lossStreakCount));
  // Same reasoning: 0 disables scaling out entirely, which the positive-only
  // merge would read as "unset" and quietly restore the default.
  for(const key of ["scaleOutTriggerR","scaleOutFraction","scaleOutMinStopPercent","breakevenOffsetR"] as const){
    const value=overrides?.[key];
    if(typeof value==="number"&&Number.isFinite(value)&&value>=0)resolved[key]=value;
  }
  // Closing the whole position at the trigger is not a scale-out, it is a
  // second, nearer take-profit that abandons the target the plan was built
  // around. Anything at or above 1 is clamped rather than honoured.
  resolved.scaleOutFraction=Math.min(0.9,resolved.scaleOutFraction);
  return resolved;
}

/** A losing stop-out, as the circuit breaker counts them. */
export interface DirectionLoss{direction:Direction;closedAt:string}

/**
 * Directions the account has stopped arming after a run of losses.
 *
 * Three stop-outs the same way inside a few hours is the signature of a regime
 * the model is reading backwards, not of three independent unlucky trades — on
 * 2026-08-08 four shorts stopped out between 18:58 and 22:14 for -157 USDC,
 * and stopping after the third would have prevented the last of them.
 *
 * Deliberately account-wide rather than per-asset: the losses were spread over
 * `4`, ARC, RAVE and ACE, so a per-asset counter would never have reached
 * three and never fired. What was wrong was the side of the market, not the
 * choice of instrument.
 *
 * Only *losing* stops count. After a scale-out the surviving half exits at its
 * breakeven stop, which books CLOSED_SL while being a scratch or a small win —
 * counting those would halt a direction that is working.
 *
 * The halt runs from the qualifying loss, not from now, so restarting the
 * process cannot extend or reset it.
 */
export function haltedDirections(losses:DirectionLoss[],now:string,settings:RestingEntrySettings=restingEntryDefaults):Array<{direction:Direction;until:string;count:number}>{
  const count=Math.round(settings.lossStreakCount);
  if(!(count>0)||!(settings.lossStreakWindowHours>0)||!(settings.lossStreakHaltHours>0))return [];
  const nowMs=new Date(now).getTime();
  if(!Number.isFinite(nowMs))return [];
  const windowMs=settings.lossStreakWindowHours*3_600_000,haltMs=settings.lossStreakHaltHours*3_600_000;
  const halts:Array<{direction:Direction;until:string;count:number}>=[];
  for(const direction of ["LONG","SHORT"] as const){
    const times=losses.filter((loss)=>loss.direction===direction)
      .map((loss)=>new Date(loss.closedAt).getTime())
      .filter((time)=>Number.isFinite(time))
      .sort((a,b)=>a-b);
    // The newest window that ever held `count` losses decides the halt, so a
    // streak that completed an hour ago still counts for its full duration.
    let trippedAt:number|null=null;
    for(let index=count-1;index<times.length;index+=1){
      if(times[index]!-times[index-count+1]!<=windowMs)trippedAt=times[index]!;
    }
    if(trippedAt===null)continue;
    const until=trippedAt+haltMs;
    if(until>nowMs)halts.push({direction,until:new Date(until).toISOString(),count});
  }
  return halts;
}

export type ScaleOutAction="SCALE_OUT"|"NONE";

export interface ScaleOutInput{
  direction:Direction;
  entryPrice:number;
  stopLoss:number;
  /** Best price the position has traded at since the fill, on the venue's own mark. */
  markPrice:number;
  /** Set once the scale-out has run, so it can never fire twice on one position. */
  alreadyScaledOut:boolean;
}

/**
 * Decides whether an open position has earned enough to take part of it off
 * and move the rest to breakeven. Pure, and deliberately reading a single
 * current mark price rather than a bar's high: the excursion study that
 * motivated the whole mechanism measured 1m highs, and a high is a price that
 * may have existed for a fraction of a second. Triggering on it would move the
 * stop to breakeven — irreversibly, every time — while the half-close it is
 * paired with filled at whatever the market had already fallen back to. That
 * asymmetry hands over all of the "scratched out early" cost and none of the
 * locked profit, so the trigger only ever reads a price we could transact at.
 */
export function scaleOutDecision(input:ScaleOutInput,settings:RestingEntrySettings=restingEntryDefaults):{action:ScaleOutAction;reason:string;profitR?:number}{
  const {direction,entryPrice,stopLoss,markPrice}=input;
  if(input.alreadyScaledOut)return {action:"NONE",reason:"this position has already been scaled out once"};
  if(!(settings.scaleOutTriggerR>0)||!(settings.scaleOutFraction>0))return {action:"NONE",reason:"scaling out is disabled for this strategy"};
  const risk=direction==="LONG"?entryPrice-stopLoss:stopLoss-entryPrice;
  if(!(risk>0))return {action:"NONE",reason:"the stop sits on the wrong side of the entry, so profit cannot be measured in stop-widths"};
  const stopPercent=risk/entryPrice*100;
  if(stopPercent<settings.scaleOutMinStopPercent)return {action:"NONE",reason:`the stop is ${stopPercent.toFixed(2)}% of price, under ${settings.scaleOutMinStopPercent}% — the spread would eat the gain`};
  const profitR=(direction==="LONG"?markPrice-entryPrice:entryPrice-markPrice)/risk;
  if(profitR<settings.scaleOutTriggerR-1e-9)return {action:"NONE",reason:`unrealised profit is ${profitR.toFixed(2)}R, under the ${settings.scaleOutTriggerR}R trigger`,profitR};
  return {action:"SCALE_OUT",reason:`unrealised profit reached ${profitR.toFixed(2)}R, at or above the ${settings.scaleOutTriggerR}R trigger`,profitR};
}

/**
 * Where the surviving half's stop goes. Not the entry price itself: an exit at
 * exactly the entry still pays the spread to get out, so the stop sits a small
 * fraction of a stop-width into profit and the scratch is genuinely flat.
 */
export function breakevenStopPrice(direction:Direction,entryPrice:number,stopLoss:number,settings:RestingEntrySettings=restingEntryDefaults):number{
  const risk=Math.abs(entryPrice-stopLoss);
  return direction==="LONG"?entryPrice+risk*settings.breakevenOffsetR:entryPrice-risk*settings.breakevenOffsetR;
}

/**
 * True when the breakeven stop would sit on the far side of the market and so
 * could never rest there — a LONG's stop at or above the price, a SHORT's at
 * or below it. The venue would refuse it or fire it instantly.
 *
 * The scale-out takes seconds to fill, and price can retrace through breakeven
 * inside that window, so this is reachable in normal operation rather than
 * only in a fault. It is not an error: price below breakeven is exactly the
 * condition the breakeven stop exists to act on, so the caller closes the
 * remainder and books it as the stop having done its job. Without this the
 * same outcome arrives through a failed placement and a manual-intervention
 * alarm, which would cry wolf on an ordinary retrace.
 */
/**
 * How far past a protection level an exit may fill and still be recognised as
 * that protection firing, expressed in stop-widths.
 *
 * Not a percentage of price: 1.5% (the venue's own slippage allowance) is
 * narrower than ZRO's 0.84% stop but nearly the whole of SOL's 2.0% one, so a
 * price-relative band recognises the first correctly and mislabels an operator
 * closing SOL by hand as a stop-out. Measured in R the same number means the
 * same thing on both.
 */
const exitAttributionToleranceR=0.25;

/**
 * Which protection an exit fill came from, decided by where it printed rather
 * than by which order sourced it.
 *
 * The venue's rfq attribution is exact when it resolves, but it silently stops
 * resolving: protections auto-resize, which reissues them under a new rfq id,
 * and the order-history page that would be searched for the old one holds only
 * the 100 most recent orders. Both failure modes look identical — an exit with
 * no matching protection — and both were being booked as "somebody closed this
 * by hand". ZRO closed at 0.846 with the stop at 0.845253 and was recorded as a
 * reversal, so a genuine stop-out never appeared in the loss column.
 *
 * A filled protection prints at its own trigger, give or take slippage, and
 * nothing else on the chart is within a quarter of a stop-width of it. Returns
 * null when the fill sits near neither level, which is the real signature of a
 * manual close and stays classified as one.
 */
export function classifyExitByPrice(input:{
  direction:Direction;exitPrice:number;entryPrice:number;stopLoss:number;takeProfit:number;
  /** Set once the scale-out moved the survivor's stop; it replaces stopLoss as the level to test. */
  breakevenStop?:number|null;
}):"CLOSED_TP"|"CLOSED_SL"|null{
  const {direction,exitPrice,entryPrice,takeProfit}=input;
  const stop=input.breakevenStop??input.stopLoss;
  // The original stop distance stays the unit even after the stop has moved:
  // it is the trade's own risk, and the scale-out does not redefine it.
  const risk=Math.abs(entryPrice-input.stopLoss);
  if(!(risk>0)||!Number.isFinite(exitPrice))return null;
  const tolerance=risk*exitAttributionToleranceR;
  const hitStop=direction==="LONG"?exitPrice<=stop+tolerance:exitPrice>=stop-tolerance;
  const hitTarget=direction==="LONG"?exitPrice>=takeProfit-tolerance:exitPrice<=takeProfit+tolerance;
  // Both can only overlap if the levels themselves are degenerate, which is
  // not something to guess a winner from.
  if(hitStop===hitTarget)return null;
  return hitTarget?"CLOSED_TP":"CLOSED_SL";
}

export function breakevenThroughMarket(direction:Direction,breakeven:number,markPrice:number):boolean{
  if(!Number.isFinite(markPrice)||!Number.isFinite(breakeven))return false;
  return direction==="LONG"?breakeven>=markPrice:breakeven<=markPrice;
}

export interface BiasState{
  direction:Direction|null;armedAt:string|null;armedUntil:string|null;
  /** A reversal being argued for but not yet confirmed. */
  pendingFlipDirection?:Direction|null;
  pendingFlipCount?:number;
}
export type BiasAction="ARM"|"REFRESH"|"FLIP"|"CONTEST"|"EXPIRE"|"HOLD"|"NONE";
export interface ScanConditions{closedAt:string;passedDirections:Direction[]}
export const neutralBias:BiasState=Object.freeze({direction:null,armedAt:null,armedUntil:null,pendingFlipDirection:null,pendingFlipCount:0});

/**
 * The signal conditions no longer trigger an entry — they arm a direction
 * bias that survives `biasPersistenceScans` scans (1 hour by default) and is
 * refreshed by every scan that passes again. A scan that passes the *other*
 * way flips immediately rather than waiting the bias out, because the
 * evidence that produced the old bias has just been contradicted.
 *
 * A scan in which both directions pass is self-contradictory, so it can
 * neither arm nor flip; an already-armed bias is held (it has its own
 * expiry) and a neutral asset stays neutral.
 *
 * A reversal is NOT taken on one bar. Acting on a single counter-signal means
 * overruling a filled position's stop-loss with a signal noisier than that
 * stop — so the counter-direction must assert itself `flipConfirmationScans`
 * times, and any scan that re-confirms the original direction resets the
 * argument. Silent scans neither confirm nor reset: most scans pass nothing,
 * so requiring literally adjacent bars would make a flip near-impossible.
 * While a flip is contested the old bias is held but deliberately NOT
 * refreshed, so persistent contradiction lets it lapse on its own.
 *
 * `incumbent` is a direction the model is already committed to in the market —
 * an open position. A bias lapses after `biasPersistenceScans`, but positions
 * routinely outlive it, and without this the confirmation gate had a hole
 * wide enough to drive through: once the bias expired, a single counter-scan
 * ARMED the opposite side from neutral rather than flipping anything, and the
 * position was closed on one bar with no confirmation at all. A position is a
 * directional commitment in its own right, so it is argued away on the same
 * evidence as an armed bias.
 */
export function biasDecision(previous:BiasState,scan:ScanConditions,settings:RestingEntrySettings=restingEntryDefaults,incumbent:Direction|null=null):BiasState&{action:BiasAction;reason:string}{
  const closedMs=new Date(scan.closedAt).getTime();
  const armed=previous.direction!==null&&previous.armedUntil!==null&&closedMs<new Date(previous.armedUntil).getTime();
  // What must be argued away: the live bias if there is one, otherwise the
  // position the model is already holding.
  const defended=armed?previous.direction:incumbent;
  const conflicting=scan.passedDirections.length>1;
  const passed=scan.passedDirections.length===1?scan.passedDirections[0]!:null;
  const armedUntil=new Date(closedMs+settings.biasPersistenceScans*fixedRules.scanMinutes*60_000).toISOString();
  const pendingDirection=previous.pendingFlipDirection??null,pendingCount=previous.pendingFlipCount??0;
  if(!passed){
    if(armed)return {...previous,action:"HOLD",reason:conflicting?`conditions passed both ways this scan; the existing ${previous.direction} bias is held until ${previous.armedUntil}`:`${previous.direction} bias still armed until ${previous.armedUntil}`};
    if(previous.direction)return {...neutralBias,action:"EXPIRE",reason:`${previous.direction} bias expired at ${previous.armedUntil} without a passing rescan`};
    return {...neutralBias,action:"NONE",reason:conflicting?"conditions passed both ways this scan; no bias":"no direction passed this scan"};
  }
  if(defended&&defended!==passed){
    const asserted=pendingDirection===passed?pendingCount+1:1;
    const needed=Math.max(1,Math.round(settings.flipConfirmationScans));
    const against=armed?`${defended} bias`:`open ${defended} position`;
    if(asserted<needed)return {
      // A lapsed bias defended only by a position stays neutral: the model
      // must not open anything on this side, it simply must not close either.
      direction:armed?previous.direction:null,armedAt:armed?previous.armedAt:null,armedUntil:armed?previous.armedUntil:null,
      pendingFlipDirection:passed,pendingFlipCount:asserted,action:"CONTEST",
      reason:`${passed} conditions passed ${asserted} of the ${needed} times needed to reverse the ${against}; holding${armed?", and not extending it":""}`
    };
    return {direction:passed,armedAt:scan.closedAt,armedUntil,pendingFlipDirection:null,pendingFlipCount:0,action:"FLIP",reason:`reversed the ${against} to ${passed} after ${asserted} counter-signals; armed until ${armedUntil}`};
  }
  if(armed&&previous.direction===passed)return {direction:passed,armedAt:previous.armedAt,armedUntil,pendingFlipDirection:null,pendingFlipCount:0,action:"REFRESH",reason:`${passed} conditions passed again; armed until ${armedUntil}`};
  return {direction:passed,armedAt:scan.closedAt,armedUntil,pendingFlipDirection:null,pendingFlipCount:0,action:"ARM",reason:`${passed} conditions passed; armed until ${armedUntil}`};
}

/**
 * How strong the evidence behind an armed bias is, used only to rank assets
 * against `maxArmedAssets`. Summing the absolute robust z-scores of the
 * conditions that actually passed is deliberately crude but comparable across
 * assets — every z is measured against that asset's own 30-day baseline, so
 * none of them carry an asset-specific scale the way raw OI or CVD would.
 */
export function biasStrength(conditions:ConditionResult[]):number{
  return conditions.reduce((total,condition)=>{
    const z=condition.passed?Math.abs(condition.zScore??0):0;
    return total+(Number.isFinite(z)?z:0);
  },0);
}

export interface EntryCandidate{
  level:number;score:number;sources:EntryCandidateSource[];
  region?:HeatmapRegion;swing?:number;ema?:number;
}

/**
 * Picks where a resting entry waits. Three candidate kinds, all derived from
 * data the pipeline already collects, all required to land inside the entry
 * band [0.3, 2.5] x 1h ATR behind the reference price:
 *   - HEATMAP: the near edge of a liquidation zone the price would have to
 *     sweep, plus `entryOffsetAtr` so the fill happens *before* the sweep.
 *   - SWING: the last confirmed ATR swing point, same offset.
 *   - EMA: the EMA itself, no offset — it is a line, not a zone.
 * Candidates within `confluenceMergeAtr` of each other are one structure seen
 * three ways, so their scores add; the merged level follows the heatmap
 * member when there is one (a zone edge is a harder price than a moving
 * average) and otherwise the deeper, better-priced member.
 */
export function chooseEntryLevel(input:{direction:Direction;price:number;atr1h:number;ema?:number|null;swing?:number|null;regions:HeatmapRegion[];incumbentLevel?:number|null},rules:RestingEntrySettings=restingEntryDefaults):EntryCandidate|null{
  const {direction,price,atr1h}=input;
  if(!(atr1h>0)||!(price>0))return null;
  const long=direction==="LONG";
  const near=long?price-rules.entryBandAtrMin*atr1h:price+rules.entryBandAtrMin*atr1h;
  const far=long?price-rules.entryBandAtrMax*atr1h:price+rules.entryBandAtrMax*atr1h;
  const inBand=(level:number)=>level>0&&(long?level>=far&&level<=near:level<=far&&level>=near);
  const offset=rules.entryOffsetAtr*atr1h;
  const raw:EntryCandidate[]=[];
  for(const region of input.regions){
    const edge=long?region.highPrice:region.lowPrice;
    // A zone that price is already inside (or past) offers nothing to wait for.
    if(long?edge>=price:edge<=price)continue;
    const level=long?edge+offset:edge-offset;
    if(inBand(level))raw.push({level,score:region.percentile,sources:["HEATMAP"],region});
  }
  const swing=input.swing;
  if(typeof swing==="number"&&Number.isFinite(swing)&&(long?swing<price:swing>price)){
    const level=long?swing+offset:swing-offset;
    if(inBand(level))raw.push({level,score:rules.swingScore,sources:["SWING"],swing});
  }
  const ema=input.ema;
  if(typeof ema==="number"&&Number.isFinite(ema)&&inBand(ema))raw.push({level:ema,score:rules.emaScore,sources:["EMA"],ema});
  if(!raw.length)return null;

  const deeperFirst=(a:EntryCandidate,b:EntryCandidate)=>long?a.level-b.level:b.level-a.level;
  const merged:EntryCandidate[]=[];
  for(const candidate of [...raw].sort(deeperFirst)){
    const cluster=merged.find((existing)=>Math.abs(existing.level-candidate.level)<=rules.confluenceMergeAtr*atr1h);
    if(!cluster){merged.push({...candidate,sources:[...candidate.sources]});continue;}
    cluster.score+=candidate.score;
    for(const source of candidate.sources)if(!cluster.sources.includes(source))cluster.sources.push(source);
    if(candidate.region&&(!cluster.region||candidate.region.percentile>cluster.region.percentile)){cluster.region=candidate.region;cluster.level=candidate.level;}
    if(candidate.swing!==undefined)cluster.swing=candidate.swing;
    if(candidate.ema!==undefined)cluster.ema=candidate.ema;
  }
  // The structure a working order already sits on defends its place: a rival
  // must beat it by more than the bonus, not by a hair. "Same structure" reuses
  // the confluence distance rather than inventing a second threshold — if a
  // cluster is close enough to have merged with the incumbent, it is the
  // incumbent.
  const incumbent=input.incumbentLevel;
  if(typeof incumbent==="number"&&Number.isFinite(incumbent)){
    for(const cluster of merged){
      if(Math.abs(cluster.level-incumbent)<=rules.confluenceMergeAtr*atr1h)cluster.score+=rules.incumbentScoreBonus;
    }
  }
  const chosen=merged.sort((a,b)=>b.score-a.score||deeperFirst(a,b))[0]!;
  // Canonical, not merge order: provenance is compared across scans in the
  // shadow ledger, and a source list that reorders itself reads as a change.
  const rank:Record<EntryCandidateSource,number>={HEATMAP:0,SWING:1,EMA:2};
  chosen.sources.sort((a,b)=>rank[a]-rank[b]);
  return chosen;
}

/**
 * A full plan for a resting entry: the same stop/target/1.5R machinery as
 * makeOrderPlan, but anchored on the chosen level instead of the market
 * price — so the ratio that gets checked is the one the order will actually
 * have if it fills, not the one it would have had as a market entry.
 *
 * The idempotency key carries the level as well as the close, so a replaced
 * order at a moved level is a distinct order and a re-delivered outbox
 * message for the same level is not.
 */
export function makeRestingOrderPlan(input:{
  symbol:string;venueSymbol?:string;direction:Direction;closedAt:string;candidate:EntryCandidate;price:number;atr1h:number;
  regions:HeatmapRegion[];marginUsdc:number;leverage:number;
},rules:RestingEntrySettings=restingEntryDefaults):OrderPlan{
  const long=input.direction==="LONG";
  // The stop clears BOTH structures the entry leans on: a zone whose far edge
  // sits below the swing would otherwise leave the stop inside the zone.
  const anchors=[
    input.candidate.region?(long?input.candidate.region.lowPrice:input.candidate.region.highPrice):undefined,
    input.candidate.swing
  ].filter((value):value is number=>typeof value==="number"&&Number.isFinite(value));
  const plan=composePlan({
    idempotencyKey:createHash("sha256").update(`${input.symbol}|${input.direction}|${input.candidate.level.toPrecision(12)}|${input.closedAt}`).digest("hex"),
    symbol:input.symbol,direction:input.direction,entryPrice:input.candidate.level,
    structuralAnchor:anchors.length?(long?Math.min(...anchors):Math.max(...anchors)):undefined,
    atr1h:input.atr1h,regions:input.regions,marginUsdc:input.marginUsdc,leverage:input.leverage
  },rules);
  return {...plan,venueSymbol:input.venueSymbol,entryKind:"RESTING_LIMIT",entryProvenance:{
    sources:[...input.candidate.sources],score:input.candidate.score,level:input.candidate.level,
    referencePrice:input.price,atr1h:input.atr1h,
    bandNear:long?input.price-rules.entryBandAtrMin*input.atr1h:input.price+rules.entryBandAtrMin*input.atr1h,
    bandFar:long?input.price-rules.entryBandAtrMax*input.atr1h:input.price+rules.entryBandAtrMax*input.atr1h,
    region:input.candidate.region,swing:input.candidate.swing,ema:input.candidate.ema
  }};
}

export type RestingAction="PLACE"|"KEEP"|"REPLACE"|"CANCEL"|"NONE";
export interface WorkingRestingOrder{
  orderId:string;direction:Direction;level:number;stopLoss:number;
  /** Risk/reward recomputed at this order's level against the current structure. */
  recomputedRiskReward?:number;
}
export interface RevalidationInput{
  bias:BiasState;
  workingOrder?:WorkingRestingOrder|null;
  newPlan?:OrderPlan|null;
  /** The 15m close that triggered this revalidation. */
  closePrice:number;
  atr1h:number;
  /** False when the asset is paused, data is stale, warmup is incomplete or the risk gate rejected it. */
  tradable:boolean;
  blockedReasons?:string[];
  /** The asset's open FILLED_OPEN position, if any. */
  openPosition?:{orderId:string;direction:Direction}|null;
}

/**
 * The whole per-scan decision for one asset. KEEP is the important path: at
 * 15 assets x 96 scans a day, anything that replaces on noise instead of on
 * structure spends the entire day cancelling and re-placing.
 *
 * A bias flip returns REPLACE rather than CANCEL-then-PLACE-next-scan: the
 * agent's cancel_replace already sequences the cancel ahead of the new
 * submission, so this is the same two platform calls in the same order,
 * without leaving the asset unarmed for 15 minutes in between.
 */
export function revalidateWorkingOrder(input:RevalidationInput,settings:RestingEntrySettings=restingEntryDefaults):{action:RestingAction;plan?:OrderPlan;reason:string}{
  const working=input.workingOrder??null,plan=input.newPlan??null,position=input.openPosition??null;
  const drop=(reason:string)=>working?{action:"CANCEL" as const,reason}:{action:"NONE" as const,reason};
  if(!input.bias.direction)return drop("no armed direction bias this scan");
  if(!input.tradable)return drop(`asset not tradable this scan: ${(input.blockedReasons??["UNSPECIFIED"]).join(", ")}`);
  // Never stack: one working order per asset, and never a second entry on top
  // of a position the platform already nets into one aggregate.
  if(position?.direction===input.bias.direction)return drop(`an open ${input.bias.direction} position already exists on this asset`);
  // A filled position is not closed on a direction signal, only on its own
  // stop or target. Measured over the first six exits, reversal closes booked
  // an average of +0.25R against plans built for 1.6R and up, while the one
  // trade allowed to reach its stop paid the full -1R: cutting winners at a
  // quarter of the planned reward and letting losers run the whole distance is
  // a losing shape no matter how good the direction call is. The signal keeps
  // its say over orders that have not filled, where being wrong costs a cancel.
  if(position)return drop(`an open ${position.direction} position is left to its own stop and target; the ${input.bias.direction} signal only governs unfilled orders`);
  if(!working)return plan
    ?{action:"PLACE" as const,plan,reason:`new ${input.bias.direction} resting entry at ${plan.entryPrice} (${plan.entryProvenance?.sources.join("+")??"unknown"})`}
    :{action:"NONE" as const,reason:"no entry candidate inside the entry band this scan"};
  if(working.direction!==input.bias.direction)return plan
    ?{action:"REPLACE" as const,plan,reason:`bias flipped to ${input.bias.direction}; the resting ${working.direction} order is cancelled and re-placed at ${plan.entryPrice}`}
    :{action:"CANCEL" as const,reason:`bias flipped to ${input.bias.direction} and no ${input.bias.direction} candidate exists yet`};

  const long=working.direction==="LONG";
  const threshold=settings.replaceThresholdAtr*input.atr1h;
  const drift=plan?Math.abs(plan.entryPrice-working.level):0;
  const cause=(long?input.closePrice<=working.stopLoss:input.closePrice>=working.stopLoss)
    ?`the 15m close ${input.closePrice} crossed the working order's stop ${working.stopLoss}; the structure it leaned on is gone`
    :plan&&drift>threshold
      ?`the structural level moved from ${working.level} to ${plan.entryPrice}, past the ${Number(threshold.toPrecision(6))} hysteresis band`
      :working.recomputedRiskReward!==undefined&&working.recomputedRiskReward<fixedRules.minimumRiskReward-1e-9
        ?`risk/reward recomputed at the working level is ${Number(working.recomputedRiskReward.toPrecision(4))}, below ${fixedRules.minimumRiskReward}`
        :null;
  if(!plan)return {action:"CANCEL" as const,reason:cause?`${cause}; no replacement candidate inside the entry band`:"no entry candidate inside the entry band this scan"};
  if(cause)return {action:"REPLACE" as const,plan,reason:cause};
  return {action:"KEEP" as const,reason:`working order still inside the hysteresis band, above ${fixedRules.minimumRiskReward}R, structure intact`};
}

/**
 * Signal strength ranking for `maxArmedAssets`: resting orders may lock
 * margin platform-side (Phase 0 P0-2), so arming every asset at once would
 * park the account's whole initial margin in orders that never fill.
 */
export function limitArmedAssets<T extends{assetId:string;score:number}>(armed:T[],limit:number=restingEntryDefaults.maxArmedAssets):{kept:T[];dropped:T[]}{
  const ranked=[...armed].sort((a,b)=>b.score-a.score||a.assetId.localeCompare(b.assetId));
  return {kept:ranked.slice(0,limit),dropped:ranked.slice(limit)};
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
  // CANCELLED_REPLACED is terminal and distinct from CANCELLED_EXTERNALLY: the
  // resting model cancels its own working orders on purpose every time the
  // structure moves, and those must not read as platform-side failures.
  PENDING_ENTRY: ["FILLED_OPEN", "CANCELLED_EXTERNALLY", "CANCELLED_REPLACED", "CLOSED_REVERSED", "UNKNOWN", "RECONCILIATION_REQUIRED"],
  FILLED_OPEN: ["CLOSED_TP", "CLOSED_SL", "LIQUIDATED", "CLOSED_REVERSED", "RECONCILIATION_REQUIRED"],
  UNKNOWN: ["PENDING_ENTRY", "FILLED_OPEN", "CLOSED_TP", "CLOSED_SL", "LIQUIDATED", "CLOSED_REVERSED", "CANCELLED_EXTERNALLY", "SUBMISSION_FAILED", "RECONCILIATION_REQUIRED"],
  RECONCILIATION_REQUIRED: ["PENDING_ENTRY", "FILLED_OPEN", "CLOSED_TP", "CLOSED_SL", "LIQUIDATED", "CLOSED_REVERSED", "CANCELLED_EXTERNALLY", "UNKNOWN"]
};

export function assertOrderTransition(from: string, to: string) {
  if (!validOrderTransitions[from]?.includes(to)) throw new Error(`invalid order transition ${from} -> ${to}`);
}
