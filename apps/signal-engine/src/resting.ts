import { fixedRules } from "@huxtrade/config";
import { atr, ema, findAtrSwing, type Candle } from "@huxtrade/indicators";
import {
  biasDecision, biasStrength, chooseEntryLevel, limitArmedAssets, makeRestingOrderPlan,
  neutralBias, revalidateWorkingOrder,
  type BiasState, type RestingAction, type WorkingRestingOrder
} from "@huxtrade/strategy-engine";
import type { ConditionResult, Direction, HeatmapRegion, OrderPlan, RestingEntrySettings } from "@huxtrade/shared-types";

/** Everything one asset contributes to one 15-minute scan of the resting model. */
export interface RestingAssetInput{
  assetId:string;
  code:string;
  /** Variational's ticker for this asset, which is not always the Binance base. */
  venueSymbol?:string;
  closedAt:string;
  closePrice:number;
  previousBias:BiasState;
  /** Directions whose strategy conditions passed this scan. */
  passedDirections:Direction[];
  conditions:ConditionResult[];
  regions:HeatmapRegion[];
  candles:Candle[];
  workingOrder?:WorkingRestingOrder|null;
  openPosition?:{orderId:string;direction:Direction}|null;
  /** Structural health only — never the live-trading or session gates. */
  structurallyTradable:boolean;
  structuralBlockers:string[];
  /** Whether this asset may actually emit, i.e. mode=live and the full risk gate passed. */
  emitAllowed:boolean;
  emitBlockers:string[];
}

export interface RestingAssetDecision{
  assetId:string;
  code:string;
  /** Variational's ticker for this asset, which is not always the Binance base. */
  venueSymbol?:string;
  closedAt:string;
  bias:BiasState;
  biasReason:string;
  strength:number;
  action:RestingAction;
  plan?:OrderPlan;
  workingOrder?:WorkingRestingOrder|null;
  reason:string;
  mode:"shadow"|"live";
  /** Why a decision stayed shadow while the process runs live; empty when it emitted. */
  emitBlockers:string[];
}

/**
 * The 1h ATR/EMA/swing trio the entry model needs, from the candles the scan
 * already fetched. Returns null when the history is too short to trust any of
 * them, which reads downstream as "no candidate this scan" rather than as a
 * candidate priced off a half-warmed indicator.
 */
export function structureFrom(candles:Candle[],direction:Direction){
  const atrValue=atr(candles,14).at(-1);
  if(!atrValue||!Number.isFinite(atrValue)||atrValue<=0)return null;
  const emaValue=ema(candles.map((candle)=>candle.close),50).at(-1);
  let swing:number|null=null;
  try{swing=findAtrSwing(candles,atrValue,direction);}catch{swing=null;}
  return {atr1h:atrValue,ema:Number.isFinite(emaValue)?emaValue!:null,swing};
}

/**
 * Re-prices an existing working order against the current structure so
 * revalidateWorkingOrder can apply the 1.5R floor to where the order actually
 * sits — not to where it looked good when it was placed. A level whose
 * take-profit has since been swallowed by a new liquidation zone has to be
 * replaced even if it never moved.
 */
export function recomputeWorkingRiskReward(input:{
  working:WorkingRestingOrder;symbol:string;closedAt:string;atr1h:number;swing:number|null;
  regions:HeatmapRegion[];marginUsdc:number;leverage:number;settings:RestingEntrySettings;
}):number|undefined{
  try{
    return makeRestingOrderPlan({
      symbol:input.symbol,direction:input.working.direction,closedAt:input.closedAt,
      candidate:{level:input.working.level,score:0,sources:["SWING"],swing:input.swing??undefined},
      price:input.working.level,atr1h:input.atr1h,regions:input.regions,
      marginUsdc:input.marginUsdc,leverage:input.leverage
    },input.settings).expectedRiskReward;
  }catch{
    // Undefined, never 0. A plan that cannot be rebuilt at the working level —
    // no structure to anchor a stop, no zone ahead to aim at — is unknown, not
    // worthless, and returning 0 made revalidateWorkingOrder read every such
    // scan as "below 1.4" and replace the order. ARC churned through five
    // orders that each lived exactly one scan, with the hysteresis band and
    // the incumbency bonus both bypassed, because the trigger was this
    // sentinel rather than any move in price.
    return undefined;
  }
}

/**
 * One scan group (all assets sharing a closed_at), start to finish. Pure: the
 * caller does every read and every write, which is what keeps the whole
 * decision table testable without a database.
 *
 * The armed-asset cap is applied here rather than per asset because it is a
 * ranking, and a ranking needs the whole field. Assets trimmed out are forced
 * neutral so they cancel any working order instead of quietly keeping one
 * outside the cap.
 */
export function decideRestingScan(
  assets:RestingAssetInput[],
  options:{settings:RestingEntrySettings;mode:"shadow"|"live";marginUsdc:number;leverage:number}
):RestingAssetDecision[]{
  const armed=assets.map((asset)=>{
    const bias=biasDecision(asset.previousBias,{closedAt:asset.closedAt,passedDirections:asset.passedDirections},options.settings,asset.openPosition?.direction??null);
    return {asset,bias,strength:biasStrength(asset.conditions)};
  });
  // The cap is a LIVE resource constraint — resting orders may lock margin
  // platform-side — so only assets that could actually emit compete for it. A
  // shadow decision costs nothing on the venue, and letting one displace a
  // tradeable asset meant a retired ticker could silently push a live one out
  // of the book.
  const eligible=armed.filter((entry)=>entry.bias.direction!==null&&entry.asset.emitAllowed);
  const {dropped}=limitArmedAssets(eligible.map((entry)=>({assetId:entry.asset.assetId,score:entry.strength})),options.settings.maxArmedAssets);
  const trimmed=new Set(dropped.map((entry)=>entry.assetId));

  return armed.map(({asset,bias,strength})=>{
    const capped=trimmed.has(asset.assetId);
    const effectiveBias:BiasState=capped?neutralBias:{direction:bias.direction,armedAt:bias.armedAt,armedUntil:bias.armedUntil};
    const structure=effectiveBias.direction?structureFrom(asset.candles,effectiveBias.direction):null;
    let plan:OrderPlan|undefined;
    let planRejection:string|undefined;
    if(effectiveBias.direction&&structure){
      const candidate=chooseEntryLevel({
        direction:effectiveBias.direction,price:asset.closePrice,atr1h:structure.atr1h,
        ema:structure.ema,swing:structure.swing,regions:asset.regions,
        // Only the incumbent on the SAME side: a flipped bias has no incumbent.
        incumbentLevel:asset.workingOrder?.direction===effectiveBias.direction?asset.workingOrder.level:null
      },options.settings);
      if(candidate){
        try{
          plan=makeRestingOrderPlan({
            symbol:asset.code,venueSymbol:asset.venueSymbol,direction:effectiveBias.direction,closedAt:asset.closedAt,candidate,
            price:asset.closePrice,atr1h:structure.atr1h,regions:asset.regions,
            marginUsdc:options.marginUsdc,leverage:options.leverage
          },options.settings);
        }catch(error){plan=undefined;planRejection=error instanceof Error?error.message:String(error);}
      }
    }
    const working=asset.workingOrder??null;
    const decision=revalidateWorkingOrder({
      bias:effectiveBias,
      workingOrder:working&&structure?{...working,recomputedRiskReward:recomputeWorkingRiskReward({
        working,symbol:asset.code,closedAt:asset.closedAt,atr1h:structure.atr1h,swing:structure.swing,
        regions:asset.regions,marginUsdc:options.marginUsdc,leverage:options.leverage,settings:options.settings
      })}:working,
      newPlan:plan,closePrice:asset.closePrice,atr1h:structure?.atr1h??0,
      tradable:asset.structurallyTradable,blockedReasons:asset.structuralBlockers,
      openPosition:asset.openPosition
    },options.settings);
    return {
      assetId:asset.assetId,code:asset.code,closedAt:asset.closedAt,
      // The persisted bias is the real one, not the capped one: the cap only
      // suppresses acting this scan, it does not un-arm the direction, so the
      // asset resumes normally as soon as a stronger one stands down.
      bias:{direction:bias.direction,armedAt:bias.armedAt,armedUntil:bias.armedUntil,pendingFlipDirection:bias.pendingFlipDirection??null,pendingFlipCount:bias.pendingFlipCount??0},
      biasReason:capped?`${bias.reason}; suppressed this scan by the ${options.settings.maxArmedAssets}-asset arming cap`:bias.reason,
      strength,action:decision.action,plan:decision.plan,
      workingOrder:working,
      // A rejected plan is the interesting case now that there is no fallback:
      // "no candidate" and "the peak only paid 1.1x" are different findings.
      reason:planRejection&&!decision.plan?`${decision.reason} — ${planRejection}`:decision.reason,
      // The ledger records what would really have happened to THIS asset: a
      // decision that could not have been emitted is a shadow row even when
      // the process is running live.
      mode:options.mode==="live"&&asset.emitAllowed?"live":"shadow",
      emitBlockers:options.mode==="live"&&asset.emitAllowed?[]:[...(options.mode==="live"?[]:["STRATEGY_EXECUTION_MODE_SHADOW"]),...asset.emitBlockers]
    };
  });
}

/** Actions that put a message on the wire; everything else is ledger-only. */
export const emittingActions:RestingAction[]=["PLACE","REPLACE","CANCEL"];

export function restingOutboxMessage(decision:RestingAssetDecision,context:{strategyId:string;signalId:string|null}){
  if(decision.mode!=="live"||!emittingActions.includes(decision.action))return null;
  const base={assetId:decision.assetId,strategyId:context.strategyId,signalId:context.signalId,closedAt:decision.closedAt,reason:decision.reason};
  if(decision.action==="PLACE"&&decision.plan)return {topic:"order.place_resting",payload:{...base,plan:decision.plan}};
  if(decision.action==="REPLACE"&&decision.plan&&decision.workingOrder)return {topic:"order.cancel_replace",payload:{...base,oldOrderId:decision.workingOrder.orderId,plan:decision.plan}};
  if(decision.action==="CANCEL"&&decision.workingOrder)return {topic:"order.cancel_working",payload:{...base,orderId:decision.workingOrder.orderId}};
  return null;
}

export const scanMs=fixedRules.scanMinutes*60_000;
