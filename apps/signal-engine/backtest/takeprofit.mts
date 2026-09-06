/**
 * Does a take-profit help the pair, and is +50% in eight hours real?
 *
 * Levels are stated as return on margin, which is what the operator sets, so
 * at 2x a "100%" target is a 50% price move. Triggers are checked against the
 * hourly opens and closes inside the hold — sixteen observations per leg. That
 * cannot see a spike that reverses inside an hour, so every count below is a
 * floor on how often the target was reachable, never an overstatement.
 */
import { readFileSync } from "node:fs";
const DIR="/private/tmp/claude-501/-Users-hux-Desktop-huxtrade/499bb97e-f722-4740-975b-f921f3a83a72/scratchpad";
// Rebuilt on hourly OHLC. The first version of this table read opens and
// closes only, so any target reached and given back inside an hour went
// uncounted — it undercounted the +100% level by 36%.
type H=[number,number,number,number,number];type D=[number,number,number,number,number,number];
const hourly:Record<string,H[]>={};
for(const line of readFileSync(`${DIR}/h1ohlc.ndjson`,"utf8").split("\n")){
  if(!line)continue;
  const [sym,rows]=JSON.parse(line) as [string,H[]];
  hourly[sym]=rows;
}
const daily=JSON.parse(readFileSync(`${DIR}/histohlc.json`,"utf8")) as Record<string,D[]>;
const listed=new Set(JSON.parse(readFileSync(`${DIR}/vari_assets.json`,"utf8")) as string[]);
const VENUE_ONLY=Boolean(process.env.VARI);
const symbols=Object.keys(hourly).filter((s)=>!VENUE_ONLY||listed.has(s.replace("USDT","")));
const HOUR=3_600_000,DAY=86_400_000,LIQUID=200,N=5,FEE=0.0005;
const LEV=2,DEPLOY=0.95,ENTRY_UTC=16,HOLD=8,STOP=0.80;   // stop is on margin too
const hI=new Map(symbols.map((s)=>[s,new Map(hourly[s]!.map((r)=>[Math.floor(r[0]/HOUR)*HOUR,r]))]));
const dI=new Map(symbols.filter((s)=>daily[s]).map((s)=>[s,new Map(daily[s]!.map((r)=>[Math.floor(r[0]/DAY)*DAY,r]))]));
const H_=(s:string,t:number)=>hI.get(s)?.get(Math.floor(t/HOUR)*HOUR)??null;
const D_=(s:string,t:number)=>dI.get(s)?.get(Math.floor(t/DAY)*DAY)??null;
const stamps=[...new Set(symbols.flatMap((s)=>hourly[s]!.map((r)=>Math.floor(r[0]/HOUR)*HOUR)))].sort((a,b)=>a-b);
const FIRST=stamps[0]!+31*DAY,LAST=stamps.at(-1)!;

/** Margin return of one leg, exiting early if the target or stop is reached. */
function legReturn(sym:string,side:1|-1,t:number,exit:number,target:number|null){
  const open=H_(sym,t);if(!open||!(open[1]>0))continue_guard();
  const entry=open![1];
  const hit=(price:number)=>side*(price-entry)/entry*LEV;
  for(let k=0;k<HOLD;k+=1){
    const bar=H_(sym,t+k*HOUR);if(!bar)continue;
    // Favourable extreme is the high for a long and the low for a short; the
    // adverse extreme is the other one. Within an hour the order they occurred
    // in is unknowable, so the stop is checked first — the outcome that hurts.
    const fav=side>0?bar[2]:bar[3],adv=side>0?bar[3]:bar[2];
    if(hit(adv)<=-STOP)return {r:-STOP-2*FEE*LEV,exited:"SL" as const};
    if(target!==null&&hit(fav)>=target)return {r:target-2*FEE*LEV,exited:"TP" as const};
  }
  const close=H_(sym,exit);
  if(!close)return null;
  return {r:hit(close[1])-2*FEE*LEV,exited:"TIME" as const};
}
function continue_guard():never{throw new Error("missing entry bar");}

function run(target:number|null){
  const daily_:number[]=[];let tp=0,sl=0,legs=0;
  for(let d=Math.ceil(FIRST/DAY)*DAY;d<LAST-2*DAY;d+=DAY){
    const t=d+ENTRY_UTC*HOUR,exit=t+HOLD*HOUR;
    if(exit>LAST)break;
    const pool:Array<{s:string;vol:number}>=[];
    for(const s of symbols){let v=0,k=0;for(let i=1;i<=30;i+=1){const r=D_(s,d-i*DAY);if(r){v+=r[5];k+=1;}}if(k>=25)pool.push({s,vol:v/k});}
    if(pool.length<2*N)continue;
    const liquid=pool.sort((a,b)=>b.vol-a.vol).slice(0,LIQUID);
    const ranked:Array<{s:string;c:number}>=[];
    for(const {s} of liquid){const now=H_(s,t-HOUR),past=H_(s,t-HOUR-DAY);
      if(now&&past&&past[4]>0)ranked.push({s,c:(now[4]-past[4])/past[4]});}
    if(ranked.length<2*N)continue;
    ranked.sort((a,b)=>b.c-a.c);
    const chosen=[...ranked.slice(0,N).map((x)=>[x.s,1] as const),...ranked.slice(-N).map((x)=>[x.s,-1] as const)];
    const rs:number[]=[];
    for(const [sym,side] of chosen){
      let out;try{out=legReturn(sym,side as 1|-1,t,exit,target);}catch{continue;}
      if(!out)continue;
      rs.push(out.r);legs+=1;
      if(out.exited==="TP")tp+=1;if(out.exited==="SL")sl+=1;
    }
    if(rs.length)daily_.push(DEPLOY*rs.reduce((a,b)=>a+b,0)/rs.length);
  }
  const m=daily_.reduce((a,b)=>a+b,0)/daily_.length;
  const sd=Math.sqrt(daily_.reduce((a,b)=>a+(b-m)**2,0)/(daily_.length-1));
  let eq=500,peak=500,dd=0;
  for(const r of daily_){eq*=1+r;peak=Math.max(peak,eq);dd=Math.min(dd,(eq-peak)/peak);}
  return {days:daily_.length,legs,tp,sl,mean:m,t:m/(sd/Math.sqrt(daily_.length)),end:eq,dd};
}

const w=(s:string,n:number)=>s+" ".repeat(Math.max(0,n-[...s].reduce((a,c)=>a+(c.charCodeAt(0)>127?2:1),0)));
console.log(`多空组合${VENUE_ONLY?"（只算 Variational）":"（全部币安合约）"} · ${LEV} 倍 · 部署 ${100*DEPLOY}% · UTC 16:00 入场持 ${HOLD}h`);
console.log(`止盈按保证金收益计；${LEV} 倍下「止盈 X%」= 价格动 X/${LEV}%。触发用小时最高/最低价判定\n`);
console.log(`${w("止盈档",14)}${"价格需动".padStart(10)}${"触发腿数".padStart(10)}${"占比".padStart(8)}${"日均".padStart(9)}${"t".padStart(7)}${"期末".padStart(9)}${"回撤".padStart(8)}`);
for(const pct of [null,50,80,100,120,150] as const){
  const target=pct===null?null:pct/100;
  const r=run(target);
  console.log(`${w(pct===null?"不设止盈":`${pct}%`,14)}${(pct===null?"—":`${(pct/LEV).toFixed(0)}%`).padStart(10)}${String(r.tp).padStart(10)}${(pct===null?"—":`${(100*r.tp/r.legs).toFixed(2)}%`).padStart(8)}${(100*r.mean).toFixed(3).padStart(8)}%${r.t.toFixed(2).padStart(7)}${r.end.toFixed(0).padStart(9)}${(100*r.dd).toFixed(0).padStart(7)}%`);
}
process.exit(0);
