/**
 * How much of the Binance gainers list Variational can actually fill.
 *
 * The venue lists 534 assets; our database tracks 46 of them, and an earlier
 * pass that measured coverage against those 46 concluded 80% of picks were
 * unreachable. That was a fact about our watchlist, not about the venue.
 */
import { readFileSync } from "node:fs";
const DIR="/private/tmp/claude-501/-Users-hux-Desktop-huxtrade/499bb97e-f722-4740-975b-f921f3a83a72/scratchpad";
type H=[number,number,number];type D=[number,number,number,number,number,number];
const hourly=JSON.parse(readFileSync(`${DIR}/hourly1h.json`,"utf8")) as Record<string,H[]>;
const daily=JSON.parse(readFileSync(`${DIR}/histohlc.json`,"utf8")) as Record<string,D[]>;
const listed=new Set(JSON.parse(readFileSync(`${DIR}/vari_assets.json`,"utf8")) as string[]);
const symbols=Object.keys(hourly);
const HOUR=3_600_000,DAY=86_400_000,LIQUID=200,N=5,ENTRY=14;
const hI=new Map(symbols.map((s)=>[s,new Map(hourly[s]!.map((r)=>[Math.floor(r[0]/HOUR)*HOUR,r]))]));
const dI=new Map(symbols.filter((s)=>daily[s]).map((s)=>[s,new Map(daily[s]!.map((r)=>[Math.floor(r[0]/DAY)*DAY,r]))]));
const H_=(s:string,t:number)=>hI.get(s)?.get(Math.floor(t/HOUR)*HOUR)??null;
const D_=(s:string,t:number)=>dI.get(s)?.get(Math.floor(t/DAY)*DAY)??null;
/** Binance quotes in USDT; Variational names the bare underlying. */
const base=(sym:string)=>sym.replace(/USDT$/,"");
const all=[...new Set(symbols.flatMap((s)=>hourly[s]!.map((r)=>Math.floor(r[0]/HOUR)*HOUR)))].sort((a,b)=>a-b);
const FIRST=all[0]!+31*DAY,LAST=all.at(-1)!;

const counts=new Map<number,number>();const missing=new Map<string,number>();let days=0,matched=0;
for(let d=Math.ceil(FIRST/DAY)*DAY;d<LAST-DAY;d+=DAY){
  const t=d+ENTRY*HOUR;if(t>LAST)break;
  const pool:Array<{s:string;vol:number}>=[];
  for(const s of symbols){let v=0,k=0;for(let i=1;i<=30;i+=1){const r=D_(s,t-i*DAY);if(r){v+=r[5];k+=1;}}if(k>=25)pool.push({s,vol:v/k});}
  const liquid=pool.sort((a,b)=>b.vol-a.vol).slice(0,LIQUID);
  const ranked:Array<{s:string;ret:number}>=[];
  for(const {s} of liquid){const now=H_(s,t-HOUR),past=H_(s,t-HOUR-24*HOUR);
    if(now&&past&&past[2]>0)ranked.push({s,ret:(now[2]-past[2])/past[2]});}
  if(ranked.length<2*N)continue;
  ranked.sort((a,b)=>b.ret-a.ret);
  const top=ranked.slice(0,N).map((x)=>base(x.s));
  const hit=top.filter((b)=>listed.has(b));
  for(const b of top)if(!listed.has(b))missing.set(b,(missing.get(b)??0)+1);
  counts.set(hit.length,(counts.get(hit.length)??0)+1);
  days+=1;matched+=hit.length;
}
console.log(`Variational 上市 ${listed.size} 个资产。过去 ${days} 天，每天 Binance 涨幅榜前 ${N} 里能买到几个：\n`);
for(let k=N;k>=0;k-=1){
  const n=counts.get(k)??0;
  console.log(`  ${k} 个   ${String(n).padStart(4)} 天  ${(100*n/days).toFixed(1).padStart(5)}%  ${"█".repeat(Math.round(60*n/days))}`);
}
console.log(`\n平均每天买得到 ${(matched/days).toFixed(2)} / ${N} 个（覆盖率 ${(100*matched/(days*N)).toFixed(0)}%）`);
console.log(`\n最常买不到的：${[...missing].sort((a,b)=>b[1]-a[1]).slice(0,10).map(([s,n])=>`${s}(${n})`).join("  ")}`);
process.exit(0);
