import { describe,expect,it } from "vitest";
import { extractCoinGlassObeFromHar,extractCoinGlassSessionFromHar } from "./har.js";

const browserHeaders=[
  {name:"user-agent",value:"Mozilla/5.0 Chrome/150.0.0.0"},
  {name:"sec-ch-ua",value:'"Chromium";v="150"'}
];

describe("CoinGlass HAR session import",()=>{
  it("extracts only the exact Heatmap request header",()=>{
    expect(extractCoinGlassObeFromHar({log:{entries:[
      {request:{url:"https://example.com/api/index/v2/liqHeatMap",headers:[{name:"obe",value:"wrong-host"}]}},
      {request:{url:"https://capi.coinglass.com/api/index/v2/liqHeatMap?symbol=Binance_ETHUSDT",headers:[{name:"ObE",value:"valid-token-123"},...browserHeaders]}}
    ]}})).toBe("valid-token-123");
    expect(extractCoinGlassSessionFromHar({log:{entries:[
      {request:{url:"https://capi.coinglass.com/api/index/v2/liqHeatMap",headers:[{name:"obe",value:"valid-token-123"},...browserHeaders]}}
    ]}})).toMatchObject({obe:"valid-token-123",browserHeaders:{"user-agent":"Mozilla/5.0 Chrome/150.0.0.0"}});
  });
  it("rejects missing or malformed session headers",()=>{
    expect(()=>extractCoinGlassObeFromHar({log:{entries:[]}})).toThrow(/no CoinGlass/);
    expect(()=>extractCoinGlassObeFromHar({log:{entries:[{request:{url:"https://capi.coinglass.com/api/index/v2/liqHeatMap",headers:[{name:"obe",value:"bad value"},...browserHeaders]}}]}})).toThrow(/no CoinGlass/);
    expect(()=>extractCoinGlassObeFromHar({log:{entries:[{request:{url:"https://capi.coinglass.com/api/index/v2/liqHeatMap",headers:[{name:"obe",value:"valid-token-123"}]}}]}})).toThrow(/browser fingerprint/);
  });
});
