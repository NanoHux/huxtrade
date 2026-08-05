import { coinGlassBrowserHeaderNames,type CoinGlassBrowserHeaders } from "@huxtrade/exchange-clients";

export type CoinGlassHarSession={obe:string;browserHeaders:CoinGlassBrowserHeaders};

export function extractCoinGlassSessionFromHar(input:unknown):CoinGlassHarSession{
  if(!input||typeof input!=="object")throw new Error("HAR root must be an object");
  const entries=(input as {log?:{entries?:unknown}}).log?.entries;
  if(!Array.isArray(entries))throw new Error("HAR has no log.entries array");
  for(const item of [...entries].reverse()){
    if(!item||typeof item!=="object")continue;
    const request=(item as {request?:unknown}).request;
    if(!request||typeof request!=="object")continue;
    const {url,headers} = request as {url?:unknown;headers?:unknown};
    if(typeof url!=="string"||!Array.isArray(headers))continue;
    let parsed:URL;
    try{parsed=new URL(url);}catch{continue;}
    if(parsed.hostname!=="capi.coinglass.com"||parsed.pathname!=="/api/index/v2/liqHeatMap")continue;
    const normalized=new Map<string,string>();
    for(const candidate of headers){
      if(!candidate||typeof candidate!=="object")continue;
      const {name,value}=candidate as {name?:unknown;value?:unknown};
      if(typeof name==="string"&&typeof value==="string")normalized.set(name.toLowerCase(),value);
    }
    const obe=normalized.get("obe");
    const userAgent=normalized.get("user-agent");
    if(typeof obe!=="string"||!/^\S{8,4096}$/.test(obe)||typeof userAgent!=="string"||!/Chrome\//.test(userAgent))continue;
    const browserHeaders:CoinGlassBrowserHeaders={};
    for(const name of coinGlassBrowserHeaderNames){
      const value=normalized.get(name);
      if(value&&value.length<=1024&&!/[\r\n]/.test(value))browserHeaders[name]=value;
    }
    return {obe,browserHeaders};
  }
  throw new Error("HAR contains no CoinGlass liqHeatMap request with an obe header and browser fingerprint");
}

export function extractCoinGlassObeFromHar(input:unknown){return extractCoinGlassSessionFromHar(input).obe;}
