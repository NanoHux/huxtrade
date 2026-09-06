/**
 * What the gainers list's disasters look like before they happen.
 *
 * Every feature is measured at the moment of entry from data that existed then
 * — trailing volume, trailing range, how long the venue has listed it. A filter
 * built on anything else cannot be applied at 22:00, which is the only time it
 * would matter.
 */
import { readFileSync } from "node:fs";
const DIR="/private/tmp/claude-501/-Users-hux-Desktop-huxtrade/499bb97e-f722-4740-975b-f921f3a83a72/scratchpad";
type H=[number,number,number];type D=[number,number,number,number,number,number];
const hourly=JSON.parse(readFileSync(`${DIR}/hourly1h.json`,"utf8")) as Record<string,H[]>;
const daily=JSON.parse(readFileSync(`${DIR}/histohlc.json`,"utf8")) as Record<string,D[]>;
const symbols=Object.keys(hourly);
const HOUR=3_600_000,DAY=86_400_000,LIQUID=200,N=5,ENTRY=14,EXIT=23;
const hI=new Map(symbols.map((s)=>[s,new Map(hourly[s]!.map((r)=>[Math.floor(r[0]/HOUR)*HOUR,r]))]));
const dI=new Map(symbols.filter((s)=>daily[s]).map((s)=>[s,new Map(daily[s]!.map((r)=>[Math.floor(r[0]/DAY)*DAY,r]))]));
const H_=(s:string,t:number)=>hI.get(s)?.get(Math.floor(t/HOUR)*HOUR)??null;
const D_=(s:string,t:number)=>dI.get(s)?.get(Math.floor(t/DAY)*DAY)??null;
const firstDay=new Map(symbols.filter((s)=>daily[s]).map((s)=>[s,daily[s]![0]![0]]));
const all=[...new Set(symbols.flatMap((s)=>hourly[s]!.map((r)=>Math.floor(r[0]/HOUR)*HOUR)))].sort((a,b)=>a-b);
const FIRST=all[0]!+31*DAY,LAST=all.at(-1)!;

type Row={sym:string;ret:number;change24:number;dollarVol:number;volSurge:number;price:number;ageDays:number;
  change7d:number;fromHigh30:number;range30:number};
const rows:Row[]=[];
for(let d=Math.ceil(FIRST/DAY)*DAY;d<LAST-DAY;d+=DAY){
  const t=d+ENTRY*HOUR,exit=d+EXIT*HOUR;
  if(exit>LAST)break;
  const pool:Array<{s:string;vol:number}>=[];
  for(const s of symbols){let v=0,k=0;for(let i=1;i<=30;i+=1){const r=D_(s,t-i*DAY);if(r){v+=r[5];k+=1;}}if(k>=25)pool.push({s,vol:v/k});}
  const liquid=pool.sort((a,b)=>b.vol-a.vol).slice(0,LIQUID);
  const volAvg=new Map(liquid.map((x)=>[x.s,x.vol]));
  const ranked:Array<{s:string;ret:number}>=[];
  for(const {s} of liquid){const now=H_(s,t-HOUR),past=H_(s,t-HOUR-24*HOUR);
    if(now&&past&&past[2]>0)ranked.push({s,ret:(now[2]-past[2])/past[2]});}
  if(ranked.length<2*N)continue;
  ranked.sort((a,b)=>b.ret-a.ret);
  for(const {s,ret:change24} of ranked.slice(0,N)){
    const inBar=H_(s,t),outBar=H_(s,exit),yesterday=D_(s,t-DAY),weekAgo=H_(s,t-HOUR-7*24*HOUR);
    if(!inBar||!outBar||!(inBar[1]>0)||!yesterday)continue;
    let high=0,low=Infinity;
    for(let i=1;i<=30;i+=1){const r=D_(s,t-i*DAY);if(r){high=Math.max(high,r[2]);low=Math.min(low,r[3]);}}
    if(!(high>0)||!Number.isFinite(low))continue;
    rows.push({sym:s.replace("USDT",""),ret:(outBar[1]-inBar[1])/inBar[1],change24,
      dollarVol:yesterday[5],volSurge:yesterday[5]/(volAvg.get(s)||1),price:inBar[1],
      ageDays:(t-(firstDay.get(s)??t))/DAY,
      change7d:weekAgo&&weekAgo[2]>0?(inBar[1]-weekAgo[2])/weekAgo[2]:0,
      fromHigh30:high>0?(inBar[1]-high)/high:0,range30:low>0?(high-low)/low:0});
  }
}

const pct=(x:number)=>`${(100*x).toFixed(1)}%`;
const sorted=[...rows].map((r)=>r.ret).sort((a,b)=>a-b);
console.log(`一年 / 每天涨幅榜前 ${N} / 共 ${rows.length} 次持仓，UTC 14:00 → 23:00（9 小时）\n`);
console.log("9 小时收益分布");
for(const q of [0,0.01,0.05,0.10,0.25,0.5,0.75,0.90,0.95,0.99,0.999])
  console.log(`  P${(100*q).toFixed(q<0.1||q>0.9?1:0).padStart(5)}  ${pct(sorted[Math.min(sorted.length-1,Math.floor(q*sorted.length))]!).padStart(8)}`);
const disaster=(x:number)=>rows.filter((r)=>r.ret<=x).length;
console.log(`\n  跌超 20%：${disaster(-0.20)} 次（${pct(disaster(-0.20)/rows.length)}）`);
console.log(`  跌超 40%：${disaster(-0.40)} 次（${pct(disaster(-0.40)/rows.length)}）`);
console.log(`  跌超 60%：${disaster(-0.60)} 次（${pct(disaster(-0.60)/rows.length)}）`);

// Each feature split into quintiles: if a characteristic marks the disasters,
// the bottom bucket's crash rate separates from the top's.
const w=(s:string,n:number)=>s+" ".repeat(Math.max(0,n-[...s].reduce((a,c)=>a+(c.charCodeAt(0)>127?2:1),0)));
function bucket(name:string,pick:(r:Row)=>number,fmt:(x:number)=>string){
  const ordered=[...rows].sort((a,b)=>pick(a)-pick(b));
  const size=Math.floor(ordered.length/5);
  console.log(`\n${name}（从小到大分五档）`);
  console.log(`${w("  档位区间",30)}${"次数".padStart(6)}${"平均收益".padStart(10)}${"中位".padStart(9)}${"跌>20%".padStart(9)}${"跌>40%".padStart(9)}`);
  for(let i=0;i<5;i+=1){
    const slice=ordered.slice(i*size,i===4?ordered.length:(i+1)*size);
    if(!slice.length)continue;
    const mean=slice.reduce((a,b)=>a+b.ret,0)/slice.length;
    const med=[...slice].sort((a,b)=>a.ret-b.ret)[Math.floor(slice.length/2)]!.ret;
    const d20=slice.filter((r)=>r.ret<=-0.20).length,d40=slice.filter((r)=>r.ret<=-0.40).length;
    console.log(`${w(`  ${fmt(pick(slice[0]!))} ~ ${fmt(pick(slice.at(-1)!))}`,30)}${String(slice.length).padStart(6)}${pct(mean).padStart(10)}${pct(med).padStart(9)}${(100*d20/slice.length).toFixed(1).padStart(8)}%${(100*d40/slice.length).toFixed(1).padStart(8)}%`);
  }
}
const money=(x:number)=>x>=1e9?`${(x/1e9).toFixed(1)}B`:x>=1e6?`${(x/1e6).toFixed(0)}M`:`${(x/1e3).toFixed(0)}K`;
bucket("24 小时涨幅",(r)=>r.change24,pct);
bucket("前一日成交额（美元）",(r)=>r.dollarVol,money);
bucket("成交额突增倍数（昨日 / 30 日均）",(r)=>r.volSurge,(x)=>`${x.toFixed(1)}x`);
bucket("币价",(r)=>r.price,(x)=>x<0.01?x.toExponential(1):x.toFixed(3));
bucket("上市天数",(r)=>r.ageDays,(x)=>`${x.toFixed(0)}天`);
bucket("7 日涨幅",(r)=>r.change7d,pct);
bucket("距 30 日最高价",(r)=>r.fromHigh30,pct);
bucket("30 日波动区间（高/低-1）",(r)=>r.range30,pct);
process.exit(0);
