/**
 * Buy the gainers list at 22:00 UTC, sell at 10:00 UTC.
 *
 * Ranking reads the 21:00 close, so the bar the order fills on is never part of
 * the decision. Entry and exit both take the OPEN of their hour: an order given
 * at 22:00 fills at 22:00, not at what the hour turned out to close at.
 *
 * The same window is run against controls — other hold periods, other ranking
 * lookbacks, and the short side — because "buy recent winners for 12 hours" is
 * short-horizon momentum, and short-horizon momentum measured over three years
 * of daily data was significantly NEGATIVE. If this window earns anything, the
 * controls are what say whether it is the window or the direction doing it.
 */
import { readFileSync } from "node:fs";
const DIR="/private/tmp/claude-501/-Users-hux-Desktop-huxtrade/499bb97e-f722-4740-975b-f921f3a83a72/scratchpad";
type H=[number,number,number];        // openTime, open, close
type D=[number,number,number,number,number,number];
const hourly=JSON.parse(readFileSync(`${DIR}/hourly1h.json`,"utf8")) as Record<string,H[]>;
const daily=JSON.parse(readFileSync(`${DIR}/histohlc.json`,"utf8")) as Record<string,D[]>;
const symbols=Object.keys(hourly);
const HOUR=3_600_000,DAY=86_400_000,FEE=0.0005,LEG=120,LIQUID=200;
const hIdx=new Map<string,Map<number,H>>();
for(const s of symbols)hIdx.set(s,new Map(hourly[s]!.map((r)=>[Math.floor(r[0]/HOUR)*HOUR,r])));
const dIdx=new Map<string,Map<number,D>>();
for(const s of symbols)if(daily[s])dIdx.set(s,new Map(daily[s]!.map((r)=>[Math.floor(r[0]/DAY)*DAY,r])));
const H_=(s:string,t:number)=>hIdx.get(s)?.get(Math.floor(t/HOUR)*HOUR)??null;
const D_=(s:string,t:number)=>dIdx.get(s)?.get(Math.floor(t/DAY)*DAY)??null;

const hours=[...new Set(symbols.flatMap((s)=>hourly[s]!.map((r)=>Math.floor(r[0]/HOUR)*HOUR)))].sort((a,b)=>a-b);
const START=hours[0]!+31*DAY,END=hours.at(-1)!;

/** 30-day average dollar volume from the days strictly before the decision. */
function liquid(t:number){
  const pool:Array<{s:string;vol:number}>=[];
  for(const s of symbols){
    let vol=0,k=0;
    for(let d=1;d<=30;d+=1){const r=D_(s,t-d*DAY);if(r){vol+=r[5];k+=1;}}
    if(k>=25)pool.push({s,vol:vol/k});
  }
  return new Set(pool.sort((a,b)=>b.vol-a.vol).slice(0,LIQUID).map((x)=>x.s));
}

function legsOf(buyHour:number,sellHour:number){
  const out:Array<[number,number]>=[];
  for(let day=Math.ceil(START/DAY)*DAY;day<END-2*DAY;day+=DAY){
    const decide=day+buyHour*HOUR,exitAt=decide+((sellHour-buyHour+24)%24||24)*HOUR;
    if(exitAt>END)break;
    const pool=liquid(decide),ranked:Array<{s:string;ret:number}>=[];
    for(const s of pool){const now=H_(s,decide-HOUR),past=H_(s,decide-HOUR-24*HOUR);
      if(now&&past&&past[2]>0)ranked.push({s,ret:(now[2]-past[2])/past[2]});}
    if(ranked.length<10)continue;
    ranked.sort((a,b)=>b.ret-a.ret);
    let pnl=0,filled=0;
    for(const {s} of ranked.slice(0,5)){const i=H_(s,decide),o=H_(s,exitAt);
      if(i&&o&&i[1]>0){pnl+=LEG*((o[1]-i[1])/i[1]-2*FEE);filled+=1;}}
    if(filled)out.push([decide,pnl]);
  }
  return out;
}
function run(buyHour:number,sellHour:number,lookHours:number,n:number,side:1|-1,half?:0|1){
  const legs:Array<[number,number]>=[];
  for(let day=Math.ceil(START/DAY)*DAY;day<END-2*DAY;day+=DAY){
    const decide=day+buyHour*HOUR;
    const exitAt=decide+((sellHour-buyHour+24)%24||24)*HOUR;
    if(exitAt>END)break;
    const pool=liquid(decide);
    const ranked:Array<{s:string;ret:number}>=[];
    for(const s of pool){
      // The last CLOSED hour before the order, and the same hour a lookback ago.
      const now=H_(s,decide-HOUR),past=H_(s,decide-HOUR-lookHours*HOUR);
      if(!now||!past||!(past[2]>0))continue;
      ranked.push({s,ret:(now[2]-past[2])/past[2]});
    }
    if(ranked.length<2*n)continue;
    ranked.sort((a,b)=>b.ret-a.ret);
    let pnl=0,filled=0;
    for(const {s} of ranked.slice(0,n)){
      const inBar=H_(s,decide),outBar=H_(s,exitAt);
      if(!inBar||!outBar||!(inBar[1]>0))continue;
      pnl+=LEG*(side*(outBar[1]-inBar[1])/inBar[1]-2*FEE);filled+=1;
    }
    if(filled)legs.push([decide,pnl]);
  }
  // Split the sample in two and judge each half on its own. After forty
  // configurations on one year of data, agreement between halves is the only
  // thing separating a pattern from the best of forty coin flips.
  const cut=legs.length?legs[0]![0]+(legs.at(-1)![0]-legs[0]![0])/2:0;
  const use=half===undefined?legs:legs.filter(([t])=>half===0?t<cut:t>=cut);
  legs.length=0;legs.push(...use);
  if(legs.length<30)return null;
  const v=legs.map((x)=>x[1]),sum=v.reduce((a,b)=>a+b,0),mean=sum/v.length;
  const sd=Math.sqrt(v.reduce((a,b)=>a+(b-mean)**2,0)/(v.length-1));
  let e=0,peak=0,dd=0;for(const p of v){e+=p;peak=Math.max(peak,e);dd=Math.min(dd,e-peak);}
  const capital=LEG*n,years=(legs.at(-1)![0]-legs[0]![0])/(365*DAY);
  return {days:v.length,sum,annual:100*(sum/capital)/years,t:mean/(sd/Math.sqrt(v.length)),
    sharpe:(mean/sd)*Math.sqrt(365),win:100*v.filter((x)=>x>0).length/v.length,dd,capital,years};
}
const w=(s:string,n:number)=>s+" ".repeat(Math.max(0,n-[...s].reduce((a,ch)=>a+(ch.charCodeAt(0)>127?2:1),0)));
const line=(label:string,r:ReturnType<typeof run>)=>console.log(
  r?`${w(label,30)}${String(r.days).padStart(6)}${r.sum.toFixed(0).padStart(9)}${(r.annual.toFixed(0)+"%").padStart(9)}${r.sharpe.toFixed(2).padStart(8)}${r.dd.toFixed(0).padStart(9)}${(r.win.toFixed(0)+"%").padStart(7)}${r.t.toFixed(2).padStart(7)}`
   :`${w(label,30)}  样本不足`);

const utc=(cn:number)=>(cn+16)%24;          // UTC+8 clock -> UTC clock
if(process.env.EQUITY){
  const START=600;
  console.log(`起始 ${START} USDC，每腿 ${LEG} × 5 腿，不复投（UTC+8）\n`);
  console.log(`${w("配置",26)}${"最终余额".padStart(10)}${"最低余额".padStart(10)}${"最大回撤".padStart(10)}${"爆仓".padStart(8)}${"90天中位".padStart(10)}${"90天最差".padStart(10)}`);
  for(const [label,entry,exit] of [["18:00 → 次日 04:00",18,4],["18:00 → 次日 05:00",18,5],["18:00 → 次日 06:00",18,6],["18:00 → 次日 07:00",18,7],["18:00 → 次日 08:00",18,8]] as const){
    const r=run(utc(entry),utc(exit),24,5,1)!;
    void r;
    const daily=legsOf(utc(entry),utc(exit));
    let eq=START,low=START,peak=START,dd=0,bust=false;
    for(const [,pnl] of daily){eq+=pnl;peak=Math.max(peak,eq);low=Math.min(low,eq);dd=Math.min(dd,(eq-peak)/peak);if(eq<=0)bust=true;}
    const win=90,out:number[]=[];
    for(let i=0;i+win<daily.length;i+=1)out.push(daily.slice(i,i+win).reduce((a,b)=>a+b[1],0));
    out.sort((a,b)=>a-b);
    console.log(`${w(label,26)}${eq.toFixed(0).padStart(10)}${low.toFixed(0).padStart(10)}${(100*dd).toFixed(0).padStart(9)}%${(bust?"是":"否").padStart(7)}${out[Math.floor(out.length/2)]!.toFixed(0).padStart(10)}${out[0]!.toFixed(0).padStart(10)}`);
  }
  process.exit(0);
}
if(process.env.SPLIT){
  console.log("同一策略，把一年劈成前后两半，各自独立评价（UTC+8）\n");
  console.log(`${w("配置",34)}${"半段".padStart(6)}${"天数".padStart(6)}${"总盈亏".padStart(9)}${"年化".padStart(9)}${"夏普".padStart(8)}${"t".padStart(7)}`);
  for(const [label,entry,exit] of [["18:00 → 次日 06:00（你的）",18,6],["18:00 → 次日 07:00（最好）",18,7],["22:00 → 次日 08:00（网格最强）",22,8],["06:00 → 次日 18:00（对照·亏损段）",6,18]] as const){
    for(const half of [0,1] as const){
      const r=run(utc(entry),utc(exit),24,5,1,half);
      console.log(r?`${w(label,34)}${(half?"后半":"前半").padStart(5)}${String(r.days).padStart(6)}${r.sum.toFixed(0).padStart(9)}${(r.annual.toFixed(0)+"%").padStart(9)}${r.sharpe.toFixed(2).padStart(8)}${r.t.toFixed(2).padStart(7)}`:`${w(label,34)} 样本不足`);
    }
  }
  process.exit(0);
}
if(process.env.CN){
  const ENTRY=18;
  console.log(`时区 UTC+8。入场 ${ENTRY}:00（= UTC ${utc(ENTRY)}:00），按 24h 涨幅前 5，每腿 ${LEG} USDC\n`);
  console.log(`${w("卖出时点",30)}${"总盈亏".padStart(9)}${"年化".padStart(9)}${"夏普".padStart(8)}${"回撤".padStart(9)}${"胜率".padStart(7)}${"t".padStart(7)}`);
  for(const cn of [2,3,4,5,6,7,8,9,10]){
    const hold=((utc(cn)-utc(ENTRY)+24)%24)||24;
    line(`次日 ${String(cn).padStart(2,"0")}:00 (UTC ${String(utc(cn)).padStart(2,"0")}:00, 持 ${hold}h)`,run(utc(ENTRY),utc(cn),24,5,1));
  }
  // A single winning cell in a grid this size is what chance looks like. The
  // question is whether its neighbours agree.
  console.log(`\n入场 × 卖出（UTC+8），格内为年化%，均买 24h 涨幅前 5`);
  const exits=[2,4,6,8,10];
  console.log(`${w("入场",8)}${exits.map((c)=>`次日${String(c).padStart(2,"0")}:00`.padStart(13)).join("")}`);
  for(const entry of [14,16,18,20,22]){
    const cells=exits.map((c)=>{const r=run(utc(entry),utc(c),24,5,1);return (r?`${r.annual.toFixed(0)}%`:"-").padStart(13);});
    console.log(`${w(String(entry).padStart(2,"0")+":00",8)}${cells.join("")}`);
  }
  process.exit(0);
}
const base=run(22,10,24,5,1)!;
console.log(`${symbols.length} 个永续 / ${base.years.toFixed(1)} 年 / 每腿 ${LEG} USDC × 5 = ${LEG*5} / 单边 ${FEE*10000}bp\n`);
console.log(`${w("",30)}${"天数".padStart(6)}${"总盈亏".padStart(9)}${"年化".padStart(9)}${"夏普".padStart(8)}${"回撤".padStart(9)}${"胜率".padStart(7)}${"t".padStart(7)}`);
console.log("【你的策略】");
line("22:00 买 → 次日 10:00 卖",base);
console.log("\n【做空同一份名单】");
line("22:00 空 → 次日 10:00 平",run(22,10,24,5,-1));
console.log("\n【换持有时段，同样买 24h 涨幅前 5】");
for(const [b,s] of [[22,22],[10,22],[0,12],[12,0],[22,4],[4,10]] as const)
  line(`${String(b).padStart(2,"0")}:00 → ${String(s).padStart(2,"0")}:00`,run(b,s,24,5,1));
console.log("\n【换排行榜口径，仍 22:00 → 10:00】");
for(const look of [6,12,24,48,72])line(`按 ${look}h 涨幅排名`,run(22,10,look,5,1));
console.log("\n【换篮子大小，仍 22:00 → 10:00 按 24h 涨幅】");
for(const n of [3,5,10,20])line(`前 ${n} 名`,run(22,10,24,n,1));
process.exit(0);
