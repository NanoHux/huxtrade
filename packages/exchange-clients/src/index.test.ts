import { afterEach,describe,expect,it,vi } from "vitest";
import { BinanceFuturesClient,buildCoinGlassHeatmapPageUrl,normalizeCoinGlassWebHeatmap,parseCoinGlassHeatmapUrl,variationalUnderlying } from "./index.js";

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
});

describe("Variational venue symbols",()=>{
  it("takes the ticker from the operator's URL, not from the Binance symbol",()=>{
    // The bug this exists for: LIT trades as LIGHTER, and "LIT" was rejected
    // with {"error_message":"asset: Asset not supported"} on every submission.
    expect(variationalUnderlying("https://omni.variational.io/perpetual/LIGHTER","LITUSDT")).toBe("LIGHTER");
    expect(variationalUnderlying("https://omni.variational.io/perpetual/AAVE","AAVEUSDT")).toBe("AAVE");
    // Lower-case market paths and a stray leading space both occur in real rows.
    expect(variationalUnderlying("https://trade.variational.io/markets/btc","BTCUSDT")).toBe("BTC");
    expect(variationalUnderlying(" https://omni.variational.io/perpetual/ZEC ","ZECUSDT")).toBe("ZEC");
  });

  it("falls back to the Binance base when the URL cannot say",()=>{
    expect(variationalUnderlying(null,"SOLUSDT")).toBe("SOL");
    expect(variationalUnderlying("","ETHUSDT")).toBe("ETH");
    expect(variationalUnderlying("not a url","DOGEUSDT")).toBe("DOGE");
    expect(variationalUnderlying("https://omni.variational.io/","XPLUSDT")).toBe("XPL");
    // A path segment that is not a plausible ticker is ignored rather than trusted.
    expect(variationalUnderlying("https://omni.variational.io/perpetual/a-very-long-slug-here","UNIUSDT")).toBe("UNI");
  });
});

describe("single-character tickers",()=>{
  it("accepts a one-character coin, which is a real ticker and not a typo",()=>{
    // "4" trades as 4USDT; a two-character minimum rejected the whole asset
    // with an unexplained VALIDATION_ERROR.
    expect(parseCoinGlassHeatmapUrl("https://www.coinglass.com/pro/futures/LiquidationHeatMap?coin=4&type=pair"))
      .toMatchObject({coin:"4",symbol:"Binance_4USDT"});
    expect(variationalUnderlying("https://omni.variational.io/perpetual/4","4USDT")).toBe("4");
  });

  it("still rejects a coin parameter that is not a ticker at all",()=>{
    expect(()=>parseCoinGlassHeatmapUrl("https://www.coinglass.com/pro/futures/LiquidationHeatMap?coin=&type=pair")).toThrow(/invalid coin/);
    expect(()=>parseCoinGlassHeatmapUrl("https://www.coinglass.com/pro/futures/LiquidationHeatMap?coin=BTC-PERP&type=pair")).toThrow(/invalid coin/);
  });
});
