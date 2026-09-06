import { getConfig } from "@huxtrade/config";
import { BrowserFetchTransport } from "./browser-fetch-transport.js";

// Read-only: every order still working at the venue, whatever its type.
const transport=new BrowserFetchTransport(getConfig());
const raw=await transport.request("/api/orders/v2?status=pending&limit=100&offset=0&order_by=created_at&order=desc");
const rows=(raw as {result?:Array<Record<string,unknown>>})?.result??[];
console.log(`${rows.length} 张挂单`);
for(const o of rows){
  const inst=o.instrument as Record<string,unknown>|undefined;
  console.log(`  ${String(inst?.underlying??"?").padEnd(10)} ${String(o.order_type??"").padEnd(12)} ${String(o.side??"").padEnd(5)} qty ${o.qty} @ ${o.limit_price??o.trigger_price??"-"}  rfq ${o.rfq_id}  ${o.created_at}`);
}
await transport.close?.();
process.exit(0);
