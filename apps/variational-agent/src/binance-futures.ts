import crypto from "node:crypto";
import type { OrderPlan } from "@huxtrade/shared-types";
import type { PlatformEntry,PlatformEntryState,PlatformProtection,PlatformTrackedOrder } from "./execution.js";
import type { TrackedOrderRef,VariationalAdapter } from "./omni-adapter.js";

interface ExchangeSymbolInfo{
  symbol:string;
  pricePrecision:number;
  quantityPrecision:number;
  filters:Array<{filterType:string;minQty?:string;notional?:string;tickSize?:string;stepSize?:string}>;
}

let exchangeInfoCache:{symbols:Map<string,ExchangeSymbolInfo>;fetchedAt:number}|undefined;
let hedgeModeCache:{value:boolean;fetchedAt:number}|undefined;

/** Size-weighted average price of a set of fills; null when nothing filled. */
const vwap=(fills:Array<{price:string;qty:string}>)=>{
  const qty=fills.reduce((sum,f)=>sum+Number(f.qty),0);
  return qty>0?fills.reduce((sum,f)=>sum+Number(f.qty)*Number(f.price),0)/qty:null;
};

export class BinanceFuturesAdapter implements VariationalAdapter{
  constructor(private readonly apiKey:string,private readonly secretKey:string,private readonly baseUrl="https://fapi.binance.com"){}

  private async isHedgeMode():Promise<boolean>{
    if(hedgeModeCache&&Date.now()-hedgeModeCache.fetchedAt<3_600_000)return hedgeModeCache.value;
    const data=await this.request<{dualSidePosition:boolean}>("GET","/fapi/v1/positionSide/dual");
    hedgeModeCache={value:data.dualSidePosition,fetchedAt:Date.now()};
    return data.dualSidePosition;
  }

  private sign(params:Record<string,string|number>):string{
    const qs=new URLSearchParams(Object.entries(params).map(([k,v])=>[k,String(v)])).toString();
    const signature=crypto.createHmac("sha256",this.secretKey).update(qs).digest("hex");
    return `${qs}&signature=${signature}`;
  }

  /**
   * One Binance call, with a bounded wait and a retry for transient trouble.
   *
   * Without the timeout a hung socket blocks the whole tick — node's default
   * header timeout is minutes. Without the retry a single dropped request or
   * 5xx is indistinguishable from the venue being down, which is how one blip
   * on an ~800ms round trip turned into a health flip.
   *
   * Only transport errors, 5xx and 429 are retried. A 4xx carries a Binance
   * error code — a rejected order, a bad parameter — and repeating it would at
   * best waste a call and at worst place something twice, so it is raised as is.
   */
  private async request<T=unknown>(method:"GET"|"POST"|"DELETE",path:string,params:Record<string,string|number>={},signed=true):Promise<T>{
    const headers:Record<string,string>={"X-MBX-APIKEY":this.apiKey};
    let lastError:unknown;
    for(let attempt=0;attempt<2;attempt++){
      // Signed requests carry a timestamp checked against recvWindow, so the
      // retry has to re-sign rather than reuse the first attempt's URL.
      const url=signed
        ?`${this.baseUrl}${path}?${this.sign({...params,timestamp:Date.now(),recvWindow:5000})}`
        :`${this.baseUrl}${path}?${new URLSearchParams(Object.entries(params).map(([k,v])=>[k,String(v)])).toString()}`;
      try{
        const res=await fetch(url,{method,headers,signal:AbortSignal.timeout(15_000)});
        if(res.ok)return res.json() as Promise<T>;
        const body=await res.text().catch(()=>"");
        // 408 and -1007 are the venue timing out on itself, not judging the
        // request — a nightly basket failed to open on one of them because a
        // status under 500 was read as a verdict. They say "execution status
        // unknown", so they are safe to repeat only where repeating changes
        // nothing: re-reading state, or cancelling something already gone.
        const timedOut=res.status===408||body.includes('"code":-1007');
        const retriable=res.status>=500||res.status===429||(timedOut&&(method==="GET"||method==="DELETE"));
        const error=Object.assign(new Error(`Binance ${method} ${path} ${res.status}: ${body}`),{venueRejection:!retriable});
        if(error.venueRejection)throw error;
        lastError=error;
      }catch(error){
        // The venue's own rejection, re-thrown above — never retried.
        if((error as {venueRejection?:boolean})?.venueRejection)throw error;
        lastError=error;
      }
      if(attempt===0)await new Promise((resolve)=>setTimeout(resolve,750));
    }
    throw lastError instanceof Error?lastError:new Error(String(lastError));
  }

  private async getExchangeInfo():Promise<Map<string,ExchangeSymbolInfo>>{
    if(exchangeInfoCache&&Date.now()-exchangeInfoCache.fetchedAt<3_600_000)return exchangeInfoCache.symbols;
    const info=await this.request<{symbols:ExchangeSymbolInfo[]}>("GET","/fapi/v1/exchangeInfo",{},false);
    const map=new Map<string,ExchangeSymbolInfo>();
    for(const s of info.symbols)map.set(s.symbol,s);
    exchangeInfoCache={symbols:map,fetchedAt:Date.now()};
    return map;
  }

  /**
   * Why the last sessionValid() said no. The boolean alone produced a
   * "Binance API unreachable" that was true of a timeout, a 451 from a blocked
   * region and a revoked key alike, and the cause was nowhere to be found.
   */
  lastSessionError:string|null=null;

  async sessionValid():Promise<boolean>{
    try{await this.account();this.lastSessionError=null;return true;}
    catch(error){this.lastSessionError=error instanceof Error?error.message:String(error);return false;}
  }

  async account():Promise<{balanceUsdc:number;marginUsagePercent:number}>{
    const data=await this.request<{totalWalletBalance:string;totalInitialMargin:string;totalMarginBalance:string;availableBalance:string}>("GET","/fapi/v2/account");
    const balance=Number(data.totalWalletBalance);
    const margin=Number(data.totalInitialMargin);
    return {balanceUsdc:balance,marginUsagePercent:balance>0?100*margin/balance:0};
  }

  async supportedAssets():Promise<unknown>{
    const info=await this.getExchangeInfo();
    const tickers=await this.request<Array<{symbol:string;lastPrice:string;priceChangePercent:string}>>("GET","/fapi/v1/ticker/24hr",{},false);
    const result:Record<string,Array<Record<string,unknown>>>={};
    for(const t of tickers){
      if(!t.symbol.endsWith("USDT"))continue;
      const sym=info.get(t.symbol);
      if(!sym)continue;
      const base=t.symbol.replace(/USDT$/,"");
      result[base]=[{
        price:Number(t.lastPrice),
        price_change_percentage_24h:Number(t.priceChangePercent),
        is_close_only_mode:false,
        has_perp:true,
        instrument_type:"perpetual_future"
      }];
    }
    return result;
  }

  async minimumMargin(plan:OrderPlan):Promise<number>{
    const info=await this.getExchangeInfo();
    const sym=info.get(plan.symbol);
    if(!sym)return 0;
    const minNotional=sym.filters.find((f)=>f.filterType==="MIN_NOTIONAL");
    return minNotional?.notional?Number(minNotional.notional)/plan.leverage:5;
  }

  async quotedSpread(_plan:OrderPlan):Promise<number|undefined>{return undefined;}

  private async setLeverage(symbol:string,leverage:number):Promise<void>{
    try{
      await this.request("POST","/fapi/v1/leverage",{symbol,leverage});
    }catch(error){
      if(error instanceof Error&&error.message.includes("No need to change"))return;
      throw error;
    }
  }

  private quantize(value:number,precision:number):string{
    return value.toFixed(precision);
  }

  async submitMarketEntry(value:Record<string,unknown>,_options?:{skipProtection?:boolean}):Promise<PlatformEntry>{
    const plan=value as unknown as OrderPlan;
    const symbol=plan.symbol;
    const info=await this.getExchangeInfo();
    const sym=info.get(symbol);
    if(!sym)throw new Error(`Symbol ${symbol} not found on Binance`);

    await this.setLeverage(symbol,plan.leverage);
    const hedge=await this.isHedgeMode();
    const positionSide=hedge?(plan.direction==="LONG"?"LONG":"SHORT"):undefined;

    const side=plan.direction==="LONG"?"BUY":"SELL";
    const quantity=this.quantize(plan.notionalUsdc/plan.entryPrice,sym.quantityPrecision);

    const entryParams:{[k:string]:string|number}={symbol,side,type:"MARKET",quantity,newOrderRespType:"RESULT"};
    if(positionSide)entryParams.positionSide=positionSide;
    const order=await this.request<{orderId:number;executedQty:string;avgPrice:string;status:string;cumQuote:string}>("POST","/fapi/v1/order",entryParams);

    const entryId=String(order.orderId);
    const filledQty=Number(order.executedQty);
    const fillPrice=Number(order.avgPrice);

    if(plan.takeProfit&&plan.takeProfit>0){
      const tpSide=plan.direction==="LONG"?"SELL":"BUY";
      const tpPrice=this.quantize(plan.takeProfit,sym.pricePrecision);
      try{
        const tpParams:{[k:string]:string}={symbol,side:tpSide,type:"TAKE_PROFIT_MARKET",triggerPrice:tpPrice,closePosition:"true",workingType:"MARK_PRICE",algoType:"CONDITIONAL"};
        if(positionSide)tpParams.positionSide=positionSide;
        await this.request("POST","/fapi/v1/algoOrder",tpParams);
      }catch(error){
        console.error(`TP order failed for ${symbol}: ${error instanceof Error?error.message:String(error)}`);
      }
    }

    if(plan.stopLoss&&plan.stopLoss>0){
      const slSide=plan.direction==="LONG"?"SELL":"BUY";
      const slPrice=this.quantize(plan.stopLoss,sym.pricePrecision);
      try{
        const slParams:{[k:string]:string}={symbol,side:slSide,type:"STOP_MARKET",triggerPrice:slPrice,closePosition:"true",workingType:"MARK_PRICE",algoType:"CONDITIONAL"};
        if(positionSide)slParams.positionSide=positionSide;
        await this.request("POST","/fapi/v1/algoOrder",slParams);
      }catch(error){
        console.error(`SL order failed for ${symbol}: ${error instanceof Error?error.message:String(error)}`);
      }
    }

    return {
      id:entryId,
      state:"FILLED_OPEN",
      quantity:filledQty,
      fillPrice,
      raw:order as unknown as Record<string,unknown>
    };
  }

  async livePositions():Promise<Array<{symbol:string;qty:number;entryPrice:number|null;markPrice:number|null;unrealizedPnl:number|null;openedAt:string|null}>>{
    const positions=await this.request<Array<{symbol:string;positionAmt:string;entryPrice:string;markPrice:string;unRealizedProfit:string;updateTime:number}>>("GET","/fapi/v2/positionRisk");
    return positions
      .filter((p)=>Math.abs(Number(p.positionAmt))>0)
      .map((p)=>({
        symbol:p.symbol.replace(/USDT$/,""),
        qty:Number(p.positionAmt),
        entryPrice:Number(p.entryPrice),
        markPrice:Number(p.markPrice),
        unrealizedPnl:Number(p.unRealizedProfit),
        openedAt:p.updateTime?new Date(p.updateTime).toISOString():null
      }));
  }

  /**
   * What a symbol realised since `sinceMs`, rebuilt from its fills.
   *
   * A leg whose take-profit fired is gone from positionRisk long before the
   * basket's clock runs out, so the closing sweep never sees it: its profit was
   * missing from the report and from every total built on that report. The
   * fills stay on the account, so the leg is reconstructed from them.
   *
   * Binance stamps realizedPnl only on the reducing side, which is what
   * separates the entry fills from the exit fills here. A close landing at
   * exactly zero would be misread as an entry — with floating point prices that
   * does not happen, and the P&L total is unaffected either way.
   */
  async realizedSince(symbol:string,sinceMs:number,attempts=1):Promise<{qty:number;entryPrice?:number;exitPrice?:number;grossPnl:number;commission:number;realizedPnl:number}|null>{
    // The venue indexes fills a beat behind the order that made them, and a
    // market close on a thin book lands as a dozen of them. Asked the instant
    // the close returns, it answers "no trades" — so a basket's whole price
    // move was once reported as zero. Give it a moment and ask again.
    let trades:Array<{price:string;qty:string;realizedPnl:string;commission:string}>=[];
    for(let attempt=0;attempt<attempts;attempt++){
      if(attempt)await new Promise((resolve)=>setTimeout(resolve,2_000));
      trades=await this.request("GET","/fapi/v1/userTrades",{symbol,startTime:sinceMs,limit:1000});
      if(trades.some((t)=>Number(t.realizedPnl)!==0))break;
    }
    if(!trades.length)return null;
    const exits=trades.filter((t)=>Number(t.realizedPnl)!==0);
    if(!exits.length)return null;
    const entries=trades.filter((t)=>Number(t.realizedPnl)===0);
    // Kept apart all the way to the report: the venue's realizedPnl is what the
    // price did, commission is what the round trip cost. Netting them at the
    // source hides which one a losing leg actually lost to.
    const grossPnl=trades.reduce((sum,t)=>sum+Number(t.realizedPnl),0);
    const commission=trades.reduce((sum,t)=>sum+Number(t.commission),0);
    return {
      qty:exits.reduce((sum,t)=>sum+Number(t.qty),0),
      entryPrice:vwap(entries)??undefined,
      exitPrice:vwap(exits)??undefined,
      grossPnl,commission,realizedPnl:grossPnl-commission
    };
  }

  /**
   * Funding charged or received over a window, per base symbol.
   *
   * Perpetual funding settles on the venue's own clock and never appears in a
   * trade, so P&L rebuilt from fills alone misses it entirely. For an
   * eight-hour hold that is not a rounding error: one leg collected +15.57
   * USDT of funding on a night the whole basket's price move was +44.78.
   *
   * Amounts keep the venue's sign — positive means the position was paid.
   * Entries are timestamped, so a leg that took profit early simply has no
   * rows past its exit and needs no special handling.
   */
  async fundingSince(sinceMs:number,untilMs:number):Promise<Map<string,number>>{
    const rows=await this.request<Array<{symbol:string;income:string;incomeType:string;time:number}>>("GET","/fapi/v1/income",{
      incomeType:"FUNDING_FEE",startTime:sinceMs,endTime:untilMs,limit:1000
    });
    const bySymbol=new Map<string,number>();
    for(const row of rows){
      const base=String(row.symbol).replace(/USDT$/,"");
      bySymbol.set(base,(bySymbol.get(base)??0)+Number(row.income));
    }
    return bySymbol;
  }

  async closeAllPositions():Promise<Array<{symbol:string;ok:boolean;qty:number;entryPrice?:number;exitPrice?:number;grossPnl?:number;commission?:number;realizedPnl?:number;error?:string}>>{
    const hedge=await this.isHedgeMode();
    const positions=await this.request<Array<{symbol:string;positionAmt:string;entryPrice:string;positionSide:string}>>("GET","/fapi/v2/positionRisk");
    const open=positions.filter((p)=>Math.abs(Number(p.positionAmt))>0);
    const results:Array<{symbol:string;ok:boolean;qty:number;entryPrice?:number;exitPrice?:number;grossPnl?:number;commission?:number;realizedPnl?:number;error?:string}>=[];

    for(const p of open){
      const qty=Number(p.positionAmt);
      const side=qty>0?"SELL":"BUY";
      const absQty=Math.abs(qty);
      try{
        await this.request("DELETE","/fapi/v1/allOpenOrders",{symbol:p.symbol});
        try{await this.request("DELETE","/fapi/v1/algoOpenOrders",{symbol:p.symbol});}catch{}
        const closeParams:{[k:string]:string|number}={symbol:p.symbol,side,type:"MARKET",quantity:String(absQty),newOrderRespType:"RESULT"};
        if(hedge)closeParams.positionSide=p.positionSide;
        else closeParams.reduceOnly="true";
        const closeOrder=await this.request<{orderId:number;avgPrice:string}>("POST","/fapi/v1/order",closeParams);
        const trades=await this.request<Array<{realizedPnl:string;commission:string;price:string;qty:string}>>("GET","/fapi/v1/userTrades",{
          symbol:p.symbol,orderId:closeOrder.orderId,limit:100
        });
        // An empty fill list means the venue has not indexed them yet, not that
        // the position went nowhere — and summing nothing yields a very
        // convincing 0.00. Reporting that as the price move turned a −48 USDC
        // leg into a break-even one. Unknown stays undefined, and the caller's
        // second pass fills it in once the fills appear.
        const priced=trades.length>0;
        const grossPnl=priced?trades.reduce((sum,t)=>sum+Number(t.realizedPnl),0):undefined;
        const commission=priced?trades.reduce((sum,t)=>sum+Number(t.commission),0):undefined;
        // The fills, not the order acknowledgement: RESULT does not reliably
        // carry avgPrice for a market close, and Number(undefined) is NaN,
        // which JSON renders as null — every exit price in the report was null.
        const exitPrice=vwap(trades);
        results.push({symbol:p.symbol.replace(/USDT$/,""),ok:true,qty:absQty,entryPrice:Number(p.entryPrice),
          exitPrice:exitPrice??(Number(closeOrder.avgPrice)||undefined),grossPnl,commission,
          realizedPnl:priced?grossPnl!-commission!:undefined});
      }catch(error){
        results.push({symbol:p.symbol.replace(/USDT$/,""),ok:false,qty:absQty,error:error instanceof Error?error.message:String(error)});
      }
    }
    return results;
  }

  async submitEntry(_value:Record<string,unknown>):Promise<PlatformEntry>{return this.submitMarketEntry(_value);}
  async placeTakeProfit(_entry:PlatformEntry,_plan:OrderPlan):Promise<PlatformProtection>{return {id:"",raw:{}};}
  async placeStopLoss(_entry:PlatformEntry,_plan:OrderPlan):Promise<PlatformProtection>{return {id:"",raw:{}};}
  async orderState(_entryId:string):Promise<PlatformEntryState>{return "UNKNOWN";}
  async cancelEntry(_entryId:string){return {cancelled:false as boolean,state:"UNKNOWN" as PlatformEntryState,raw:{}};}
  async cancelOrder(_orderId:string){}
  async closeMarket(_entryId:string){return {closed:false,raw:{}};}
  async listTracked(_orders:TrackedOrderRef[]):Promise<PlatformTrackedOrder[]>{return [];}
  async cancelPending():Promise<Array<{id:string;cancelled:boolean}>>{return [];}
  async activeProtectionCount(_symbol:string){return 0;}
  async closeSettlement(_closeRfqId:string){return {};}
  async closeMarketPartial(_entryId:string,_fraction:number):Promise<{closed:boolean;raw:unknown}>{return {closed:false,raw:{}};}
  async cancelProtection(_symbol:string,_kind:"take_profit"|"stop_loss"):Promise<{cancelled:number}>{return {cancelled:0};}
  async placeProtection(_input:{symbol:string;kind:"take_profit"|"stop_loss";direction:"LONG"|"SHORT";triggerPrice:number}):Promise<{id:string;triggerPrice:string;raw:unknown}>{return {id:"",triggerPrice:"0",raw:{}};}
}
