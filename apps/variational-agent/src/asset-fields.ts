import { getConfig } from "@huxtrade/config";
import { BrowserFetchTransport } from "./browser-fetch-transport.js";

// Read-only: does the venue advertise close-only markets, or is the only way
// to find out to have an order rejected?
const transport=new BrowserFetchTransport(getConfig());
const raw=await transport.request("/api/metadata/supported_assets") as Record<string,Array<Record<string,unknown>>>;
const gua=raw.GUA?.[0]??{};
console.log("GUA 的全部字段：");
for(const [k,v] of Object.entries(gua))console.log(`  ${k.padEnd(30)} ${JSON.stringify(v).slice(0,70)}`);
const flags=new Set<string>();
for(const rows of Object.values(raw))for(const k of Object.keys(rows?.[0]??{}))flags.add(k);
console.log(`\n所有资产共出现过的字段：${[...flags].join(" ")}`);
await transport.close?.();
process.exit(0);
