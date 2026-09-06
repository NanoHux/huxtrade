/**
 * Cross-sectional momentum with enough rebalances to actually decide.
 *
 * 36 days gave 35 rebalances and every parameter cell came back insignificant;
 * three years gives ~1100. Membership is decided from trailing data only: a
 * symbol must already have the lookback plus 30 days of history at the decision
 * date, and the liquidity screen reads the 30 days before it.
 *
 * One bias survives and cannot be removed from this source: the symbol list is
 * what Binance lists TODAY, so perps that were delisted are missing and the
 * results are optimistic by whatever those would have cost.
 */
import { readFileSync } from "node:fs";
const DIR="/private/tmp/claude-501/-Users-hux-Desktop-huxtrade/499bb97e-f722-4740-975b-f921f3a83a72/scratchpad";
type Row=[number,number,number];
const uni=JSON.parse(readFileSync(`${DIR}/hist1d.json`,"utf8")) as Record<string,Row[]>;
const symbols=Object.keys(uni);
const DAY=86_400_000,FEE=0.0005,LEG=500,LIQUID=200;
const index=new Map<string,Map<number,Row>>();
for(const s of symbols)index.set(s,new Map(uni[s]!.map((r)=>[Math.floor(r[0]/DAY)*DAY,r])));
const at=(s:string,t:number)=>index.get(s)!.get(Math.floor(t/DAY)*DAY)??null;
const bars=[...new Set(symbols.flatMap((s)=>uni[s]!.map((r)=>Math.floor(r[0]/DAY)*DAY)))].sort((a,b)=>a-b);

function run(look:number,n:number,shortLeg:boolean,reverse=false,fee=FEE){
  const legs:Array<[number,number]>=[];
  let held=new Map<string,1|-1>();
  for(let i=0;i+1<bars.length;i+=1){
    const t=bars[i]!,t2=bars[i+1]!;
    const pool:Array<{s:string;ret:number;vol:number}>=[];
    for(const s of symbols){
      const now=at(s,t),past=at(s,t-look*DAY);
      if(!now||!past||!(past[1]>0))continue;
      let vol=0,k=0;
      for(let d=1;d<=30;d+=1){const r=at(s,t-d*DAY);if(r){vol+=r[2];k+=1;}}
      if(k<25)continue;
      pool.push({s,ret:(now[1]-past[1])/past[1],vol:vol/k});
    }
    if(pool.length<Math.max(2*n,50))continue;
    pool.sort((a,b)=>b.vol-a.vol);
    const liquid=pool.slice(0,LIQUID).sort((a,b)=>reverse?a.ret-b.ret:b.ret-a.ret);
    const leg=(sym:string,side:1|-1)=>{const p1=at(sym,t),p2=at(sym,t2);
      return p1&&p2&&p1[1]>0?LEG*side*(p2[1]-p1[1])/p1[1]:0;};
    let pnl=0;
    const want=new Map<string,1|-1>();
    for(const {s} of liquid.slice(0,n)){pnl+=leg(s,1);want.set(s,1);}
    if(shortLeg)for(const {s} of liquid.slice(-n)){pnl+=leg(s,-1);want.set(s,-1);}
    // Costs follow turnover, not the calendar. Charging a round trip every day
    // regardless of whether the basket changed taxed a 60-day lookback exactly
    // as hard as a 1-day one, which is what made every slow variant look dead.
    for(const [sym,side] of want)if(held.get(sym)!==side)pnl-=LEG*fee;
    for(const [sym,side] of held)if(want.get(sym)!==side)pnl-=LEG*fee;
    held=want;
    legs.push([t,pnl]);
  }
  if(legs.length<50)return null;
  const v=legs.map((x)=>x[1]),sum=v.reduce((a,b)=>a+b,0),mean=sum/v.length;
  const sd=Math.sqrt(v.reduce((a,b)=>a+(b-mean)**2,0)/(v.length-1));
  let e=0,peak=0,dd=0;for(const p of v){e+=p;peak=Math.max(peak,e);dd=Math.min(dd,e-peak);}
  const capital=LEG*n*(shortLeg?2:1);
  const years=(legs.at(-1)![0]-legs[0]![0])/(365*DAY);
  return {sum,capital,t:mean/(sd/Math.sqrt(v.length)),win:100*v.filter((x)=>x>0).length/v.length,dd,periods:v.length,
    annual:100*(sum/capital)/years,sharpe:(mean/sd)*Math.sqrt(365),legs,years};
}
console.log(`${symbols.length} 个永续，${bars.length} 根日线（约 ${(bars.length/365).toFixed(1)} 年），每日按前 30 日成交额取前 ${LIQUID} 只，每腿 ${LEG} USDC，单边 ${FEE*10000}bp\n`);
if(process.env.DETAIL){
  const r=run(60,5,false)!;
  console.log(`【60 日回看 / 只做多前 5 / 每日重排】本金 ${r.capital} USDC，${r.periods} 次调仓，${r.years.toFixed(1)} 年`);
  console.log(`  总盈亏 ${r.sum.toFixed(0)}  年化 ${r.annual.toFixed(0)}%  t=${r.t.toFixed(2)}  夏普 ${r.sharpe.toFixed(2)}  日胜率 ${r.win.toFixed(0)}%  最大回撤 ${r.dd.toFixed(0)}`);
  const byYear=new Map<number,number[]>();
  for(const [t,pnl] of r.legs){const y=new Date(t).getUTCFullYear();const a=byYear.get(y)??[];a.push(pnl);byYear.set(y,a);}
  console.log("\n  分年度");
  for(const [y,v] of [...byYear].sort((a,b)=>a[0]-b[0])){
    const sum=v.reduce((a,b)=>a+b,0),m=sum/v.length,sd=Math.sqrt(v.reduce((a,b)=>a+(b-m)**2,0)/Math.max(1,v.length-1));
    console.log(`    ${y}  ${String(v.length).padStart(4)} 天  ${sum.toFixed(0).padStart(8)} USDC  年化 ${(100*sum/r.capital/(v.length/365)).toFixed(0).padStart(5)}%  t=${(m/(sd/Math.sqrt(v.length))).toFixed(2).padStart(6)}`);
  }
  console.log("\n  手续费敏感性（每边）");
  for(const fee of [0.0002,0.0005,0.001,0.002]){const x=run(60,5,false,false,fee)!;
    console.log(`    ${(fee*10000).toFixed(0).padStart(2)}bp   年化 ${x.annual.toFixed(0).padStart(5)}%   t=${x.t.toFixed(2).padStart(6)}`);}
  process.exit(0);
}
const REV=process.env.REVERSE==="1";
if(REV){
  console.log("【短期反转 多空对冲】做多跌得最多的，做空涨得最多的。格子内为 年化回报 / t 值");
  console.log(`${"回看".padStart(6)}${[3,5,10,20,30].map((n)=>`篮子${n}`.padStart(19)).join("")}`);
  for(const look of [1,2,3,5,7,14]){
    const cells=[3,5,10,20,30].map((n)=>{const r=run(look,n,true,true);
      return r?`${r.annual.toFixed(0)}% / ${r.t.toFixed(2)}`.padStart(19):"".padStart(19);});
    console.log(`${(look+"日").padStart(6)}${cells.join("")}`);
  }
  const best=run(1,20,true,true)!;
  console.log(`\n【1 日回看 / 多空各 20】本金 ${best.capital} USDC，${best.periods} 次调仓，${best.years.toFixed(1)} 年`);
  console.log(`  总盈亏 ${best.sum.toFixed(0)}  年化 ${best.annual.toFixed(0)}%  t=${best.t.toFixed(2)}  夏普 ${best.sharpe.toFixed(2)}  日胜率 ${best.win.toFixed(0)}%  最大回撤 ${best.dd.toFixed(0)}`);
  const byYear=new Map<number,number[]>();
  for(const [t,pnl] of best.legs){const y=new Date(t).getUTCFullYear();const a=byYear.get(y)??[];a.push(pnl);byYear.set(y,a);}
  console.log("\n  分年度（检验是不是只在某一段行情有效）");
  for(const [y,v] of [...byYear].sort((a,b)=>a[0]-b[0])){
    const sum=v.reduce((a,b)=>a+b,0),m=sum/v.length,sd=Math.sqrt(v.reduce((a,b)=>a+(b-m)**2,0)/Math.max(1,v.length-1));
    console.log(`    ${y}  ${String(v.length).padStart(4)} 天  ${sum.toFixed(0).padStart(8)} USDC  t=${(m/(sd/Math.sqrt(v.length))).toFixed(2).padStart(6)}  日胜率 ${(100*v.filter((x)=>x>0).length/v.length).toFixed(0)}%`);
  }
  console.log("\n  手续费敏感性（每边）");
  for(const fee of [0.0002,0.0005,0.001,0.0015,0.002]){
    const r=run(1,20,true,true,fee)!;
    console.log(`    ${(fee*10000).toFixed(0).padStart(2)}bp   年化 ${r.annual.toFixed(0).padStart(5)}%   t=${r.t.toFixed(2).padStart(6)}   总盈亏 ${r.sum.toFixed(0).padStart(8)}`);
  }
  process.exit(0);
}
for(const [label,shortLeg] of [["多空对冲",true],["只做多",false]] as const){
  console.log(`【${label}】格子内为 年化回报 / t 值`);
  console.log(`${"回看".padStart(6)}${[3,5,10,20].map((n)=>`篮子${n}`.padStart(19)).join("")}`);
  for(const look of [1,3,5,7,14,21,30,60,90]){
    const cells=[3,5,10,20].map((n)=>{const r=run(look,n,shortLeg);
      return r?`${r.annual.toFixed(0)}% / ${r.t.toFixed(2)}`.padStart(19):"".padStart(19);});
    console.log(`${(look+"日").padStart(6)}${cells.join("")}`);
  }
  console.log("");
}
process.exit(0);
