import { getConfig } from "@huxtrade/config";
import { BrowserFetchTransport } from "./browser-fetch-transport.js";
import { OmniBrowserAdapter } from "./omni-adapter.js";

// Withdraws every working entry order. Reduce-only protections are left alone —
// the venue reaps them once their entry is gone, and cancelling a stop while a
// position could still exist is the one way this could make things worse.
const config=getConfig();
const transport=new BrowserFetchTransport(config);
const adapter=new OmniBrowserAdapter(transport,config);
const results=await adapter.cancelPending();
console.log(`撤单 ${results.length} 张：`);
for(const r of results)console.log(`  ${r.id}  ${r.cancelled?"已撤":"失败"}`);
await transport.close?.();
process.exit(results.some((r)=>!r.cancelled)?1:0);
