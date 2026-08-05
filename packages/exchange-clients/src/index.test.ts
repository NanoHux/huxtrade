import { createCipheriv } from "node:crypto";
import { gzipSync } from "node:zlib";
import { afterEach,describe,expect,it,vi } from "vitest";
import { BinanceFuturesClient,buildCoinGlassHeatmapPageUrl,CoinGlassFreeWebClient,normalizeCoinGlassWebHeatmap,parseCoinGlassHeatmapUrl } from "./index.js";

const trade=(id:number,time:number)=>({a:id,p:"100",q:"1",T:time,m:false});

describe("Binance futures client",()=>{
  afterEach(()=>vi.unstubAllGlobals());

  it("fails closed instead of calculating CVD from a truncated aggregate-trade window",async()=>{
    let request=0;
    vi.stubGlobal("fetch",vi.fn(async()=>{
      request+=1;
      const start=(request-1)*1000;
      return new Response(JSON.stringify(Array.from({length:1000},(_,index)=>trade(start+index,index+1))),{status:200,headers:{"content-type":"application/json"}});
    }));
    const client=new BinanceFuturesClient("https://example.test",2);
    await expect(client.aggregateTrades("BTCUSDT",0,10_000)).rejects.toThrow(/refusing incomplete CVD/);
  });

  it("returns the complete window when Binance indicates the last page",async()=>{
    vi.stubGlobal("fetch",vi.fn(async()=>new Response(JSON.stringify([trade(1,100),trade(2,200)]),{status:200,headers:{"content-type":"application/json"}})));
    const client=new BinanceFuturesClient("https://example.test",2);
    await expect(client.aggregateTrades("BTCUSDT",0,300)).resolves.toHaveLength(2);
  });
});

describe("CoinGlass free web Heatmap",()=>{
  const encrypt=(text:string,key:string)=>{
    const cipher=createCipheriv("aes-128-ecb",Buffer.from(key),null);
    return Buffer.concat([cipher.update(gzipSync(Buffer.from(text))),cipher.final()]).toString("base64");
  };

  it("validates and normalizes the operator-provided pair URL",()=>{
    expect(parseCoinGlassHeatmapUrl("https://www.coinglass.com/pro/futures/LiquidationHeatMap?coin=sol&type=pair")).toMatchObject({coin:"SOL",symbol:"Binance_SOLUSDT"});
    expect(buildCoinGlassHeatmapPageUrl("https://www.coinglass.com/pro/futures/LiquidationHeatMap?coin=SOL&type=pair","7d")).toContain("time=w1");
  });

  it("rejects non-CoinGlass URLs and non-pair pages",()=>{
    expect(()=>parseCoinGlassHeatmapUrl("https://example.com/pro/futures/LiquidationHeatMap?coin=BTC&type=pair")).toThrow(/coinglass/i);
    expect(()=>parseCoinGlassHeatmapUrl("https://www.coinglass.com/pro/futures/LiquidationHeatMap?coin=BTC&type=symbol")).toThrow(/type=pair/);
  });

  it("converts the web response liq/y arrays into ranked price regions",()=>{
    const result=normalizeCoinGlassWebHeatmap({code:"0",data:{y:[99,100,101],prices:[],liq:[[0,1,2],[1,1,3],[1,2,10],[2,0,1]]}});
    expect(result.regions[0]).toMatchObject({price:101,lowPrice:100.5,highPrice:101.5,intensity:10,rank:1});
    expect(result.regions.find((region)=>region.price===100)?.intensity).toBe(5);
  });

  it("fails closed on login rejection or empty data",()=>{
    expect(()=>normalizeCoinGlassWebHeatmap({code:"40000",msg:"40000"})).toThrow(/rejected/);
    expect(()=>normalizeCoinGlassWebHeatmap({code:"0",data:{y:[1],prices:[],liq:[]}})).toThrow(/no liquidation regions/);
  });

  it("reproduces and decrypts the free web request without cookies",async()=>{
    const now=1_785_904_874_290;
    const firstKey=Buffer.from(String(now)).toString("base64").slice(0,16);
    const sessionKey="d663d1901f9e4975";
    const raw={y:[99,100,101],prices:Array.from({length:288},()=>[1,2,3,4]),liq:[[0,1,2],[1,1,3],[1,2,10]] as Array<[number,number,number]>};
    const request=vi.fn(async(input:URL|RequestInfo,init?:RequestInit)=>{
      const url=new URL(String(input));
      expect(url.searchParams.get("symbol")).toBe("Binance_BTCUSDT");
      expect(url.searchParams.get("interval")).toBe("5");
      expect(url.searchParams.get("limit")).toBe("288");
      expect(url.searchParams.get("data")).toMatch(/^[A-Za-z0-9+/]+=*$/);
      const headers=new Headers(init?.headers);
      expect(headers.get("encryption")).toBe("true");
      expect(headers.get("cache-ts-v2")).toBe(String(now));
      expect(headers.has("cookie")).toBe(false);
      expect(headers.get("user-agent")).toBe("CoinGlass-HAR-UA");
      expect(headers.get("sec-ch-ua")).toBe('"Chromium";v="150"');
      return new Response(JSON.stringify({code:"0",msg:"success",success:true,data:encrypt(JSON.stringify(raw),sessionKey)}),{status:200,headers:{
        encryption:"true",v:"0",user:encrypt(sessionKey,firstKey)
      }});
    });
    const result=await new CoinGlassFreeWebClient("https://capi.coinglass.com",request as typeof fetch,()=>now,"",{
      "user-agent":"CoinGlass-HAR-UA","sec-ch-ua":'"Chromium";v="150"'
    }).capture("https://www.coinglass.com/pro/futures/LiquidationHeatMap?coin=BTC&type=pair","24h");
    expect(request).toHaveBeenCalledOnce();
    expect(result.raw!.liq).toHaveLength(3);
    expect(result.regions[0]).toMatchObject({price:101,intensity:10,rank:1});
  });

  it("fails closed when CoinGlass changes the response encryption version",async()=>{
    const request=vi.fn(async()=>new Response(JSON.stringify({code:"0",data:"encrypted"}),{headers:{encryption:"true",v:"2",user:"key"}}));
    await expect(new CoinGlassFreeWebClient("https://capi.coinglass.com",request as typeof fetch).capture("https://www.coinglass.com/pro/futures/LiquidationHeatMap?coin=BTC&type=pair","24h")).rejects.toThrow(/unsupported encryption version/);
  });
});
