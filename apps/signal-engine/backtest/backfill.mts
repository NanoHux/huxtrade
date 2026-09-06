/**
 * Backfilling the basket versus honouring the board.
 *
 * A: filter to what Variational can open, THEN take five a side — the current
 *    code. Always five legs each way, but the fifth may be the board's tenth.
 * B: take the board's five a side, THEN drop what cannot be opened — closer to
 *    "the top five" as written, at the cost of an unstable leg count and, on
 *    bad days, only one side.
 *
 * Both size the same way — the deployed balance split equally across whatever
 * filled — so leg count changes diversification, never exposure. The question
 * is whether reaching down the board for a fifth name dilutes the signal more
 * than the extra name diversifies it.
 */
import { readFileSync } from "node:fs";
const DIR="/private/tmp/claude-501/-Users-hux-Desktop-huxtrade/499bb97e-f722-4740-975b-f921f3a83a72/scratchpad";
type B=[number,number,number,number,number];type D=[number,number,number,number,number,number];
const daily=JSON.parse(readFileSync(`${DIR}/histohlc.json`,"utf8")) as Record<string,D[]>;
const listed=new Set(JSON.parse(readFileSync(`${DIR}/vari_assets.json`,"utf8")) as string[]);
const bars=new Map<string,Map<number,B>>();
for(const line of readFileSync(`${DIR}/h1ohlc.ndjson`,"utf8").split("\n")){
  if(!line)continue;
  const [sym,rows]=JSON.parse(line) as [string,B[]];
  bars.set(sym,new Map(rows.map((r)=>[r[0],r])));
}
const symbols=[...bars.keys()];
const tradable=(s:string)=>listed.has(s.replace("USDT",""));
const HOUR=3_600_000,DAY=86_400_000,LIQUID=200,N=5,LEV=2,DEPLOY=0.95,FEE=0.0005,ENTRY=16,HOLD=8;
const dI=new Map(symbols.filter((s)=>daily[s]).map((s)=>[s,new Map(daily[s]!.map((r)=>[Math.floor(r[0]/DAY)*DAY,r]))]));
const B_=(s:string,t:number)=>bars.get(s)?.get(Math.floor(t/HOUR)*HOUR)??null;
const D_=(s:string,t:number)=>dI.get(s)?.get(Math.floor(t/DAY)*DAY)??null;
const stamps=[...new Set(symbols.flatMap((s)=>[...bars.get(s)!.keys()]))].sort((a,b)=>a-b);
const FIRST=stamps[0]!+31*DAY,LAST=stamps.at(-1)!;

function run(mode:"A"|"B"){
  const rets:number[]=[];let legTotal=0,days=0,oneSided=0,emptyDays=0;
  const ranks:number[]=[];
  for(let d=Math.ceil(FIRST/DAY)*DAY;d<LAST-2*DAY;d+=DAY){
    const t=d+ENTRY*HOUR,exit=t+HOLD*HOUR;
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
    let longs:string[],shorts:string[];
    if(mode==="A"){
      const ok=ranked.filter((x)=>tradable(x.s));
      longs=ok.slice(0,N).map((x)=>x.s);
      const taken=new Set(longs);
      shorts=[...ok].reverse().filter((x)=>!taken.has(x.s)).slice(0,N).map((x)=>x.s);
      // Where the chosen names sat on the untradable-inclusive board.
      for(const s of longs)ranks.push(ranked.findIndex((x)=>x.s===s)+1);
    }else{
      longs=ranked.slice(0,N).filter((x)=>tradable(x.s)).map((x)=>x.s);
      const taken=new Set(longs);
      shorts=ranked.slice(-N).filter((x)=>tradable(x.s)&&!taken.has(x.s)).map((x)=>x.s);
      for(const s of longs)ranks.push(ranked.findIndex((x)=>x.s===s)+1);
    }
    if(!longs.length&&!shorts.length){emptyDays+=1;continue;}
    if(!longs.length||!shorts.length)oneSided+=1;
    const legs:number[]=[];
    for(const [sym,side] of [...longs.map((s)=>[s,1] as const),...shorts.map((s)=>[s,-1] as const)]){
      const open=B_(sym,t),close=B_(sym,exit);
      if(!open||!close||!(open[1]>0))continue;
      legs.push((side*(close[1]-open[1])/open[1]-2*FEE)*LEV);
    }
    if(!legs.length)continue;
    legTotal+=legs.length;days+=1;
    rets.push(DEPLOY*legs.reduce((a,b)=>a+b,0)/legs.length);
  }
  const m=rets.reduce((a,b)=>a+b,0)/rets.length;
  const sd=Math.sqrt(rets.reduce((a,b)=>a+(b-m)**2,0)/(rets.length-1));
  let eq=500,peak=500,dd=0;
  for(const r of rets){eq*=1+r;peak=Math.max(peak,eq);dd=Math.min(dd,(eq-peak)/peak);}
  const half=Math.floor(rets.length/2);
  const grow=(v:number[])=>v.reduce((a,b)=>a*(1+b),1);
  return {days,legs:legTotal/days,mean:m,t:m/(sd/Math.sqrt(rets.length)),end:eq,dd,oneSided,emptyDays,
    avgRank:ranks.reduce((a,b)=>a+b,0)/ranks.length,
    h1:grow(rets.slice(0,half)),h2:grow(rets.slice(half))};
}
const w=(s:string,n:number)=>s+" ".repeat(Math.max(0,n-[...s].reduce((a,c)=>a+(c.charCodeAt(0)>127?2:1),0)));
console.log(`多空组合 · ${LEV} 倍 · 部署 ${100*DEPLOY}% · UTC ${ENTRY}:00 入场持 ${HOLD}h · 两种选币方式\n`);
console.log(`${w("方式",26)}${"天数".padStart(6)}${"日均腿数".padStart(10)}${"多头平均名次".padStart(13)}${"单边天数".padStart(10)}${"日均".padStart(9)}${"t".padStart(7)}${"期末".padStart(8)}${"回撤".padStart(8)}${"上半年".padStart(8)}${"下半年".padStart(8)}`);
for(const [label,mode] of [["A 先筛后取（现在的）","A"],["B 先取后筛（你描述的）","B"]] as const){
  const r=run(mode);
  console.log(`${w(label,26)}${String(r.days).padStart(6)}${r.legs.toFixed(1).padStart(10)}${r.avgRank.toFixed(1).padStart(13)}${String(r.oneSided).padStart(10)}${(100*r.mean).toFixed(3).padStart(8)}%${r.t.toFixed(2).padStart(7)}${r.end.toFixed(0).padStart(8)}${(100*r.dd).toFixed(0).padStart(7)}%${((r.h1-1)*100).toFixed(0).padStart(7)}%${((r.h2-1)*100).toFixed(0).padStart(7)}%`);
}
process.exit(0);
