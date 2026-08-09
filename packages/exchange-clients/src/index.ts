import { getConfig } from "@huxtrade/config";
import type { Candle } from "@huxtrade/indicators";
import type { HeatmapRegion } from "@huxtrade/shared-types";
import { eligibleHeatmapRegions } from "@huxtrade/strategy-engine";

const intervalUnitMs:Record<string,number>={m:60_000,h:3_600_000,d:86_400_000,w:604_800_000};
/** Binance interval strings are a count and a unit: 5m, 1h, 1d, 1w. */
export function intervalMs(interval:string){
  const match=/^(\d+)([mhdw])$/.exec(interval);
  const unit=match?intervalUnitMs[match[2]!]:undefined;
  if(!match||!unit)throw new Error(`Unsupported Binance interval ${interval}`);
  return Number(match[1])*unit;
}

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
  constructor(private readonly base = getConfig().BINANCE_FUTURES_BASE_URL, private readonly aggregateTradePageLimit = 100) {}
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
      // Binance charges klines by requested limit, not by rows returned:
      // 1 up to 100, 2 to 500, 5 to 1000, 10 beyond. Asking for a flat 1500
      // made the three 5m candles of one scan window cost the same as a
      // month of history — 460 of the ~614 weight the collector spent every
      // 15 minutes, for 138 candles. Ask for what the range actually holds.
      const limit=Math.min(1500,Math.max(1,Math.ceil((endTime-cursor)/intervalMs(interval))+1));
      const data=await json<Array<[number,string,string,string,string,string,number,string,number,string,string]>>(this.url("/fapi/v1/klines",{symbol,interval,startTime:cursor,endTime,limit}));
      if(!data.length)break;
      const candles=this.mapKlines(data);result.push(...candles);
      const next=candles.at(-1)!.openTime+1;if(data.length<limit||next<=cursor)break;cursor=next;
    }
    return result;
  }

  /**
   * Every USDT-M perpetual's last price in one request. Weight 2 against the
   * 1 each that 46 per-symbol calls would cost, and it cannot half-fail: one
   * transient fetch used to pause whichever asset happened to be in flight.
   */
  async allPrices():Promise<Map<string,number>>{
    const data=await json<Array<{symbol:string;price:string}>>(this.url("/fapi/v1/ticker/price",{}));
    return new Map(data.map((row)=>[row.symbol,Number(row.price)] as const).filter(([,price])=>Number.isFinite(price)));
  }

  /**
   * Rolling 24h change for every symbol, one request. Replaces deriving it
   * from 25 hourly closes, which needed a full day of candle history and so
   * returned nothing at all for a newly listed asset — exactly the assets the
   * extreme-move filter most needs to judge.
   */
  async all24hChangePercent():Promise<Map<string,number>>{
    const data=await json<Array<{symbol:string;priceChangePercent:string}>>(this.url("/fapi/v1/ticker/24hr",{}));
    return new Map(data.map((row)=>[row.symbol,Number(row.priceChangePercent)] as const).filter(([,change])=>Number.isFinite(change)));
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
    let pageLimitReached=false;
    for (let page = 0; page < this.aggregateTradePageLimit; page += 1) {
      const params:Record<string,string|number>=fromId===undefined?{symbol,startTime,endTime,limit:1000}:{symbol,fromId,limit:1000};
      const batch = await json<Array<{ a:number; p: string; q: string; T: number; m: boolean }>>(this.url("/fapi/v1/aggTrades", params));
      if (!batch.length) break;
      result.push(...batch.filter((trade)=>trade.T>=startTime&&trade.T<=endTime));
      const last=batch.at(-1)!;
      if(batch.length<1000||last.T>endTime)break;
      const next=last.a+1;if(fromId!==undefined&&next<=fromId)break;fromId=next;
      if(page===this.aggregateTradePageLimit-1)pageLimitReached=true;
    }
    if(pageLimitReached)throw new Error(`Binance aggregate trades exceeded ${this.aggregateTradePageLimit} pages; refusing incomplete CVD`);
    return result;
  }
}

export const coinGlassHeatmapRanges = {
  "12h": { pageTime:"h12", interval:"5", limit:144 },
  "24h": { pageTime:"d1", interval:"5", limit:288 },
  "3d": { pageTime:"d3", interval:"15", limit:288 },
  "7d": { pageTime:"w1", interval:"30", limit:336 },
  "30d": { pageTime:"mo1", interval:"h2", limit:372 }
} as const;

export type CoinGlassHeatmapRange=keyof typeof coinGlassHeatmapRanges;

export type CoinGlassWebHeatmapPayload={
  code:string|number;
  msg?:string;
  success?:boolean;
  data?:{
    liq?:Array<[number,number,number]>;
    prices?:unknown[];
    y?:number[];
  };
};

const coinGlassHeatmapPath=/^\/(?:[a-z]{2}(?:-[A-Z]{2})?\/)?pro\/futures\/LiquidationHeatMap$/;

/**
 * Variational's ticker is not always the Binance base symbol: LIT trades as
 * LIGHTER, and stripping "USDT" off the Binance symbol produced
 * `{"error_message":"asset: Asset not supported"}` on every submission for
 * that asset. The operator already supplies the truth when adding the asset —
 * it is the last path segment of variational_url — so that is the authority,
 * and the Binance-derived name is only the fallback for a URL we cannot parse.
 */
export function variationalUnderlying(variationalUrl:string|null|undefined,binanceSymbol:string):string{
  const fallback=binanceSymbol.trim().toUpperCase().replace(/USDT$/i,"");
  try{
    const segments=new URL((variationalUrl??"").trim()).pathname.split("/").filter(Boolean);
    const last=(segments.at(-1)??"").toUpperCase();
    return /^[A-Z0-9]{1,20}$/.test(last)?last:fallback;
  }catch{return fallback;}
}

export function parseCoinGlassHeatmapUrl(value:string){
  const url=new URL(value);
  if(url.protocol!=="https:"||url.username||url.password||!["coinglass.com","www.coinglass.com"].includes(url.hostname.toLowerCase()))throw new Error("CoinGlass Heatmap URL must use https://www.coinglass.com");
  if(!coinGlassHeatmapPath.test(url.pathname))throw new Error("CoinGlass URL must point to the Model 1 LiquidationHeatMap page");
  const coin=(url.searchParams.get("coin")??"").trim().toUpperCase();
  // Single-character tickers exist ("4"), so length is not what makes a coin
  // parameter valid — only its character set is.
  if(!/^[A-Z0-9]{1,20}$/.test(coin))throw new Error("CoinGlass Heatmap URL has an invalid coin query parameter");
  const type=url.searchParams.get("type")??"pair";
  if(type!=="pair")throw new Error("CoinGlass Heatmap URL must use type=pair");
  url.searchParams.set("coin",coin);
  url.searchParams.set("type","pair");
  url.hash="";
  return {coin,symbol:`Binance_${coin}USDT`,url:url.toString()};
}

export function buildCoinGlassHeatmapPageUrl(value:string,range:CoinGlassHeatmapRange){
  const parsed=parseCoinGlassHeatmapUrl(value);
  const url=new URL(parsed.url);
  url.searchParams.set("time",coinGlassHeatmapRanges[range].pageTime);
  return url.toString();
}

export function normalizeCoinGlassWebHeatmap(payload:CoinGlassWebHeatmapPayload){
  if(String(payload.code)!=="0")throw new Error(`CoinGlass Heatmap request was rejected (${payload.code}${payload.msg?`: ${payload.msg}`:""})`);
  const axis=payload.data?.y;
  const cells=payload.data?.liq;
  if(!Array.isArray(axis)||!axis.length||!axis.every(Number.isFinite)||!Array.isArray(cells))throw new Error("CoinGlass Heatmap response has an invalid data shape");
  const byPrice=new Map<number,number>();
  for(const cell of cells){
    if(!Array.isArray(cell)||cell.length<3)continue;
    const yIndex=Number(cell[1]),intensity=Number(cell[2]),price=axis[yIndex];
    if(!Number.isInteger(yIndex)||price===undefined||!Number.isFinite(intensity)||intensity<=0)continue;
    byPrice.set(price,(byPrice.get(price)??0)+intensity);
  }
  if(!byPrice.size)throw new Error("CoinGlass Heatmap response contains no liquidation regions");
  const sortedAxis=[...new Set(axis)].sort((a,b)=>a-b);
  const gaps=sortedAxis.slice(1).map((price,index)=>price-sortedAxis[index]!).filter((gap)=>gap>0).sort((a,b)=>a-b);
  const step=gaps.length?gaps[Math.floor(gaps.length/2)]!:0;
  const regions=eligibleHeatmapRegions([...byPrice].map(([price,intensity])=>({price,lowPrice:price-step/2,highPrice:price+step/2,intensity})));
  return {regions,raw:payload.data};
}
