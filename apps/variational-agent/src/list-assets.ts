import { getConfig } from "@huxtrade/config";
import { BrowserFetchTransport } from "./browser-fetch-transport.js";

// Read-only. Prints what Variational actually lists, which is the input the
// gainers strategy needs before any of its picks can be acted on.
const transport=new BrowserFetchTransport(getConfig());
const raw=await transport.request("/api/metadata/supported_assets");
// The payload is keyed by asset, each value an array of listings. Variational
// carries its own 24h change, which the gainers rule can rank directly.
const map=raw as Record<string,Array<Record<string,unknown>>>;
const rows=Object.entries(map).map(([asset,entries])=>{
  const first=entries?.[0]??{};
  return {asset,change:Number(first.price_change_percentage_24h),volume:Number(first.volume_24h),price:Number(first.price)};
}).filter((r)=>Number.isFinite(r.change));
console.log(`${Object.keys(map).length} assets listed, ${rows.length} with a 24h change`);
console.log(JSON.stringify(rows.map((r)=>r.asset)));
console.log("\nVariational 自己的涨幅榜前 12：");
for(const r of [...rows].sort((a,b)=>b.change-a.change).slice(0,12))
  console.log(`  ${r.asset.padEnd(12)}${r.change.toFixed(2).padStart(8)}%   24h量 ${Math.round(r.volume).toLocaleString()}`);
await transport.close?.();
process.exit(0);
