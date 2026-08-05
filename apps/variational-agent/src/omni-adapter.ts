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
  listTracked(orderIds:string[]):Promise<PlatformTrackedOrder[]>;
  cancelPending():Promise<Array<{id:string;cancelled:boolean}>>;
  close?():Promise<void>;
}

type JsonRecord=Record<string,unknown>;
type Instrument={instrument_type:"perpetual_future";underlying:string;funding_interval_s:3600;settlement_asset:"USDC"};
export type QuantizedPrices={entryPrice:string;takeProfit:string;stopLoss:string;decimals:number;expectedRiskReward:number};
type PreparedOrder={plan:OrderPlan;instrument:Instrument;side:"buy"|"sell";qty:string;quote:JsonRecord;prices:QuantizedPrices};
type Submission={prepared:PreparedOrder;response:JsonRecord};

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
 * itself. The resulting ratio is re-verified against the 1.5 floor from spec
 * 8.3, so quantization can never smuggle a sub-1.5R order onto the platform.
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
  if(expectedRiskReward<1.5-1e-9)throw new Error(`quantized risk/reward ${expectedRiskReward.toFixed(3)} is below 1.5 at ${places} price decimals`);
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

  private async verifyLeverage(plan:OrderPlan,instrument:Instrument){
    const response=record(await this.transport.request("/api/settlement_pools/leverage",{method:"POST",body:{assets:[instrument.underlying]}}),"leverage");
    const asset=record(response[instrument.underlying],`${instrument.underlying} leverage`);
    const current=number(asset.current,"current leverage");
    if(current!==plan.leverage)throw new Error(`Variational leverage for ${instrument.underlying} is ${current}x; expected ${plan.leverage}x`);
  }

  private async indicative(instrument:Instrument,qty:string){return record(await this.transport.request("/api/quotes/indicative",{method:"POST",body:{instrument,qty}}),"indicative quote");}

  private async prepare(plan:OrderPlan){
    const cached=this.prepared.get(plan.idempotencyKey);if(cached)return cached;
    const instrument=instrumentFor(plan.symbol),side:PreparedOrder["side"]=plan.direction==="LONG"?"buy":"sell";
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

  async submitEntry(value:Record<string,unknown>):Promise<PlatformEntry>{
    const plan=asPlan(value),prepared=await this.prepare(plan);
    const {entryPrice,takeProfit,stopLoss}=prepared.prices;
    const body={
      order_type:"limit",limit_price:entryPrice,side:prepared.side,
      instrument:prepared.instrument,qty:prepared.qty,slippage_limit:this.config.VARIATIONAL_ENTRY_SLIPPAGE.toString(),
      is_auto_resize:false,use_mark_price:false,
      take_profit:takeProfit,tp_is_auto_resize:true,tp_use_mark_price:true,tp_slippage_limit:this.config.VARIATIONAL_PROTECTION_SLIPPAGE.toString(),
      stop_loss:stopLoss,sl_is_auto_resize:true,sl_use_mark_price:true,sl_slippage_limit:this.config.VARIATIONAL_PROTECTION_SLIPPAGE.toString(),
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

  async cancelPending(){
    const entries=(await this.pendingOrders()).filter((item)=>typeOf(item)==="limit"&&item.is_reduce_only!==true);
    return Promise.all(entries.map(async(item)=>{const id=string(item.rfq_id,"pending RFQ ID");try{await this.cancelOrder(id);return {id,cancelled:true};}catch{return {id,cancelled:false};}}));
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

  private fillSnapshot(trade:JsonRecord,realizedPnl?:number):PlatformFillSnapshot{return {
    id:string(trade.id,"trade ID"),side:string(trade.side,"trade side"),price:number(trade.price,"trade price"),quantity:number(trade.qty,"trade quantity"),filledAt:string(trade.created_at,"trade time"),realizedPnl,raw:trade
  };}

  async listTracked(orderIds:string[]):Promise<PlatformTrackedOrder[]>{
    if(!orderIds.length)return [];
    const [pending,orders,positions,trades,transfers]=await Promise.all([this.pendingOrders(),this.orderHistory(),this.positions(),this.trades(),this.transfers()]);
    const tracked:PlatformTrackedOrder[]=[];
    for(const id of orderIds){
      const pendingEntry=pending.find((item)=>item.rfq_id===id);
      if(pendingEntry){tracked.push({id,state:"PENDING_ENTRY",quantity:optionalNumber(pendingEntry.qty),raw:pendingEntry});continue;}
      const entryTrade=trades.find((item)=>item.source_rfq===id);
      const historical=orders.find((item)=>item.rfq_id===id);
      if(!entryTrade){
        if(historical&&["canceled","cancelled","rejected"].includes(statusOf(historical)))tracked.push({id,state:"CANCELLED_EXTERNALLY",raw:historical});
        else tracked.push({id,state:"UNKNOWN",raw:historical??{}});
        continue;
      }
      const position=positions.find((item)=>sameInstrument(this.positionData(item).instrument,entryTrade.instrument));
      const anchor=new Date(String(historical?.created_at??entryTrade.created_at)).getTime();
      const relatedProtections=orders.filter((order)=>sameInstrument(order.instrument,entryTrade.instrument)&&["take_profit","stop_loss"].includes(typeOf(order))&&Math.abs(new Date(String(order.created_at)).getTime()-anchor)<=5_000);
      const fills=[this.fillSnapshot(entryTrade)];
      if(position){
        const active=relatedProtections.filter((order)=>statusOf(order)==="pending");
        tracked.push({id,state:"FILLED_OPEN",quantity:number(entryTrade.qty,"trade quantity"),fillPrice:number(entryTrade.price,"trade price"),openedAt:string(entryTrade.created_at,"trade time"),takeProfitPresent:active.some((order)=>typeOf(order)==="take_profit"),stopLossPresent:active.some((order)=>typeOf(order)==="stop_loss"),position:this.positionSnapshot(position,active),fills,raw:{entryTrade,position,protections:relatedProtections}});
        continue;
      }
      const cleared=relatedProtections.find((order)=>["cleared","completed"].includes(statusOf(order)));
      const liquidation=trades.find((trade)=>sameInstrument(trade.instrument,entryTrade.instrument)&&String(trade.trade_type).toLowerCase()==="liquidation"&&new Date(String(trade.created_at))>new Date(String(entryTrade.created_at)));
      const exitRfq=cleared?.rfq_id??liquidation?.source_rfq;
      const exitTrade=exitRfq?trades.find((trade)=>trade.source_rfq===exitRfq):trades.find((trade)=>sameInstrument(trade.instrument,entryTrade.instrument)&&trade.side!==entryTrade.side&&new Date(String(trade.created_at))>new Date(String(entryTrade.created_at))&&number(trade.qty,"exit trade quantity")>=number(entryTrade.qty,"entry trade quantity"));
      const realized=exitTrade?transfers.find((transfer)=>transfer.rfq_id===exitTrade.source_rfq&&transfer.transfer_type==="realized_pnl"):undefined;
      if(exitTrade)fills.push(this.fillSnapshot(exitTrade,realized?optionalNumber(realized.qty):undefined));
      const state=liquidation?"LIQUIDATED":typeOf(cleared??{})==="take_profit"?"CLOSED_TP":typeOf(cleared??{})==="stop_loss"?"CLOSED_SL":"UNKNOWN";
      tracked.push({id,state,quantity:number(entryTrade.qty,"trade quantity"),fillPrice:number(entryTrade.price,"trade price"),openedAt:string(entryTrade.created_at,"trade time"),fills,raw:{entryTrade,exitTrade:exitTrade??null,realizedPnl:realized?.qty??null,protections:relatedProtections}});
    }
    return tracked;
  }
}
