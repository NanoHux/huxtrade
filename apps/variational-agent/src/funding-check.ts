import { getConfig } from "@huxtrade/config";
import { BrowserFetchTransport } from "./browser-fetch-transport.js";
import { binanceGainers, parseVenueAssets, stripQuote } from "./gainers-core.js";

// What a short on today's gainers board would pay to be held nine hours.
const transport=new BrowserFetchTransport(getConfig());
const raw=await transport.request("/api/metadata/supported_assets") as Record<string,Array<Record<string,unknown>>>;
const venue=parseVenueAssets(raw);
const ranked=await binanceGainers();
const rates=Object.entries(raw).map(([asset,rows])=>({asset,rate:Number(rows?.[0]?.funding_rate),interval:Number(rows?.[0]?.funding_interval_s)}))
  .filter((r)=>Number.isFinite(r.rate));
const median=[...rates].sort((a,b)=>a.rate-b.rate)[Math.floor(rates.length/2)]!;
console.log(`全平台 ${rates.length} 个资产的资金费率中位数 ${median.rate}（区间 ${median.interval}s）\n`);
console.log("今天涨幅榜前 8 在 Variational 的资金费率：");
for(const t of ranked.slice(0,8)){
  const base=stripQuote(t.symbol),row=raw[base]?.[0];
  if(!row){console.log(`  ${base.padEnd(10)}${Number(t.priceChangePercent).toFixed(1).padStart(7)}%   平台无此币`);continue;}
  const rate=Number(row.funding_rate),interval=Number(row.funding_interval_s);
  const perNine=rate*(9*3600/interval);
  console.log(`  ${base.padEnd(10)}${Number(t.priceChangePercent).toFixed(1).padStart(7)}%   费率 ${rate}／${interval/3600}h   持 9 小时约付 ${perNine.toFixed(3)}${venue.get(base)?.tradable?"":"  (只减仓/未上市)"}`);
}
await transport.close?.();
process.exit(0);
