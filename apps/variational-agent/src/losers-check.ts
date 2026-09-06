import { getConfig } from "@huxtrade/config";
import { BrowserFetchTransport } from "./browser-fetch-transport.js";
import { binanceGainers, parseVenueAssets, stripQuote } from "./gainers-core.js";

// The pair needs the losers board to be shortable, which the backtest cannot
// check: only today's close-only flags exist, not last year's.
const transport=new BrowserFetchTransport(getConfig());
const venue=parseVenueAssets(await transport.request("/api/metadata/supported_assets"));
const ranked=await binanceGainers();
const losers=[...ranked].reverse().slice(0,10);
let ok=0;
console.log("今天跌幅榜前 10 在 Variational 的可做空状态：");
for(const t of losers){
  const base=stripQuote(t.symbol),listing=venue.get(base);
  const state=!listing?"未上市":listing.tradable?"可开仓":"只减仓/非永续";
  if(listing?.tradable)ok+=1;
  console.log(`  ${base.padEnd(10)}${Number(t.priceChangePercent).toFixed(1).padStart(8)}%   ${state}`);
}
console.log(`\n前 10 里 ${ok} 个可做空`);
await transport.close?.();
process.exit(0);
