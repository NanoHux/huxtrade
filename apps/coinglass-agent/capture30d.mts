import { writeFile } from "node:fs/promises";
import { getConfig } from "@huxtrade/config";
import { coinGlassHeatmapByTime } from "@huxtrade/exchange-clients";
import { CoinGlassBrowserClient } from "./src/browser-capture.js";
const config=getConfig();
const client=new CoinGlassBrowserClient(config);
const out:Record<string,unknown>={};
const codes=process.argv.slice(2);
for(const [i,code] of codes.entries()){
  const url=`https://www.coinglass.com/pro/futures/LiquidationHeatMap?coin=${code}&type=pair`;
  try{
    const r=await client.capture(url,"30d");
    const slices=coinGlassHeatmapByTime({code:"0",data:r.raw as never});
    out[code]=slices.map((s)=>({at:s.at.getTime(),price:s.price,
      regions:s.regions.map((g)=>({p:g.price,lo:g.lowPrice,hi:g.highPrice,i:g.intensity,pc:g.percentile,rk:g.rank}))}));
    console.log(`${i+1}/${codes.length} ${code}: ${slices.length} 个时间点`);
  }catch(e){console.log(`${i+1}/${codes.length} ${code} FAILED: ${e instanceof Error?e.message:String(e)}`);}
}
await writeFile("/tmp/heatmap30d.json",JSON.stringify(out));
console.log("---DONE---");
process.exit(0);
