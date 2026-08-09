import { fixedRules } from "@huxtrade/config";
import { classifyExitByPrice } from "@huxtrade/strategy-engine";
import type { AppConfig } from "@huxtrade/config";
import type { OrderPlan } from "@huxtrade/shared-types";
import type {
  PlatformEntry,PlatformEntryState,PlatformFillSnapshot,PlatformPositionSnapshot,
  PlatformProtection,PlatformTrackedOrder,ProtectionAdapter
} from "./execution.js";

export interface OmniTransport{
  request(path:string,init?:{method?:"GET"|"POST";body?:unknown}):Promise<unknown>;
  close?():Promise<void>;
}

export interface VariationalAdapter extends ProtectionAdapter{
  sessionValid():Promise<boolean>;
  account():Promise<{balanceUsdc:number;marginUsagePercent:number}>;
  minimumMargin(plan:OrderPlan):Promise<number>;
  listTracked(orders:TrackedOrderRef[]):Promise<PlatformTrackedOrder[]>;
  cancelPending():Promise<Array<{id:string;cancelled:boolean}>>;
  /** How many active TP/SL orders the instrument currently holds. Variational allows exactly one pair. */
  activeProtectionCount(symbol:string):Promise<number>;
  /** Settlement of a close WE initiated, looked up by its own rfq id. */
  closeSettlement(closeRfqId:string):Promise<{realizedPnl?:number;fill?:PlatformFillSnapshot}>;
  /** Reduces a position by a fraction of this order's own share, leaving the auto-resizing TP/SL to follow it down. */
  closeMarketPartial(entryId:string,fraction:number):Promise<{closed:boolean;rfqId?:string;quantity?:number;remaining?:number;alreadyClosed?:boolean;tooSmall?:boolean;raw:unknown}>;
  /** Cancels one leg of the TP/SL pair without disturbing the other. */
  cancelProtection(symbol:string,kind:"take_profit"|"stop_loss"):Promise<{cancelled:number}>;
  /** Arms a protection order on an instrument that already holds a position. */
  placeProtection(input:{symbol:string;kind:"take_profit"|"stop_loss";direction:"LONG"|"SHORT";triggerPrice:number}):Promise<{id:string;triggerPrice:string;raw:unknown}>;
  /** Drops any cached quote/quantity for this plan so a retried submitEntry fetches fresh market data instead of resubmitting what may have just been rejected. */
  forgetPreparation?(idempotencyKey:string):void;
  close?():Promise<void>;
}

type JsonRecord=Record<string,unknown>;
type Instrument={instrument_type:"perpetual_future";underlying:string;funding_interval_s:3600;settlement_asset:"USDC"};
export type QuantizedPrices={entryPrice:string;takeProfit:string;stopLoss:string;decimals:number;expectedRiskReward:number};
type PreparedOrder={plan:OrderPlan;instrument:Instrument;side:"buy"|"sell";qty:string;quote:JsonRecord;prices:QuantizedPrices};
type Submission={prepared:PreparedOrder;response:JsonRecord};

/**
 * What reconciliation knows locally about an order it is asking about. The
 * levels travel with the id so an exit can be attributed by where it printed
 * when the venue's own rfq attribution comes up empty.
 */
export interface TrackedOrderRef{
  id:string;
  direction?:"LONG"|"SHORT";
  entryPrice?:number;
  stopLoss?:number;
  takeProfit?:number;
  /** Set once a scale-out moved the survivor's stop; replaces stopLoss as the level to test. */
  breakevenStop?:number|null;
}

const isRecord=(value:unknown):value is JsonRecord=>Boolean(value)&&typeof value==="object"&&!Array.isArray(value);
const record=(value:unknown,label:string):JsonRecord=>{if(!isRecord(value))throw new Error(`Invalid Variational ${label} response`);return value;};
const array=(value:unknown,label:string):JsonRecord[]=>{if(!Array.isArray(value)||!value.every(isRecord))throw new Error(`Invalid Variational ${label} response`);return value;};
const string=(value:unknown,label:string)=>{if(typeof value!=="string"||!value)throw new Error(`Missing Variational ${label}`);return value;};
const number=(value:unknown,label:string)=>{const parsed=typeof value==="number"?value:Number(value);if(!Number.isFinite(parsed))throw new Error(`Invalid Variational ${label}`);return parsed;};
const optionalNumber=(value:unknown)=>{const parsed=Number(value);return Number.isFinite(parsed)?parsed:undefined;};
const positiveString=(value:number,label:string)=>{if(!Number.isFinite(value)||value<=0)throw new Error(`${label} must be a positive finite number`);return value.toLocaleString("en-US",{useGrouping:false,maximumSignificantDigits:15});};
const underlyingFor=(symbol:string)=>symbol.toUpperCase().replace(/USDT$/i,"");
const instrumentFor=(symbol:string):Instrument=>({instrument_type:"perpetual_future",underlying:underlyingFor(symbol),funding_interval_s:3600,settlement_asset:"USDC"});
const instrumentKey=(value:unknown)=>{const item=isRecord(value)?value:{};return `${item.instrument_type??""}:${item.underlying??""}:${item.funding_interval_s??""}:${item.settlement_asset??""}`;};
const sameInstrument=(a:unknown,b:unknown)=>instrumentKey(a)===instrumentKey(b);
const delay=(ms:number)=>new Promise((resolve)=>setTimeout(resolve,ms));

function decimals(value:string){const normalized=value.toLowerCase();if(normalized.includes("e-"))return Number(normalized.split("e-")[1]??0);return (normalized.split(".")[1]??"").length;}
function floorToTick(value:number,tick:string){
  const places=decimals(tick),scale=10**places,tickUnits=Math.round(Number(tick)*scale);
  if(!Number.isFinite(value)||!Number.isFinite(scale)||tickUnits<=0)throw new Error("Invalid Variational quantity tick");
  const units=Math.floor((value*scale+1e-9)/tickUnits)*tickUnits;
  return (units/scale).toFixed(places);
}

/**
 * Omni exposes no explicit price tick. The indicative quote returns `bid`/`ask`
 * as decimal strings whose scale is the instrument's *tradeable* price
 * precision, so that observed scale is the authoritative source. `mark_price`
 * and `index_price` are deliberately ignored: they are computed values carried
 * at full precision and would defeat the quantization entirely.
 */
export function priceDecimalsFromQuote(quote:JsonRecord){
  const observed=["bid","ask"]
    .map((key)=>quote[key])
    .filter((value):value is string=>typeof value==="string"&&Number.isFinite(Number(value)))
    .map(decimals);
  if(!observed.length)throw new Error("Variational quote exposes no tradeable price scale");
  return Math.min(12,Math.max(...observed));
}

function roundToDecimals(value:number,places:number,mode:"floor"|"ceil"){
  const scale=10**places;
  const scaled=value*scale;
  const units=mode==="floor"?Math.floor(scaled+1e-9):Math.ceil(scaled-1e-9);
  return (units/scale).toFixed(places);
}

/**
 * Spec 8.2 requires requests to respect the platform's price precision.
 * Rounding is always conservative: the entry never improves on the signal
 * price, the stop stays outside the structure, and the target never overstates
 * itself. The resulting ratio is re-verified against the same floor the plan
 * was built to, so quantization can never smuggle a sub-floor order onto the
 * platform. With the margin-fraction fallback gone there is no headroom above
 * the floor any more, so a plan built at exactly the floor can legitimately
 * fail here — that is the guard working, not a defect.
 */
export function quantizePlanPrices(plan:OrderPlan,places:number):QuantizedPrices{
  const long=plan.direction==="LONG";
  const entryPrice=roundToDecimals(plan.entryPrice,places,long?"floor":"ceil");
  const stopLoss=roundToDecimals(plan.stopLoss,places,long?"floor":"ceil");
  const takeProfit=roundToDecimals(plan.takeProfit,places,long?"floor":"ceil");
  const entry=Number(entryPrice),stop=Number(stopLoss),target=Number(takeProfit);
  if(!(entry>0)||!(stop>0)||!(target>0))throw new Error("Variational price quantization produced a non-positive price");
  const risk=long?entry-stop:stop-entry;
  const reward=long?target-entry:entry-target;
  if(!(risk>0))throw new Error("Variational price quantization collapsed the stop-loss distance");
  const expectedRiskReward=reward/risk;
  if(expectedRiskReward<fixedRules.minimumRiskReward-1e-9)throw new Error(`quantized risk/reward ${expectedRiskReward.toFixed(3)} is below ${fixedRules.minimumRiskReward} at ${places} price decimals`);
  return {entryPrice,takeProfit,stopLoss,decimals:places,expectedRiskReward};
}

function asPlan(value:Record<string,unknown>):OrderPlan{
  const plan=value as unknown as OrderPlan;
  if(typeof plan.idempotencyKey!=="string"||typeof plan.symbol!=="string"||!['LONG','SHORT'].includes(plan.direction))throw new Error("Invalid order plan");
  for(const key of ["entryPrice","stopLoss","takeProfit","marginUsdc","leverage","notionalUsdc"] as const)if(!Number.isFinite(plan[key])||plan[key]<=0)throw new Error(`Invalid order plan ${key}`);
  return plan;
}

function resultRows(value:unknown,label:string){const page=record(value,label);return array(page.result,label);}
function statusOf(order:JsonRecord){return String(order.status??"").toLowerCase();}
function typeOf(order:JsonRecord){return String(order.order_type??"").toLowerCase();}

export class OmniBrowserAdapter implements VariationalAdapter{
  private readonly prepared=new Map<string,PreparedOrder>();
  private readonly submissions=new Map<string,Submission>();
  constructor(private readonly transport:OmniTransport,private readonly config:Pick<AppConfig,"VARIATIONAL_ENTRY_SLIPPAGE"|"VARIATIONAL_PROTECTION_SLIPPAGE"|"VARIATIONAL_CLOSE_SLIPPAGE">){}

  async close(){await this.transport.close?.();}

  forgetPreparation(idempotencyKey:string){this.prepared.delete(idempotencyKey);}

  async sessionValid(){
    try{await this.account();return true;}catch{return false;}
  }

  async account(){
    const portfolio=record(await this.transport.request("/api/portfolio?compute_margin=true"),"portfolio");
    const usage=record(portfolio.margin_usage,"portfolio margin usage");
    const balanceUsdc=number(portfolio.balance,"portfolio balance");
    const upnl=optionalNumber(portfolio.upnl)??0;
    const initialMargin=Math.max(0,number(usage.initial_margin,"initial margin"));
    const equity=balanceUsdc+upnl;
    const marginUsagePercent=equity>0?Math.min(100,initialMargin/equity*100):initialMargin>0?100:0;
    return {balanceUsdc,marginUsagePercent};
  }

  private async currentLeverage(asset:string){
    const response=record(await this.transport.request("/api/settlement_pools/leverage",{method:"POST",body:{assets:[asset]}}),"leverage");
    return number(record(response[asset],`${asset} leverage`).current,"current leverage");
  }

  /**
   * `set_leverage`'s response shape is unverified (see the read-only discovery
   * doc), so its body is never trusted. Instead the fix is confirmed through
   * the already-verified read path: set, then re-read, and only proceed if
   * the platform actually reflects the requested value. Still fails closed if
   * the re-read shows the set didn't take.
   */
  private async verifyLeverage(plan:OrderPlan,instrument:Instrument){
    const current=await this.currentLeverage(instrument.underlying);
    if(current===plan.leverage)return;
    await this.transport.request("/api/settlement_pools/set_leverage",{method:"POST",body:{asset:instrument.underlying,leverage:plan.leverage}});
    const updated=await this.currentLeverage(instrument.underlying);
    if(updated!==plan.leverage)throw new Error(`Variational leverage for ${instrument.underlying} is ${updated}x after attempting to set ${plan.leverage}x`);
  }

  private async indicative(instrument:Instrument,qty:string){return record(await this.transport.request("/api/quotes/indicative",{method:"POST",body:{instrument,qty}}),"indicative quote");}

  private async prepare(plan:OrderPlan){
    const cached=this.prepared.get(plan.idempotencyKey);if(cached)return cached;
    const instrument=instrumentFor(plan.venueSymbol??plan.symbol),side:PreparedOrder["side"]=plan.direction==="LONG"?"buy":"sell";
    await this.verifyLeverage(plan,instrument);
    const targetQty=plan.notionalUsdc/plan.entryPrice;
    let qty=positiveString(targetQty,"order quantity"),quote=await this.indicative(instrument,qty);
    const limits=record(record(quote.qty_limits,"quote quantity limits")[side==="buy"?"ask":"bid"],"side quantity limits");
    const tick=string(limits.min_qty_tick,"minimum quantity tick"),minimum=number(limits.min_qty,"minimum quantity");
    let quantized=floorToTick(targetQty,tick);
    if(Number(quantized)<minimum)quantized=floorToTick(minimum+Number(tick),tick);
    if(quantized!==qty){qty=quantized;quote=await this.indicative(instrument,qty);}
    const prices=quantizePlanPrices(plan,priceDecimalsFromQuote(quote));
    const prepared={plan,instrument,side,qty,quote,prices};this.prepared.set(plan.idempotencyKey,prepared);return prepared;
  }

  async minimumMargin(plan:OrderPlan){
    const prepared=await this.prepare(plan),limits=record(record(prepared.quote.qty_limits,"quote quantity limits")[prepared.side==="buy"?"ask":"bid"],"side quantity limits");
    const minimum=number(limits.min_qty,"minimum quantity"),price=number(prepared.side==="buy"?prepared.quote.ask:prepared.quote.bid,"quote price");
    return minimum*price/plan.leverage;
  }

  async submitEntry(value:Record<string,unknown>,options?:{skipProtection?:boolean}):Promise<PlatformEntry>{
    const plan=asPlan(value),prepared=await this.prepare(plan);
    const {entryPrice,takeProfit,stopLoss}=prepared.prices;
    // Variational allows only one TP/SL pair per instrument, created as part
    // of this same request (placeTakeProfit/placeStopLoss don't call the API
    // at all — they just read the ids back off this response). Omitting
    // these fields, not just skipping the read-back, is what actually avoids
    // Variational rejecting a second pair on an instrument that already has
    // one: leaving them in unconditionally caused every skipProtection order
    // to fail with HTTP 400.
    const protection=options?.skipProtection?{}:{
      take_profit:takeProfit,tp_is_auto_resize:true,tp_use_mark_price:true,tp_slippage_limit:this.config.VARIATIONAL_PROTECTION_SLIPPAGE.toString(),
      stop_loss:stopLoss,sl_is_auto_resize:true,sl_use_mark_price:true,sl_slippage_limit:this.config.VARIATIONAL_PROTECTION_SLIPPAGE.toString()
    };
    const body={
      order_type:"limit",limit_price:entryPrice,side:prepared.side,
      instrument:prepared.instrument,qty:prepared.qty,slippage_limit:this.config.VARIATIONAL_ENTRY_SLIPPAGE.toString(),
      is_auto_resize:false,use_mark_price:false,
      ...protection,
      is_reduce_only:false
    };
    const response=record(await this.transport.request("/api/orders/new/limit",{method:"POST",body}),"limit order");
    const id=string(response.rfq_id,"entry RFQ ID");
    this.submissions.set(id,{prepared,response});
    return {id,state:"PENDING_ENTRY",quantity:Number(prepared.qty),submittedPrices:prepared.prices,raw:response};
  }

  async placeTakeProfit(entry:PlatformEntry,_plan:OrderPlan):Promise<PlatformProtection>{
    const response=this.submissions.get(entry.id)?.response??entry.raw;
    return {id:string(response.take_profit_rfq_id,"take-profit RFQ ID"),raw:response};
  }

  async placeStopLoss(entry:PlatformEntry,_plan:OrderPlan):Promise<PlatformProtection>{
    const response=this.submissions.get(entry.id)?.response??entry.raw;
    return {id:string(response.stop_loss_rfq_id,"stop-loss RFQ ID"),raw:response};
  }

  private async pendingOrders(){return resultRows(await this.transport.request("/api/orders/v2?status=pending&limit=100&offset=0&order_by=created_at&order=desc"),"pending orders");}
  private async orderHistory(){return resultRows(await this.transport.request("/api/orders/v2?limit=100&offset=0&order_by=created_at&order=desc"),"order history");}
  private async positions(){return array(await this.transport.request("/api/positions"),"positions");}
  private async trades(){return resultRows(await this.transport.request("/api/trades?limit=100&offset=0&order_by=created_at&order=desc"),"trades");}
  private async transfers(){return resultRows(await this.transport.request("/api/transfers?limit=100&offset=0&order_by=created_at&order=desc"),"transfers");}

  private async stateSnapshot(entryId:string){
    const [pending,orders,positions,trades]=await Promise.all([this.pendingOrders(),this.orderHistory(),this.positions(),this.trades()]);
    const pendingEntry=pending.find((item)=>item.rfq_id===entryId);
    if(pendingEntry)return {state:"PENDING_ENTRY" as const,raw:pendingEntry,pending,orders,positions,trades};
    const entryTrade=trades.find((item)=>item.source_rfq===entryId);
    if(entryTrade){
      const position=positions.find((item)=>sameInstrument(record(item.position_info,"position info").instrument,entryTrade.instrument));
      if(position)return {state:"FILLED_OPEN" as const,raw:position,entryTrade,pending,orders,positions,trades};
    }
    const historical=orders.find((item)=>item.rfq_id===entryId);
    if(historical&&["canceled","cancelled","rejected"].includes(statusOf(historical)))return {state:"CANCELLED_EXTERNALLY" as const,raw:historical,entryTrade,pending,orders,positions,trades};
    // Order history is the 100 most recently CREATED orders, so an entry that
    // has been resting for hours is long past the end of that page and cannot
    // be found there even when it was cancelled seconds ago — which stranded a
    // 6-hour-old UNI order in UNKNOWN. Reason from absence instead: this is
    // only reached right after acting on an order that was working moments
    // ago, so a fill would be among the newest trades. Not working and never
    // traded leaves exactly one possibility.
    if(!entryTrade)return {state:"CANCELLED_EXTERNALLY" as const,raw:historical??{inferred:"not pending and no fill in the recent trade window"},entryTrade,pending,orders,positions,trades};
    return {state:"UNKNOWN" as const,raw:historical??entryTrade??{},entryTrade,pending,orders,positions,trades};
  }

  async orderState(entryId:string):Promise<PlatformEntryState>{return (await this.stateSnapshot(entryId)).state;}

  async cancelEntry(entryId:string){
    const response=await this.transport.request("/api/orders/cancel",{method:"POST",body:{rfq_id:entryId}}),raw=isRecord(response)?response:{response};
    let state:PlatformEntryState="UNKNOWN";
    for(let attempt=0;attempt<5;attempt++){state=await this.orderState(entryId);if(state!=="PENDING_ENTRY")break;await delay(300);}
    return {cancelled:state==="CANCELLED_EXTERNALLY",state,raw};
  }

  async cancelOrder(orderId:string){await this.transport.request("/api/orders/cancel",{method:"POST",body:{rfq_id:orderId}});}

  /**
   * Variational arms an entry's TP/SL the moment the entry is accepted, not
   * when it fills — they show up immediately as active reduce-only orders —
   * and it reaps them asynchronously, tens of seconds AFTER a cancel has
   * already been confirmed. Since the platform allows exactly one pair per
   * instrument, a submission that follows a cancel too closely is rejected
   * outright. Callers poll this to wait for the slot to actually free up.
   * (Phase 0 P0-3: observed 2 orphans right after cancel, 0 a minute later.)
   */
  async activeProtectionCount(symbol:string){
    const instrument=instrumentFor(symbol);
    return (await this.pendingOrders()).filter((order)=>
      ["take_profit","stop_loss"].includes(typeOf(order))&&sameInstrument(order.instrument,instrument)).length;
  }

  async cancelPending(){
    const entries=(await this.pendingOrders()).filter((item)=>typeOf(item)==="limit"&&item.is_reduce_only!==true);
    return Promise.all(entries.map(async(item)=>{const id=string(item.rfq_id,"pending RFQ ID");try{await this.cancelOrder(id);return {id,cancelled:true};}catch{return {id,cancelled:false};}}));
  }

  /**
   * Variational nets every order on an instrument into one aggregate position
   * and offers no per-order exit attribution, so listTracked has to guess an
   * exit from instrument-level state — and it guesses wrong for an order we
   * closed ourselves while another position is still open on the same
   * instrument. The close we initiated has its own rfq id, though, and both
   * the resulting trade and its realized-PnL transfer carry it, which makes
   * the attribution exact instead of heuristic.
   */
  async closeSettlement(closeRfqId:string){
    const [trades,transfers]=await Promise.all([this.trades(),this.transfers()]);
    const trade=trades.find((item)=>item.source_rfq===closeRfqId);
    const transfer=transfers.find((item)=>item.rfq_id===closeRfqId&&item.transfer_type==="realized_pnl");
    const realizedPnl=transfer?optionalNumber(transfer.qty):undefined;
    return {realizedPnl,fill:trade?this.fillSnapshot(trade,realizedPnl):undefined};
  }

  private positionData(item:JsonRecord):{info:JsonRecord;instrument:unknown;qty:number}{const info=record(item.position_info,"position info");return {info,instrument:info.instrument,qty:number(info.qty,"position quantity")};}

  async closeMarket(entryId:string){
    const cached=this.submissions.get(entryId),[positions,trades]=await Promise.all([this.positions(),this.trades()]);
    const entryTrade=trades.find((item)=>item.source_rfq===entryId);
    const instrument=cached?.prepared.instrument??(entryTrade?.instrument as Instrument|undefined);
    const targetQty=cached?Number(cached.prepared.qty):entryTrade?number(entryTrade.qty,"entry trade quantity"):undefined;
    if(!instrument||!targetQty)throw new Error("Cannot identify the Variational entry quantity for emergency close");
    const position=positions.find((item)=>sameInstrument(this.positionData(item).instrument,instrument));
    if(!position)return {closed:true,raw:{alreadyClosed:true}};
    const before=this.positionData(position),closeQty=Math.min(Math.abs(before.qty),Math.abs(targetQty)),qty=positiveString(closeQty,"close quantity");
    const quote=await this.indicative(instrument,qty),side=before.qty>0?"sell":"buy";
    const response=record(await this.transport.request("/api/quotes/accept",{method:"POST",body:{quote_id:string(quote.quote_id,"close quote ID"),side,max_slippage:this.config.VARIATIONAL_CLOSE_SLIPPAGE,is_reduce_only:true}}),"close quote acceptance");
    string(response.rfq_id,"close RFQ ID");
    for(let attempt=0;attempt<10;attempt++){
      await delay(500);
      const after=(await this.positions()).find((item)=>sameInstrument(this.positionData(item).instrument,instrument));
      if(!after||Math.abs(this.positionData(after).qty)<=Math.max(0,Math.abs(before.qty)-closeQty)+1e-12)return {closed:true,raw:response};
    }
    return {closed:false,raw:response};
  }

  /**
   * Closes part of a position and hands back the close's own rfq id so the
   * realised amount can be attributed exactly (closeSettlement) rather than
   * inferred from instrument-level state, which nets every order together.
   *
   * The surviving TP/SL need no resizing: both are created with
   * `is_auto_resize:true` and carry `qty:null`, so they follow the position
   * down to whatever is left. Verified on the venue: reducing at market leaves
   * the take-profit in place.
   */
  async closeMarketPartial(entryId:string,fraction:number){
    if(!(fraction>0&&fraction<1))throw new Error("A partial close fraction must sit strictly between 0 and 1");
    const cached=this.submissions.get(entryId),[positions,trades]=await Promise.all([this.positions(),this.trades()]);
    const entryTrade=trades.find((item)=>item.source_rfq===entryId);
    const instrument=cached?.prepared.instrument??(entryTrade?.instrument as Instrument|undefined);
    const entryQty=cached?Number(cached.prepared.qty):entryTrade?number(entryTrade.qty,"entry trade quantity"):undefined;
    if(!instrument||!entryQty)throw new Error("Cannot identify the Variational entry quantity for a partial close");
    const position=positions.find((item)=>sameInstrument(this.positionData(item).instrument,instrument));
    if(!position)return {closed:false,alreadyClosed:true,raw:{alreadyClosed:true}};
    const before=this.positionData(position),side:"buy"|"sell"=before.qty>0?"sell":"buy";
    // Never reduce by more than this order's own share of the aggregate: on a
    // stacked instrument the position belongs to several orders at once.
    const wanted=Math.min(Math.abs(before.qty),Math.abs(entryQty))*fraction;
    const sized=await this.indicative(instrument,positiveString(Math.abs(before.qty),"position quantity"));
    const limits=record(record(sized.qty_limits,"quote quantity limits")[side==="sell"?"bid":"ask"],"side quantity limits");
    const closeQty=Number(floorToTick(wanted,string(limits.min_qty_tick,"minimum quantity tick")));
    // Rounding down can land on zero, or leave a remainder the venue would
    // refuse as a dust position. Either way there is no partial to take.
    if(!(closeQty>0)||closeQty<number(limits.min_qty,"minimum quantity"))return {closed:false,tooSmall:true,raw:{wanted,closeQty}};
    if(Math.abs(before.qty)-closeQty<number(limits.min_qty,"minimum quantity"))return {closed:false,tooSmall:true,raw:{wanted,closeQty,remainderBelowMinimum:true}};
    const qty=positiveString(closeQty,"partial close quantity");
    const quote=await this.indicative(instrument,qty);
    const response=record(await this.transport.request("/api/quotes/accept",{method:"POST",body:{quote_id:string(quote.quote_id,"close quote ID"),side,max_slippage:this.config.VARIATIONAL_CLOSE_SLIPPAGE,is_reduce_only:true}}),"partial close acceptance");
    const rfqId=string(response.rfq_id,"partial close RFQ ID");
    for(let attempt=0;attempt<10;attempt++){
      await delay(500);
      const after=(await this.positions()).find((item)=>sameInstrument(this.positionData(item).instrument,instrument));
      const remaining=after?Math.abs(this.positionData(after).qty):0;
      if(remaining<=Math.abs(before.qty)-closeQty+1e-12)return {closed:true,rfqId,quantity:closeQty,remaining,raw:response};
    }
    return {closed:false,rfqId,quantity:closeQty,raw:response};
  }

  /** The instrument's live protection orders, read from the pending list — never from the history page. */
  private async protectionOrders(instrument:Instrument){
    return (await this.pendingOrders()).filter((order)=>
      ["take_profit","stop_loss"].includes(typeOf(order))&&sameInstrument(order.instrument,instrument));
  }

  /** Cancels just one leg of the pair. Verified on the venue: cancelling the stop leaves the take-profit working. */
  async cancelProtection(symbol:string,kind:"take_profit"|"stop_loss"){
    const instrument=instrumentFor(symbol);
    const existing=(await this.protectionOrders(instrument)).filter((order)=>typeOf(order)===kind);
    for(const order of existing)await this.cancelOrder(string(order.rfq_id,"protection RFQ ID"));
    return {cancelled:existing.length};
  }

  /**
   * Creates a standalone protection order on an instrument that already holds
   * a position. Everything else in this adapter creates TP/SL as fields on the
   * entry submission, so this is the one path that arms a stop without opening
   * anything — needed to move a stop to breakeven, since Variational offers no
   * amend-in-place and the slot must be cancelled and re-taken.
   *
   * Shaped from a real protection order read back off the venue: order_type
   * names the leg, the level travels as `trigger_price`, and `qty` is absent
   * because `is_auto_resize` makes it follow the position.
   */
  async placeProtection(input:{symbol:string;kind:"take_profit"|"stop_loss";direction:"LONG"|"SHORT";triggerPrice:number}){
    const instrument=instrumentFor(input.symbol);
    // A protection order closes the position, so it takes the opposite side.
    const side:"buy"|"sell"=input.direction==="LONG"?"sell":"buy";
    const quote=await this.indicative(instrument,positiveString(1,"probe quantity"));
    const triggerPrice=roundToDecimals(input.triggerPrice,priceDecimalsFromQuote(quote),input.direction==="LONG"?"floor":"ceil");
    const response=record(await this.transport.request("/api/orders/new/limit",{method:"POST",body:{
      order_type:input.kind,trigger_price:triggerPrice,side,instrument,
      is_reduce_only:true,is_auto_resize:true,use_mark_price:true,
      slippage_limit:this.config.VARIATIONAL_PROTECTION_SLIPPAGE.toString(),tif:"good_til_canceled"
    }}),`${input.kind} order`);
    return {id:string(response.rfq_id,"protection RFQ ID"),triggerPrice,raw:response};
  }

  private positionSnapshot(item:JsonRecord,protections:JsonRecord[]):PlatformPositionSnapshot{
    const data=this.positionData(item),rawInfo=data.info,price=record(item.price_info,"position price info");
    const tp=protections.find((order)=>typeOf(order)==="take_profit"),sl=protections.find((order)=>typeOf(order)==="stop_loss");
    return {
      id:`${String(rawInfo.company??"")}:${String(rawInfo.pool_location??"")}:${instrumentKey(data.instrument)}`,
      quantity:Math.abs(data.qty),entryPrice:number(rawInfo.avg_entry_price,"average entry price"),openedAt:string(rawInfo.opened_at,"position opened time"),
      takeProfit:tp?optionalNumber(tp.trigger_price):undefined,stopLoss:sl?optionalNumber(sl.trigger_price):undefined,
      unrealizedPnl:optionalNumber(item.upnl),realizedPnl:optionalNumber(item.rpnl),raw:{...item,mark_price:price.price}
    };
  }

  /**
   * Variational's RFQ model charges no explicit taker fee — fee_type,
   * fee_bucket and fee_status are null on every observed transfer — so the
   * real execution cost is the spread paid against the instrument's mark
   * price at fill time, and that is what `fee` records (positive = paid to
   * cross the spread). Hourly funding settles through separate transfers and
   * is deliberately not part of this number.
   */
  private fillSnapshot(trade:JsonRecord,realizedPnl?:number):PlatformFillSnapshot{
    const side=string(trade.side,"trade side"),price=number(trade.price,"trade price"),quantity=number(trade.qty,"trade quantity");
    const mark=optionalNumber(trade.mark_price);
    const fee=mark===undefined?undefined:(side==="buy"?price-mark:mark-price)*Math.abs(quantity);
    return {id:string(trade.id,"trade ID"),side,price,quantity,filledAt:string(trade.created_at,"trade time"),fee,realizedPnl,raw:trade};
  }

  /**
   * Variational nets everything on an instrument into one aggregate position,
   * while each local order is its own positions row. Persisting the
   * aggregate's quantity/PnL onto every stacked order would multiply-count it
   * (4 stacked orders x the full aggregate = 4x the real exposure — exactly
   * what inflated the dashboard before this existed), so each order gets its
   * quantity-proportional share instead. The shares of all stacked orders sum
   * back to the platform's own aggregate values, and the entry price is the
   * order's own fill rather than the aggregate average.
   */
  private apportionPosition(aggregate:PlatformPositionSnapshot,entryTrade:JsonRecord):PlatformPositionSnapshot{
    const orderQty=Math.abs(number(entryTrade.qty,"trade quantity"));
    const share=aggregate.quantity>0?Math.min(1,orderQty/aggregate.quantity):1;
    return {
      ...aggregate,quantity:Math.min(orderQty,aggregate.quantity),entryPrice:number(entryTrade.price,"trade price"),
      unrealizedPnl:aggregate.unrealizedPnl===undefined?undefined:aggregate.unrealizedPnl*share,
      realizedPnl:aggregate.realizedPnl===undefined?undefined:aggregate.realizedPnl*share
    };
  }

  async listTracked(orders_:TrackedOrderRef[]):Promise<PlatformTrackedOrder[]>{
    const orderIds=orders_.map((order)=>order.id);
    const levelsById=new Map(orders_.map((order)=>[order.id,order]));
    if(!orderIds.length)return [];
    const [pending,orders,positions,trades,transfers]=await Promise.all([this.pendingOrders(),this.orderHistory(),this.positions(),this.trades(),this.transfers()]);
    const tracked:PlatformTrackedOrder[]=[];
    for(const id of orderIds){
      const pendingEntry=pending.find((item)=>item.rfq_id===id);
      if(pendingEntry){tracked.push({id,state:"PENDING_ENTRY",quantity:optionalNumber(pendingEntry.qty),raw:pendingEntry});continue;}
      const entryTrade=trades.find((item)=>item.source_rfq===id);
      const historical=orders.find((item)=>item.rfq_id===id);
      if(!entryTrade){
        // Same truncation trap as stateSnapshot: an order older than the last
        // 100 created cannot be found in history, so "not in history" must not
        // mean "unclassifiable". An order that never appears in pending and has
        // no fill is not working and never traded. Leaving it UNKNOWN was worse
        // than a wrong guess: the UNKNOWN release counter only frees orders
        // that never got an rfq id, so one of these would poll forever.
        if(historical&&!["canceled","cancelled","rejected"].includes(statusOf(historical)))tracked.push({id,state:"UNKNOWN",raw:historical});
        else tracked.push({id,state:"CANCELLED_EXTERNALLY",raw:historical??{inferred:"absent from pending orders and from every recent trade"}});
        continue;
      }
      const position=positions.find((item)=>sameInstrument(this.positionData(item).instrument,entryTrade.instrument));
      const anchor=new Date(String(historical?.created_at??entryTrade.created_at)).getTime();
      const relatedProtections=orders.filter((order)=>sameInstrument(order.instrument,entryTrade.instrument)&&["take_profit","stop_loss"].includes(typeOf(order))&&Math.abs(new Date(String(order.created_at)).getTime()-anchor)<=5_000);
      const fills=[this.fillSnapshot(entryTrade)];
      if(position){
        // Variational allows exactly one auto-resizing TP/SL per instrument,
        // not one per order — a same-direction order stacked onto an
        // existing position deliberately has no protection of its own (see
        // the asset-conflict resolution in variational-agent's handleOrder)
        // because the instrument's existing TP/SL already auto-resizes to
        // cover it. So "protected" has to mean "the instrument currently has
        // an active TP/SL", not "one was created within seconds of *this*
        // order's own entry" — anchoring on time would falsely report this
        // order as unprotected and trigger EXISTING_PROTECTION_MISSING.
        // Read protection from the PENDING list, never from the history page.
        // orderHistory() is the 100 most recent orders, so on a busy account it
        // stops reaching back within the hour — a ZEC position opened at 10:17
        // was reported unprotected at 14:03 purely because its still-active
        // TP/SL had scrolled off that page, which paused a healthy asset and
        // demanded manual intervention on a healthy order. "Is a protection
        // active" is exactly the question the pending endpoint answers, and its
        // size is bounded by live orders rather than by elapsed time.
        const activeForInstrument=pending.filter((order)=>sameInstrument(order.instrument,entryTrade.instrument)&&["take_profit","stop_loss"].includes(typeOf(order)));
        tracked.push({id,state:"FILLED_OPEN",quantity:number(entryTrade.qty,"trade quantity"),fillPrice:number(entryTrade.price,"trade price"),openedAt:string(entryTrade.created_at,"trade time"),takeProfitPresent:activeForInstrument.some((order)=>typeOf(order)==="take_profit"),stopLossPresent:activeForInstrument.some((order)=>typeOf(order)==="stop_loss"),position:this.apportionPosition(this.positionSnapshot(position,activeForInstrument),entryTrade),fills,raw:{entryTrade,position,protections:activeForInstrument}});
        continue;
      }
      const liquidation=trades.find((trade)=>sameInstrument(trade.instrument,entryTrade.instrument)&&String(trade.trade_type).toLowerCase()==="liquidation"&&new Date(String(trade.created_at))>new Date(String(entryTrade.created_at)));
      const exitTrade=liquidation??trades.find((trade)=>sameInstrument(trade.instrument,entryTrade.instrument)&&trade.side!==entryTrade.side&&new Date(String(trade.created_at))>new Date(String(entryTrade.created_at))&&number(trade.qty,"exit trade quantity")>=number(entryTrade.qty,"entry trade quantity"));
      const realized=exitTrade?transfers.find((transfer)=>transfer.rfq_id===exitTrade.source_rfq&&transfer.transfer_type==="realized_pnl"):undefined;
      if(exitTrade)fills.push(this.fillSnapshot(exitTrade,realized?optionalNumber(realized.qty):undefined));
      // The rfq that SOURCED the exit trade says why the position closed.
      // Classifying by it — instead of by a cleared protection created within
      // seconds of this order's own entry — matters for stacked orders: the
      // instrument's shared TP/SL was created alongside the FIRST order, so
      // the old time-anchored match classified only that one as CLOSED_TP/SL
      // and stranded every sibling in UNKNOWN, permanently occupying the
      // per-side order cap.
      const exitSource=exitTrade?orders.find((order)=>order.rfq_id===exitTrade.source_rfq):undefined;
      // An exit we can see but cannot attribute to a protection order is a
      // close somebody else made — an operator flattening by hand, most often.
      // Booking it as CLOSED_REVERSED settles the order on the PnL we can
      // actually read, keeps it out of the win/loss statistics (it was not a
      // strategy outcome), and above all lets it leave the reconciliation set:
      // UNKNOWN is only auto-released for orders that never got an rfq id, so
      // one of these would otherwise be polled for ever.
      // Where the exit PRINTED is the primary evidence, because the rfq trail
      // silently stops resolving: an auto-resized protection is reissued under
      // a new rfq id, and orderHistory() only reaches back 100 orders anyway.
      // Both failures look like "no matching protection" and were booked as
      // manual closes — ZRO filled its stop at 0.846 with the trigger at
      // 0.845253 and never appeared in the loss column. The rfq lookup is kept
      // as the fallback for the case price cannot settle: a protection that
      // fired without moving price near either level.
      const levels=levelsById.get(id);
      const byPrice=exitTrade&&levels&&levels.direction!==undefined&&levels.entryPrice!==undefined&&levels.stopLoss!==undefined&&levels.takeProfit!==undefined
        ?classifyExitByPrice({direction:levels.direction,exitPrice:number(exitTrade.price,"exit trade price"),
          entryPrice:levels.entryPrice,stopLoss:levels.stopLoss,takeProfit:levels.takeProfit,breakevenStop:levels.breakevenStop??null})
        :null;
      const byRfq=typeOf(exitSource??{})==="take_profit"?"CLOSED_TP" as const
        :typeOf(exitSource??{})==="stop_loss"?"CLOSED_SL" as const:null;
      const state=liquidation?"LIQUIDATED"
        :byPrice??byRfq
        ??(exitTrade?"CLOSED_REVERSED":"UNKNOWN");
      tracked.push({id,state,quantity:number(entryTrade.qty,"trade quantity"),fillPrice:number(entryTrade.price,"trade price"),openedAt:string(entryTrade.created_at,"trade time"),fills,raw:{entryTrade,exitTrade:exitTrade??null,realizedPnl:realized?.qty??null,protections:relatedProtections}});
    }
    return tracked;
  }
}
