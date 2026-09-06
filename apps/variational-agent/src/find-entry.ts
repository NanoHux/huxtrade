import { getConfig } from "@huxtrade/config";
import { BrowserFetchTransport } from "./browser-fetch-transport.js";

// Read-only: the entry rfq behind an open position, which closeMarket needs
// and which the pending-orders list cannot show once the entry has filled.
const want=(process.argv.slice(2).filter((a)=>a!=="--")[0]??"").toUpperCase();
const transport=new BrowserFetchTransport(getConfig());
const raw=await transport.request("/api/trades?limit=100&offset=0&order_by=created_at&order=desc");
const rows=(raw as {result?:Array<Record<string,unknown>>})?.result??[];
for(const t of rows){
  const under=String((t.instrument as Record<string,unknown>|undefined)?.underlying??"");
  if(want&&under!==want)continue;
  console.log(`${under.padEnd(10)} ${String(t.side).padEnd(5)} qty ${String(t.qty).padEnd(14)} @ ${String(t.price).padEnd(12)} source_rfq ${t.source_rfq}  ${t.created_at}`);
}
await transport.close?.();
process.exit(0);
