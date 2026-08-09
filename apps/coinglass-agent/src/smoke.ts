import { getConfig } from "@huxtrade/config";
import { type CoinGlassHeatmapRange } from "@huxtrade/exchange-clients";
import { CoinGlassBrowserClient } from "./browser-capture.js";

const config=getConfig();
const collector=new CoinGlassBrowserClient(config);
const range=(process.env.COINGLASS_SMOKE_RANGE??"24h") as CoinGlassHeatmapRange;
const urls=process.argv.slice(2);
if(!urls.length)throw new Error("Pass one or more CoinGlass Model 1 Pair Heatmap URLs");

let failures=0;
for(const url of urls){
  try{
    const result=await collector.capture(url,range);
    console.log(JSON.stringify({ok:true,url,range,capturedAt:result.capturedAt.toISOString(),regionCount:result.regions.length,strongest:result.regions.slice(0,3).map((region)=>({price:region.price,intensity:region.intensity,rank:region.rank}))}));
  }catch(error){
    failures+=1;
    console.error(JSON.stringify({ok:false,url,range,error:error instanceof Error?error.message:String(error)}));
  }
}
await collector.close();
// Playwright's CDP transport can leave an open WebSocket handle even after
// close(), keeping the event loop alive indefinitely for a CLI tool that
// should have exited already.
process.exit(failures?1:0);
