import { getConfig } from "@huxtrade/config";
import { BrowserFetchTransport } from "./browser-fetch-transport.js";

// What the account was actually charged, rather than what a rate field implies.
const transport=const_transport();
function const_transport(){return new BrowserFetchTransport(getConfig());}
const raw=await transport.request("/api/transfers?limit=100&offset=0&order_by=created_at&order=desc");
const rows=(raw as {result?:Array<Record<string,unknown>>})?.result??[];
const kinds=new Map<string,{n:number;sum:number}>();
for(const t of rows){
  const kind=String(t.transfer_type??"?"),qty=Number(t.qty);
  const cur=kinds.get(kind)??{n:0,sum:0};
  kinds.set(kind,{n:cur.n+1,sum:cur.sum+(Number.isFinite(qty)?qty:0)});
}
console.log("最近 100 条划转，按类型汇总：");
for(const [kind,v] of kinds)console.log(`  ${kind.padEnd(22)} ${String(v.n).padStart(4)} 笔   合计 ${v.sum.toFixed(4)}`);
console.log("\n资金费明细：");
for(const t of rows.filter((x)=>String(x.transfer_type??"").includes("funding")).slice(0,12)){
  const inst=t.instrument as Record<string,unknown>|undefined;
  console.log(`  ${String(inst?.underlying??"?").padEnd(9)} ${String(t.qty).padStart(14)}  ${t.created_at}`);
}
await transport.close?.();
process.exit(0);
