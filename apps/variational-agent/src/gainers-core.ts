import { randomUUID } from "node:crypto";
import { query } from "@huxtrade/database";
import { gainersStrategy, type OrderPlan } from "@huxtrade/shared-types";

/**
 * The gainers basket, shared by the operator CLI and the scheduler.
 *
 * Both paths must select and size identically — a scheduler that drifts from
 * the command you tested is a strategy nobody has actually checked — so the
 * selection lives here once and neither caller reimplements it.
 *
 * The numbers themselves live in shared-types, because the settings page
 * describes them in prose and a second copy is a second thing to forget.
 *
 * Sizing note: the legs are submitted one after another, so DEPLOY_FRACTION's
 * remainder is what lets the last order still fit after the earlier ones have
 * moved. At 0.95 that buffer is thin — if a basket comes back with its final
 * legs rejected for margin, this is the number to look at first.
 *
 * Clock note: UTC+8 23:55 in, 07:55 out — UTC 15:55 plus an eight-hour hold.
 * Five minutes before midnight rather than on the hour, because every
 * clock-driven participant acts at once and that cost lands in the fill.
 */
export const {
  leverage:LEVERAGE, basket:BASKET, stopFraction:STOP_FRACTION,
  takeProfitFraction:TAKE_PROFIT_FRACTION, longWeight:LONG_WEIGHT,
  deployFraction:DEPLOY_FRACTION, lookbackHours:LOOKBACK_HOURS,
  openHourUtc:OPEN_HOUR_UTC, openMinuteUtc:OPEN_MINUTE_UTC, holdHours:HOLD_HOURS
}=gainersStrategy;
export type Ticker={symbol:string;priceChangePercent:string;quoteVolume:string;lastPrice:string};
export type VenueAsset={price:number;change:number;tradable:boolean};
export type Direction="LONG"|"SHORT";
export type Pick={base:string;binanceSymbol:string;changePercent:number;venuePrice?:number;direction?:Direction};

export const stripQuote=(symbol:string)=>symbol.replace(/USDT$/,"");

/** Venue names from assets.variational_url — the last path segment is the real ticker. */
export function aliasesFrom(rows:Array<{binance_symbol:string;variational_url:string}>){
  const map=new Map<string,string>();
  for(const row of rows){
    const venueName=row.variational_url.split("/").filter(Boolean).at(-1);
    const base=stripQuote(row.binance_symbol);
    if(venueName&&venueName!==base)map.set(base,venueName);
  }
  return map;
}

/**
 * Pull the latest klines from Binance and upsert into klines_1h.
 *
 * For each symbol, fetches from the last stored bar forward. On a warm DB this
 * is just the last hour or two; on a cold DB this is a no-op (run the backfill
 * script first).
 */
export async function refreshKlines():Promise<number>{
  const tickerRes=await fetch("https://fapi.binance.com/fapi/v1/ticker/24hr");
  if(!tickerRes.ok)throw new Error(`Binance ticker ${tickerRes.status}`);
  const tickers=await tickerRes.json() as Ticker[];
  const symbols=tickers.filter((r)=>r.symbol.endsWith("USDT")).map((r)=>r.symbol);

  const maxRows=await query<{symbol:string;max:string}>(
    "SELECT symbol,MAX(open_time)::text AS max FROM klines_1h GROUP BY symbol");
  const maxMap=new Map(maxRows.rows.map((r)=>[r.symbol,Number(r.max)]));

  const endTime=Date.now();
  let totalInserted=0;
  const BATCH=20;

  for(let i=0;i<symbols.length;i+=BATCH){
    const batch=symbols.slice(i,i+BATCH);
    const results=await Promise.all(batch.map(async(s)=>{
      const last=maxMap.get(s);
      if(!last)return[];
      const startTime=last+3_600_000;
      if(startTime>=endTime)return[];
      try{
        const res=await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${s}&interval=1h&startTime=${startTime}&limit=100`);
        if(!res.ok)return[];
        const data=await res.json() as number[][];
        return data.map((k)=>({symbol:s,openTime:k[0]!,open:Number(k[1]),high:Number(k[2]),low:Number(k[3]),close:Number(k[4]),vol:Number(k[7]!)}));
      }catch{return[];}
    }));
    for(const bars of results){
      if(!bars.length)continue;
      const values:unknown[]=[];
      const ph:string[]=[];
      for(let j=0;j<bars.length;j++){
        const b=bars[j]!;
        const off=j*7;
        ph.push(`($${off+1},$${off+2},$${off+3},$${off+4},$${off+5},$${off+6},$${off+7})`);
        values.push(b.symbol,b.openTime,b.open,b.high,b.low,b.close,b.vol);
      }
      await query(`INSERT INTO klines_1h(symbol,open_time,open,high,low,close,quote_volume) VALUES ${ph.join(",")} ON CONFLICT(symbol,open_time) DO NOTHING`,values);
      totalInserted+=bars.length;
    }
  }
  return totalInserted;
}

export async function binanceGainers():Promise<Ticker[]>{
  const tickerRes=await fetch("https://fapi.binance.com/fapi/v1/ticker/24hr");
  if(!tickerRes.ok)throw new Error(`Binance ticker ${tickerRes.status}`);
  const tickers=await tickerRes.json() as Ticker[];
  const usdtTickers=tickers.filter((r)=>r.symbol.endsWith("USDT"));

  const pastHour=Date.now()-LOOKBACK_HOURS*3600_000;
  const startTime=pastHour-pastHour%3600_000;

  const pastPrices=await query<{symbol:string;open:string}>(
    "SELECT symbol,open::text FROM klines_1h WHERE open_time=$1",[startTime]);
  const priceMap=new Map(pastPrices.rows.map((r)=>[r.symbol,Number(r.open)]));

  const result:Ticker[]=[];
  for(const t of usdtTickers){
    const pastPrice=priceMap.get(t.symbol);
    const currentPrice=Number(t.lastPrice);
    if(!pastPrice||!(pastPrice>0)||!(currentPrice>0))continue;
    const change=((currentPrice-pastPrice)/pastPrice)*100;
    result.push({...t,priceChangePercent:String(change)});
  }

  return result.sort((a,b)=>Number(b.priceChangePercent)-Number(a.priceChangePercent));
}

export function parseVenueAssets(raw:unknown){
  const map=new Map<string,VenueAsset>();
  for(const [asset,rows] of Object.entries(raw as Record<string,Array<Record<string,unknown>>>)){
    const first=rows?.[0];if(!first)continue;
    // Listed is not the same as openable. GUA was advertised at +83.6% and
    // rejected the order with "close-only mode"; the venue says so in the
    // metadata, so the basket can skip it instead of burning a slot finding out.
    const tradable=first.is_close_only_mode!==true&&first.has_perp!==false&&first.instrument_type==="perpetual_future";
    map.set(asset,{price:Number(first.price),change:Number(first.price_change_percentage_24h),tradable});
  }
  return map;
}

/** Names on the venue that look like an unmatched pick — reported, never auto-used. */
export function similarNames(base:string,venue:Map<string,VenueAsset>){
  return [...venue.keys()].filter((a)=>a!==base&&(a.startsWith(base)||base.startsWith(a))&&Math.min(a.length,base.length)>=3);
}

/**
 * How far the two venues' prices may differ and still be the same asset.
 *
 * Wide on purpose. This board selects for the day's most violent movers, and
 * the two venues are read seconds apart on names mid-move, so a same-asset gap
 * of several percent is ordinary rather than evidence of a mismatch. At 2% the
 * check was rejecting real matches: APR topped the board twice in five days and
 * was skipped both times against a listed APRO.
 *
 * The distances that matter are the ones between DIFFERENT assets with similar
 * names, and those are nowhere near 10% — of the near-misses this basket has
 * actually hit, the closest pairs are AIO/AIOT at 29% and SKY/SKYAI at 30%.
 */
export const ALIAS_PRICE_TOLERANCE=0.10;

/**
 * Resolves a near-miss name by corroborating it with price.
 *
 * A name alone is not enough — SKYAI and SKY are different assets whose names
 * pass any prefix test — but two venues quoting the same asset stay within a
 * band of each other. Requiring BOTH a name overlap and a price inside
 * ALIAS_PRICE_TOLERANCE turns a guess into a check, and an ambiguous case (two
 * candidates within tolerance) is refused rather than resolved arbitrarily,
 * because buying the wrong coin costs real money and a skipped leg costs one
 * twentieth of a day.
 */
export function resolveByPrice(base:string,binancePrice:number,venue:Map<string,VenueAsset>){
  if(!(binancePrice>0))return null;
  const hits=similarNames(base,venue)
    .map((name)=>({name,listing:venue.get(name)!}))
    .filter(({listing})=>listing.tradable&&listing.price>0
      &&Math.abs(listing.price-binancePrice)/binancePrice<=ALIAS_PRICE_TOLERANCE);
  return hits.length===1?hits[0]!.name:null;
}

/**
 * Both ends of the board: long the strongest BASKET, short the weakest.
 *
 * Filtering to tradable names BEFORE ranking, not after — taking the top five
 * and then dropping what is missing filled two positions where this fills five,
 * and it is not what the backtest measured.
 */
export function selectPair(ranked:Ticker[],venue:Map<string,VenueAsset>,aliases:Map<string,string>){
  const withVenue=ranked.map((r)=>{
    const raw=stripQuote(r.symbol);
    let base=aliases.get(raw)??raw;
    let listing=venue.get(base);
    if(!listing?.tradable){
      // Only when the plain name fails: a price-corroborated near-miss.
      const resolved=resolveByPrice(base,Number(r.lastPrice),venue);
      if(resolved){base=resolved;listing=venue.get(resolved);}
    }
    return {base,binanceSymbol:r.symbol,changePercent:Number(r.priceChangePercent),
      venuePrice:listing?.price,tradable:Boolean(listing?.tradable&&listing.price>0)};
  });
  const tradable=withVenue.filter((p):p is Pick&{venuePrice:number;tradable:true}=>p.tradable);
  const longs=tradable.slice(0,BASKET).map((p)=>({...p,direction:"LONG" as const}));
  const taken=new Set(longs.map((p)=>p.base));
  const shorts=LONG_WEIGHT>=1
    ?[]
    :[...tradable].reverse().filter((p)=>!taken.has(p.base)).slice(0,BASKET)
      .map((p)=>({...p,direction:"SHORT" as const}));
  const longCut=longs.length?longs[longs.length-1]!.changePercent:Infinity;
  const shortCut=shorts.length?shorts[shorts.length-1]!.changePercent:-Infinity;
  const unmatched=withVenue.filter((p)=>!p.tradable&&(p.changePercent>=longCut||(LONG_WEIGHT<1&&p.changePercent<=shortCut)))
    .map((p)=>({...p,similar:venue.has(p.base)?[]:similarNames(p.base,venue),
      reason:venue.has(p.base)?"平台只减仓/非永续":"平台未上市",
      direction:(p.changePercent>=longCut?"LONG":"SHORT") as Direction}));
  return {longs,shorts,matched:LONG_WEIGHT>=1?longs:interleave(longs,shorts),unmatched};
}

/**
 * Alternates the two sides so the submission order is L,S,L,S,…
 *
 * Legs go in one at a time against a 95%-deployed account, so if margin runs
 * out the rejected orders are whatever sits at the tail. Sending one side
 * first would put the entire other side there, and a basket that loses its
 * whole short leg is directional — the one outcome this strategy exists to
 * avoid. Alternating caps the imbalance at a single leg.
 */
export function interleave<A,B>(longs:A[],shorts:B[]):Array<A|B>{
  const out:Array<A|B>=[];
  for(let i=0;i<Math.max(longs.length,shorts.length);i+=1){
    if(longs[i]!==undefined)out.push(longs[i]!);
    if(shorts[i]!==undefined)out.push(shorts[i]!);
  }
  return out;
}

/**
 * Each leg is sized by its side: longs split LONG_WEIGHT of the budget,
 * shorts split the rest. The caller passes {long, short} per-leg margins.
 */
export function buildPlans(matched:Array<Pick&{venuePrice:number}>,margins:{long:number;short:number}):OrderPlan[]{
  return matched.map((p)=>{
    const long=(p.direction??"LONG")==="LONG";
    const perLeg=long?margins.long:margins.short;
    return {
    idempotencyKey:randomUUID(),symbol:p.binanceSymbol,venueSymbol:p.base,direction:long?"LONG" as const:"SHORT" as const,
    entryPrice:p.venuePrice,
    stopLoss:long?p.venuePrice*(1-STOP_FRACTION):p.venuePrice*(1+STOP_FRACTION),
    takeProfit:long?p.venuePrice*(1+TAKE_PROFIT_FRACTION):p.venuePrice*(1-TAKE_PROFIT_FRACTION),
    expectedRiskReward:0,timeExit:true,marginUsdc:perLeg,leverage:LEVERAGE,notionalUsdc:perLeg*LEVERAGE
  };});
}
