import { getConfig } from "@huxtrade/config";
import { BrowserFetchTransport } from "./browser-fetch-transport.js";

// Read-only: exactly what closeAllPositions would flatten.
const transport=new BrowserFetchTransport(getConfig());
const rows=await transport.request("/api/positions") as Array<Record<string,unknown>>;
for(const row of rows){
  const info=row.position_info as Record<string,unknown>|undefined;
  const inst=info?.instrument as Record<string,unknown>|undefined;
  console.log(`  ${String(inst?.underlying??"?").padEnd(9)} qty ${String(info?.qty).padEnd(12)} 均价 ${String(info?.avg_entry_price).padEnd(14)} 浮盈 ${row.upnl}`);
}
console.log(`共 ${rows.length} 个持仓`);
await transport.close?.();
process.exit(0);
