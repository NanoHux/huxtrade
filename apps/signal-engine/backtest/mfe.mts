/**
 * How far each leg ran before the clock closed it, and how much it kept.
 *
 * Answers two things the open/close series could not: what a take-profit could
 * actually have caught, and how much of the run is handed back by holding to
 * the fixed exit. Uses the hourly HIGH for longs and LOW for shorts, so a
 * spike that reversed inside the hour is now counted — the earlier take-profit
 * table used opens and closes only and undercounted every trigger.
 */
import { readFileSync } from "node:fs";
const DIR="/private/tmp/claude-501/-Users-hux-Desktop-huxtrade/499bb97e-f722-4740-975b-f921f3a83a72/scratchpad";
type B=[number,number,number,number,number];   // t,o,h,l,c
type D=[number,number,number,number,number,number];
const daily=JSON.parse(readFileSync(`${DIR}/histohlc.json`,"utf8")) as Record<string,D[]>;
const listed=new Set(JSON.parse(readFileSync(`${DIR}/vari_assets.json`,"utf8")) as string[]);
const VENUE_ONLY=Boolean(process.env.VARI);
const bars=new Map<string,Map<number,B>>();
for(const line of readFileSync(`${DIR}/h1ohlc.ndjson`,"utf8").split("\n")){
  if(!line)continue;
  const [sym,rows]=JSON.parse(line) as [string,B[]];
  if(VENUE_ONLY&&!listed.has(sym.replace("USDT","")))continue;
  bars.set(sym,new Map(rows.map((r)=>[r[0],r])));
}
const symbols=[...bars.keys()];
const HOUR=3_600_000,DAY=86_400_000,LIQUID=200,N=5,LEV=2,ENTRY_UTC=16,HOLD=8;
const dI=new Map(symbols.filter((s)=>daily[s]).map((s)=>[s,new Map(daily[s]!.map((r)=>[Math.floor(r[0]/DAY)*DAY,r]))]));
const B_=(s:string,t:number)=>bars.get(s)?.get(Math.floor(t/HOUR)*HOUR)??null;
const D_=(s:string,t:number)=>dI.get(s)?.get(Math.floor(t/DAY)*DAY)??null;
const stamps=[...new Set(symbols.flatMap((s)=>[...bars.get(s)!.keys()]))].sort((a,b)=>a-b);
const FIRST=stamps[0]!+31*DAY,LAST=stamps.at(-1)!;

type Leg={side:1|-1;mfe:number;mae:number;final:number};
const legs:Leg[]=[];
for(let d=Math.ceil(FIRST/DAY)*DAY;d<LAST-2*DAY;d+=DAY){
  const t=d+ENTRY_UTC*HOUR,exit=t+HOLD*HOUR;
  if(exit>LAST)break;
  const pool:Array<{s:string;vol:number}>=[];
  for(const s of symbols){let v=0,k=0;for(let i=1;i<=30;i+=1){const r=D_(s,d-i*DAY);if(r){v+=r[5];k+=1;}}if(k>=25)pool.push({s,vol:v/k});}
  if(pool.length<2*N)continue;
  const ranked:Array<{s:string;c:number}>=[];
  for(const {s} of pool.sort((a,b)=>b.vol-a.vol).slice(0,LIQUID)){
    const now=B_(s,t-HOUR),past=B_(s,t-HOUR-DAY);
    if(now&&past&&past[4]>0)ranked.push({s,c:(now[4]-past[4])/past[4]});
  }
  if(ranked.length<2*N)continue;
  ranked.sort((a,b)=>b.c-a.c);
  for(const [sym,side] of [...ranked.slice(0,N).map((x)=>[x.s,1] as const),...ranked.slice(-N).map((x)=>[x.s,-1] as const)]){
    const open=B_(sym,t);if(!open||!(open[1]>0))continue;
    const entry=open[1];
    let best=-Infinity,worst=Infinity;
    for(let k=0;k<HOLD;k+=1){
      const bar=B_(sym,t+k*HOUR);if(!bar)continue;
      // Favourable is the high for a long and the low for a short.
      const fav=side>0?bar[2]:bar[3],adv=side>0?bar[3]:bar[2];
      best=Math.max(best,side*(fav-entry)/entry);
      worst=Math.min(worst,side*(adv-entry)/entry);
    }
    const close=B_(sym,exit);
    if(!close||!Number.isFinite(best))continue;
    legs.push({side:side as 1|-1,mfe:best*LEV,mae:worst*LEV,final:side*(close[1]-entry)/entry*LEV});
  }
}

const pct=(x:number)=>`${(100*x).toFixed(1)}%`;
const q=(v:number[],p:number)=>v[Math.min(v.length-1,Math.floor(p*v.length))]!;
function report(label:string,sel:Leg[]){
  const mfe=sel.map((l)=>l.mfe).sort((a,b)=>a-b);
  const fin=sel.map((l)=>l.final).sort((a,b)=>a-b);
  console.log(`\n【${label}】${sel.length} 条腿（收益均按 ${LEV} 倍保证金计）`);
  console.log(`  期间最高浮盈 MFE   中位 ${pct(q(mfe,0.5))}   P75 ${pct(q(mfe,0.75))}   P90 ${pct(q(mfe,0.90))}   P95 ${pct(q(mfe,0.95))}   P99 ${pct(q(mfe,0.99))}   最大 ${pct(q(mfe,0.999))}`);
  console.log(`  最终平仓收益        中位 ${pct(q(fin,0.5))}   P75 ${pct(q(fin,0.75))}   P90 ${pct(q(fin,0.90))}   P95 ${pct(q(fin,0.95))}   P99 ${pct(q(fin,0.99))}`);
  const gaveBack=sel.filter((l)=>l.mfe>0).map((l)=>l.mfe-Math.max(0,l.final));
  console.log(`  冲高后回吐（MFE − 最终，仅算曾浮盈的腿）中位 ${pct(q(gaveBack.sort((a,b)=>a-b),0.5))}   均值 ${pct(gaveBack.reduce((a,b)=>a+b,0)/gaveBack.length)}`);
  console.log(`  曾经浮盈超过：`);
  for(const th of [0.2,0.5,0.8,1.0,1.5,2.0]){
    const n=sel.filter((l)=>l.mfe>=th).length;
    const kept=sel.filter((l)=>l.mfe>=th);
    const held=kept.filter((l)=>l.final>=th).length;
    console.log(`    ${(100*th).toFixed(0).padStart(4)}%（价格 ${(100*th/LEV).toFixed(0)}%）  ${String(n).padStart(4)} 条 ${(100*n/sel.length).toFixed(2).padStart(6)}%   其中撑到平仓仍在此位之上 ${held} 条（${n?(100*held/n).toFixed(0):"—"}%）`);
  }
}
console.log(`${VENUE_ONLY?"只算 Variational":"全部币安合约"} · UTC 16:00 入场持 ${HOLD} 小时 · ${LEV} 倍`);
report("做多涨幅榜",legs.filter((l)=>l.side>0));
report("做空跌幅榜",legs.filter((l)=>l.side<0));
process.exit(0);
