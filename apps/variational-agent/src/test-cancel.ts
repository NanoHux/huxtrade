import { getConfig } from "@huxtrade/config";
import { BrowserFetchTransport } from "./browser-fetch-transport.js";
import { OmniBrowserAdapter } from "./omni-adapter.js";

// Companion to test-order.ts for Stage 0 protocol discovery (DISCOVERY.md
// item 3: active cancel). Operator-run only, never part of the automated loop.
const [rfqId]=process.argv.slice(2).filter((arg)=>arg!=="--");
if(!rfqId){console.error("Usage: test-cancel <entryRfqId>");process.exit(1);}

const config=getConfig();
const transport=new BrowserFetchTransport(config);
const adapter=new OmniBrowserAdapter(transport,config);
try{
  console.log(`Cancelling ${rfqId}...`);
  const result=await adapter.cancelEntry(rfqId);
  console.log(JSON.stringify(result,null,2));
}finally{
  await transport.close();
  process.exit(0);
}
