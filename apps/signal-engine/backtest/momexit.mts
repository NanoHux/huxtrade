/**
 * What a stop does to the 60-day momentum basket.
 *
 * The strategy as measured has no stop and no target: a position leaves when it
 * leaves the top 5. Adding an exit is not a parameter, it is a different
 * strategy — momentum's return lives in a right tail of a few very large
 * winners, and a stop or a target is a rule that cuts a tail off. Which tail it
 * cuts is measurable, so it is measured here rather than reasoned about.
 *
 * A stopped name does not come back until it drops out of the basket and
 * re-qualifies; otherwise the stop is re-bought the next morning and costs
 * turnover without ever removing risk.
 */
import { readFileSync } from "node:fs";
const DIR="/private/tmp/claude-501/-Users-hux-Desktop-huxtrade/499bb97e-f722-4740-975b-f921f3a83a72/scratchpad";
type Row=[number,number,number,number,number,number];   // t,o,h,l,c,quoteVol
const uni=JSON.parse(readFileSync(`${DIR}/histohlc.json`,"utf8")) as Record<string,Row[]>;
const symbols=Object.keys(uni);
const DAY=86_400_000,FEE=0.0005,LEG=500,LIQUID=200,LOOK=60,N=5;
const index=new Map<string,Map<number,Row>>();
for(const s of symbols)index.set(s,new Map(uni[s]!.map((r)=>[Math.floor(r[0]/DAY)*DAY,r])));
const at=(s:string,t:number)=>index.get(s)!.get(Math.floor(t/DAY)*DAY)??null;
const bars=[...new Set(symbols.flatMap((s)=>uni[s]!.map((r)=>Math.floor(r[0]/DAY)*DAY)))].sort((a,b)=>a-b);
// The basket is the same every run; resolving it once keeps the exit sweep
// comparing exits rather than re-deriving a universe 30 times.
const baskets:Array<[number,string[]]>=[];
for(let i=0;i+1<bars.length;i+=1){
  const t=bars[i]!,pool:Array<{s:string;ret:number;vol:number}>=[];
  for(const s of symbols){
    const now=at(s,t),past=at(s,t-LOOK*DAY);
    if(!now||!past||!(past[4]>0))continue;
    let vol=0,k=0;
    for(let d=1;d<=30;d+=1){const r=at(s,t-d*DAY);if(r){vol+=r[5];k+=1;}}
    if(k<25)continue;
    pool.push({s,ret:(now[4]-past[4])/past[4],vol:vol/k});
  }
  if(pool.length<50)continue;
  pool.sort((a,b)=>b.vol-a.vol);
  baskets.push([t,pool.slice(0,LIQUID).sort((a,b)=>b.ret-a.ret).slice(0,N).map((x)=>x.s)]);
}

type Exit={name:string;stop?:number;trail?:number;target?:number};
function markToMarket(exit:Exit){
  type Held={entry:number;peak:number;last:number};
  let held=new Map<string,Held>();
  const blocked=new Map<string,number>();
  const daily:Array<[number,number]>=[];
  for(let i=0;i<baskets.length;i+=1){
    const [t,want]=baskets[i]!;
    let pnl=0;const next=new Map<string,Held>();
    for(const [s,h] of held){
      const bar=at(s,t);
      if(!bar){continue;}
      const stopPx=exit.stop?h.entry*(1-exit.stop):exit.trail?h.peak*(1-exit.trail):null;
      const tgtPx=exit.target?h.entry*(1+exit.target):null;
      if(stopPx!==null&&bar[3]<=stopPx){pnl+=LEG*(stopPx-h.last)/h.last-LEG*FEE;blocked.set(s,i);continue;}
      if(tgtPx!==null&&bar[2]>=tgtPx){pnl+=LEG*(tgtPx-h.last)/h.last-LEG*FEE;blocked.set(s,i);continue;}
      pnl+=LEG*(bar[4]-h.last)/h.last;
      if(!want.includes(s)){pnl-=LEG*FEE;continue;}
      next.set(s,{entry:h.entry,peak:Math.max(h.peak,bar[2]),last:bar[4]});
    }
    for(const s of want){
      if(next.has(s))continue;
      if(blocked.has(s)){
        const left=baskets.slice(blocked.get(s)!,i).some(([,b])=>!b.includes(s));
        if(!left)continue;
        blocked.delete(s);
      }
      const bar=at(s,t);if(!bar)continue;
      next.set(s,{entry:bar[4],peak:bar[2],last:bar[4]});pnl-=LEG*FEE;
    }
    held=next;daily.push([t,pnl]);
  }
  return daily;
}
function stats(name:string,daily:Array<[number,number]>){
  const v=daily.map((x)=>x[1]),sum=v.reduce((a,b)=>a+b,0),mean=sum/v.length;
  const sd=Math.sqrt(v.reduce((a,b)=>a+(b-mean)**2,0)/(v.length-1));
  let e=0,peak=0,dd=0;for(const p of v){e+=p;peak=Math.max(peak,e);dd=Math.min(dd,e-peak);}
  const capital=LEG*N,years=(daily.at(-1)![0]-daily[0]![0])/(365*DAY);
  return {name,sum,annual:100*(sum/capital)/years,t:mean/(sd/Math.sqrt(v.length)),sharpe:(mean/sd)*Math.sqrt(365),dd,ratio:dd<0?sum/-dd:Infinity};
}
const exits:Exit[]=[
  {name:"无止损（原策略）"},
  {name:"固定止损 10%",stop:0.10},
  {name:"固定止损 15%",stop:0.15},
  {name:"固定止损 20%",stop:0.20},
  {name:"固定止损 30%",stop:0.30},
  {name:"固定止损 50%",stop:0.50},
  {name:"移动止损 15%",trail:0.15},
  {name:"移动止损 25%",trail:0.25},
  {name:"移动止损 35%",trail:0.35},
  {name:"移动止损 50%",trail:0.50},
  {name:"止盈 30%",target:0.30},
  {name:"止盈 50%",target:0.50},
  {name:"止盈 100%",target:1.00},
  {name:"止损20% + 止盈50%",stop:0.20,target:0.50},
  {name:"止损20% + 止盈100%",stop:0.20,target:1.00},
];
const w=(s:string,n:number)=>s+" ".repeat(Math.max(0,n-[...s].reduce((a,ch)=>a+(ch.charCodeAt(0)>127?2:1),0)));
if(process.env.YEAR){
  for(const tp of [0,2]){
    const daily=markToMarket(tp?{name:"",target:tp}:{name:""});
    console.log(`\n【${tp?"止盈 200%":"不设止盈"}】`);
    const byYear=new Map<number,number[]>();
    for(const [t,pnl] of daily){const y=new Date(t).getUTCFullYear();const a=byYear.get(y)??[];a.push(pnl);byYear.set(y,a);}
    for(const [y,v] of [...byYear].sort((a,b)=>a[0]-b[0])){
      const sum=v.reduce((a,b)=>a+b,0),m=sum/v.length,sd=Math.sqrt(v.reduce((a,b)=>a+(b-m)**2,0)/Math.max(1,v.length-1));
      let e=0,pk=0,dd=0;for(const x of v){e+=x;pk=Math.max(pk,e);dd=Math.min(dd,e-pk);}
      console.log(`  ${y}  ${String(v.length).padStart(4)} 天  ${sum.toFixed(0).padStart(7)} USDC  年化 ${(100*sum/2500/(v.length/365)).toFixed(0).padStart(5)}%  夏普 ${((m/sd)*Math.sqrt(365)).toFixed(2).padStart(6)}  回撤 ${dd.toFixed(0).padStart(7)}`);
    }
  }
  process.exit(0);
}
if(process.env.TP){
  // A single winning cell surrounded by worse ones is a coincidence; a plateau
  // is a rule. This is the check that tells them apart.
  console.log(`${w("止盈档位",22)}${"总盈亏".padStart(10)}${"年化".padStart(8)}${"夏普".padStart(8)}${"最大回撤".padStart(11)}${"t".padStart(7)}`);
  for(const tp of [0.3,0.5,0.75,1,1.5,2,3,5]){
    const r=stats(`止盈 ${(tp*100).toFixed(0)}%`,markToMarket({name:"",target:tp}));
    console.log(`${w(r.name,22)}${r.sum.toFixed(0).padStart(10)}${(r.annual.toFixed(0)+"%").padStart(8)}${r.sharpe.toFixed(2).padStart(8)}${r.dd.toFixed(0).padStart(11)}${r.t.toFixed(2).padStart(7)}`);
  }
  const none=stats("不设止盈",markToMarket({name:""}));
  console.log(`${w(none.name,22)}${none.sum.toFixed(0).padStart(10)}${(none.annual.toFixed(0)+"%").padStart(8)}${none.sharpe.toFixed(2).padStart(8)}${none.dd.toFixed(0).padStart(11)}${none.t.toFixed(2).padStart(7)}`);
  process.exit(0);
}
const rows=exits.map((e)=>stats(e.name,markToMarket(e)));
console.log(`60 日动量 / 只做多前 ${N} / 每日重排 / ${baskets.length} 天 / 本金 ${LEG*N} USDC / 单边 ${FEE*10000}bp\n`);
console.log(`${w("出场规则",22)}${"总盈亏".padStart(10)}${"年化".padStart(8)}${"夏普".padStart(8)}${"最大回撤".padStart(11)}${"收益/回撤".padStart(11)}${"t".padStart(7)}`);
for(const r of rows)console.log(`${w(r.name,22)}${r.sum.toFixed(0).padStart(10)}${(r.annual.toFixed(0)+"%").padStart(8)}${r.sharpe.toFixed(2).padStart(8)}${r.dd.toFixed(0).padStart(11)}${r.ratio.toFixed(2).padStart(11)}${r.t.toFixed(2).padStart(7)}`);
process.exit(0);
