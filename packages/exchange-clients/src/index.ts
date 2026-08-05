import { createCipheriv,createDecipheriv,createHmac } from "node:crypto";
import { gunzipSync } from "node:zlib";
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

export function parseCoinGlassHeatmapUrl(value:string){
  const url=new URL(value);
  if(url.protocol!=="https:"||url.username||url.password||!["coinglass.com","www.coinglass.com"].includes(url.hostname.toLowerCase()))throw new Error("CoinGlass Heatmap URL must use https://www.coinglass.com");
  if(!coinGlassHeatmapPath.test(url.pathname))throw new Error("CoinGlass URL must point to the Model 1 LiquidationHeatMap page");
  const coin=(url.searchParams.get("coin")??"").trim().toUpperCase();
  if(!/^[A-Z0-9]{2,20}$/.test(coin))throw new Error("CoinGlass Heatmap URL has an invalid coin query parameter");
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

const coinGlassTotpSecret="I65VU7K5ZQL7WB4E";
const coinGlassSignatureKey=Buffer.from("1f68efd73f8d4921acc0dead41dd39bc");
const coinGlassBase32Alphabet="ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function decodeBase32(value:string){
  let bits="";
  for(const character of value){
    const index=coinGlassBase32Alphabet.indexOf(character);
    if(index<0)throw new Error("CoinGlass signing secret contains invalid Base32 data");
    bits+=index.toString(2).padStart(5,"0");
  }
  return Buffer.from(bits.match(/.{8}/g)?.map((byte)=>Number.parseInt(byte,2))??[]);
}

function coinGlassWebSignature(timestampMs:number){
  const timestampSeconds=Math.floor(timestampMs/1000);
  const counter=Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(timestampSeconds/30)));
  const digest=createHmac("sha1",decodeBase32(coinGlassTotpSecret)).update(counter).digest();
  const offset=digest[digest.length-1]!&0x0f;
  const otp=String((digest.readUInt32BE(offset)&0x7fffffff)%1_000_000).padStart(6,"0");
  const cipher=createCipheriv("aes-256-ecb",coinGlassSignatureKey,null);
  return Buffer.concat([cipher.update(`${timestampSeconds},${otp}`,"utf8"),cipher.final()]).toString("base64");
}

function decryptCoinGlassValue(value:string,key:string){
  if(key.length!==16)throw new Error("CoinGlass response encryption key has an invalid length");
  if(value.length>12*1024*1024)throw new Error("CoinGlass encrypted response exceeds the safety limit");
  const decipher=createDecipheriv("aes-128-ecb",Buffer.from(key),null);
  const compressed=Buffer.concat([decipher.update(Buffer.from(value,"base64")),decipher.final()]);
  const text=gunzipSync(compressed,{maxOutputLength:24*1024*1024}).toString("utf8");
  return text.startsWith('"')&&text.endsWith('"')?JSON.parse(text) as string:text;
}

type CoinGlassEncryptedEnvelope={code:string|number;msg?:string;success?:boolean;data?:string};

export const coinGlassBrowserHeaderNames=[
  "accept-language","priority","sec-ch-ua","sec-ch-ua-mobile","sec-ch-ua-platform",
  "sec-fetch-dest","sec-fetch-mode","sec-fetch-site","user-agent"
] as const;
export type CoinGlassBrowserHeaderName=typeof coinGlassBrowserHeaderNames[number];
export type CoinGlassBrowserHeaders=Partial<Record<CoinGlassBrowserHeaderName,string>>;

export class CoinGlassFreeWebClient{
  constructor(
    private readonly base="https://capi.coinglass.com",
    private readonly fetchImpl:typeof fetch=fetch,
    private readonly now:()=>number=()=>Date.now(),
    private readonly obe="",
    private readonly browserHeaders:CoinGlassBrowserHeaders={}
  ){}

  async capture(sourceUrl:string,range:CoinGlassHeatmapRange){
    const parsed=parseCoinGlassHeatmapUrl(sourceUrl);
    const rule=coinGlassHeatmapRanges[range];
    const capturedAtMs=this.now();
    const url=new URL("/api/index/v2/liqHeatMap",this.base);
    for(const [key,value] of Object.entries({merge:"true",symbol:parsed.symbol,interval:rule.interval,limit:String(rule.limit),data:coinGlassWebSignature(capturedAtMs)}))url.searchParams.set(key,value);
    const controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(),30_000);
    try{
      const response=await this.fetchImpl(url,{signal:controller.signal,headers:{
        accept:"application/json",language:"en",encryption:"true","cache-ts-v2":String(capturedAtMs),
        origin:"https://www.coinglass.com",referer:"https://www.coinglass.com/",...this.browserHeaders,
        ...(this.obe?{obe:this.obe}:{})
      }});
      if(!response.ok)throw new Error(`CoinGlass free web Heatmap returned HTTP ${response.status}`);
      const body=await response.text();
      if(body.length>12*1024*1024)throw new Error("CoinGlass Heatmap response exceeds the safety limit");
      const envelope=JSON.parse(body) as CoinGlassEncryptedEnvelope;
      if(String(envelope.code)!=="0"||!envelope.data)throw new Error(`CoinGlass free web Heatmap rejected request (${envelope.code}${envelope.msg?`: ${envelope.msg}`:""})`);
      if(response.headers.get("encryption")!=="true"||response.headers.get("v")!=="0")throw new Error("CoinGlass free web Heatmap returned an unsupported encryption version");
      const encryptedSessionKey=response.headers.get("user");
      if(!encryptedSessionKey)throw new Error("CoinGlass free web Heatmap omitted its response key");
      const firstKey=Buffer.from(String(capturedAtMs)).toString("base64").slice(0,16);
      const sessionKey=decryptCoinGlassValue(encryptedSessionKey,firstKey);
      const data=JSON.parse(decryptCoinGlassValue(envelope.data,sessionKey)) as NonNullable<CoinGlassWebHeatmapPayload["data"]>;
      const payload:CoinGlassWebHeatmapPayload={code:envelope.code,msg:envelope.msg,success:envelope.success,data};
      const normalized=normalizeCoinGlassWebHeatmap(payload);
      return {...normalized,sourceUrl:buildCoinGlassHeatmapPageUrl(parsed.url,range),capturedAt:new Date(capturedAtMs)};
    }finally{clearTimeout(timeout);}
  }
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
