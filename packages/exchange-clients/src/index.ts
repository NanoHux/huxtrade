import { getConfig } from "@huxtrade/config";
import type { Candle } from "@huxtrade/indicators";
import type { HeatmapRegion } from "@huxtrade/shared-types";
import { eligibleHeatmapRegions } from "@huxtrade/strategy-engine";

async function json<T>(url: URL, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) throw new Error(`${url.host} ${response.status}: ${await response.text()}`);
    return await response.json() as T;
  } finally { clearTimeout(timer); }
}

export class BinanceFuturesClient {
  constructor(private readonly base = getConfig().BINANCE_FUTURES_BASE_URL) {}
  private url(path: string, params: Record<string, string | number>) {
    const url = new URL(path, this.base);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
    return url;
  }
  async validateSymbol(symbol: string) {
    const data = await json<{ symbols: Array<{ symbol: string; contractType: string; status: string }> }>(this.url("/fapi/v1/exchangeInfo", {}));
    return data.symbols.some((x) => x.symbol === symbol && x.contractType === "PERPETUAL" && x.status === "TRADING");
  }
  async resolvePerpetualSymbol(code:string):Promise<string|undefined>{
    const normalized=code.toUpperCase();
    const data=await json<{symbols:Array<{symbol:string;baseAsset:string;quoteAsset:string;contractType:string;status:string}>}>(this.url("/fapi/v1/exchangeInfo",{}));
    const active=data.symbols.filter((item)=>item.quoteAsset==="USDT"&&item.contractType==="PERPETUAL"&&item.status==="TRADING");
    return active.find((item)=>item.baseAsset===normalized)?.symbol
      ??active.find((item)=>item.symbol===`${normalized}USDT`)?.symbol
      ??active.find((item)=>item.baseAsset===`1000${normalized}`)?.symbol;
  }
  async latestPrice(symbol: string) {
    const data = await json<{ price: string }>(this.url("/fapi/v1/ticker/price", { symbol }));
    return Number(data.price);
  }
  private mapKlines(data:Array<[number,string,string,string,string,string,number,string,number,string,string]>):Candle[]{
    return data.map((x) => ({ openTime:x[0], open:Number(x[1]), high:Number(x[2]), low:Number(x[3]), close:Number(x[4]), volume:Number(x[5]), quoteVolume:Number(x[7]), takerBuyQuoteVolume:Number(x[10]) }));
  }
  async klines(symbol: string, interval: string, limit: number): Promise<Candle[]> {
    const data = await json<Array<[number,string,string,string,string,string,number,string,number,string,string]>>(this.url("/fapi/v1/klines", { symbol, interval, limit }));
    return this.mapKlines(data);
  }
  async klinesRange(symbol:string,interval:string,startTime:number,endTime:number):Promise<Candle[]>{
    const result:Candle[]=[];let cursor=startTime;
    for(let page=0;page<100&&cursor<endTime;page+=1){
      const data=await json<Array<[number,string,string,string,string,string,number,string,number,string,string]>>(this.url("/fapi/v1/klines",{symbol,interval,startTime:cursor,endTime,limit:1500}));
      if(!data.length)break;
      const candles=this.mapKlines(data);result.push(...candles);
      const next=candles.at(-1)!.openTime+1;if(data.length<1500||next<=cursor)break;cursor=next;
    }
    return result;
  }
  async openInterest(symbol: string) {
    const data = await json<{ openInterest: string; time: number }>(this.url("/fapi/v1/openInterest", { symbol }));
    return { value: Number(data.openInterest), time: data.time };
  }
  async openInterestHistory(symbol:string,startTime:number,endTime:number){
    const result:Array<{sumOpenInterest:string;timestamp:number}>=[];let cursorEnd=endTime;
    for(let page=0;page<20&&cursorEnd>startTime;page+=1){
      const batch=await json<Array<{sumOpenInterest:string;timestamp:number}>>(this.url("/futures/data/openInterestHist",{symbol,period:"15m",startTime,endTime:cursorEnd,limit:500}));
      if(!batch.length)break;result.unshift(...batch);const earliest=batch[0]!.timestamp;if(earliest<=startTime||batch.length<500)break;const next=earliest-1;if(next>=cursorEnd)break;cursorEnd=next;
    }
    return [...new Map(result.map((item)=>[item.timestamp,item])).values()].sort((a,b)=>a.timestamp-b.timestamp);
  }
  async fundingHistory(symbol: string, limit = 1000, startTime?:number, endTime?:number) {
    const params:Record<string,string|number>={symbol,limit};if(startTime!==undefined)params.startTime=startTime;if(endTime!==undefined)params.endTime=endTime;
    return json<Array<{ fundingRate: string; fundingTime: number }>>(this.url("/fapi/v1/fundingRate", params));
  }
  async aggregateTrades(symbol: string, startTime: number, endTime: number) {
    const result: Array<{ a:number; p: string; q: string; T: number; m: boolean }> = [];
    let fromId:number|undefined;
    for (let page = 0; page < 100; page += 1) {
      const params:Record<string,string|number>=fromId===undefined?{symbol,startTime,endTime,limit:1000}:{symbol,fromId,limit:1000};
      const batch = await json<Array<{ a:number; p: string; q: string; T: number; m: boolean }>>(this.url("/fapi/v1/aggTrades", params));
      if (!batch.length) break;
      result.push(...batch.filter((trade)=>trade.T>=startTime&&trade.T<=endTime));
      const last=batch.at(-1)!;
      if(batch.length<1000||last.T>endTime)break;
      const next=last.a+1;if(fromId!==undefined&&next<=fromId)break;fromId=next;
    }
    return result;
  }
}

interface CoinGlassHeatmap {
  code: string;
  msg: string;
  data: { y_axis: number[]; liquidation_leverage_data: Array<[number, number, number]>; price_candlesticks: unknown[] };
}

export class CoinGlassClient {
  constructor(private readonly base = getConfig().COINGLASS_BASE_URL, private readonly apiKey = getConfig().COINGLASS_API_KEY) {}
  async heatmap(symbol: string, range = "24h"): Promise<{ regions: HeatmapRegion[]; raw: CoinGlassHeatmap["data"] }> {
    if (!this.apiKey) throw new Error("COINGLASS_API_KEY is not configured");
    const url = new URL("/api/futures/liquidation/heatmap/model1", this.base);
    url.searchParams.set("exchange", "Binance"); url.searchParams.set("symbol", symbol); url.searchParams.set("range", range);
    const payload = await json<CoinGlassHeatmap>(url, { headers: { "CG-API-KEY": this.apiKey } });
    if (payload.code !== "0") throw new Error(`CoinGlass: ${payload.msg}`);
    const byPrice = new Map<number, number>();
    for (const [, yIndex, intensity] of payload.data.liquidation_leverage_data) {
      const price = payload.data.y_axis[yIndex];
      if (price !== undefined) byPrice.set(price, (byPrice.get(price) ?? 0) + intensity);
    }
    const sortedAxis=[...payload.data.y_axis].sort((a,b)=>a-b);
    const step=sortedAxis.length>1?Math.abs(sortedAxis[1]!-sortedAxis[0]!):0;
    return { regions: eligibleHeatmapRegions([...byPrice].map(([price, intensity]) => ({ price,lowPrice:price-step/2,highPrice:price+step/2,intensity }))), raw: payload.data };
  }
}
