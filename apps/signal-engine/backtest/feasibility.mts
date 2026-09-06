/**
 * The strategy at 600 USDC, on the venue we can actually reach.
 *
 * An annualised figure is the wrong number to plan around at this size: it is
 * an average over 3.1 years, and the account has to survive the individual
 * quarters that average is made of. What follows is the distribution of those
 * quarters, the worst equity path, how often the 200% target actually fires,
 * and how many of the picks are even listed where we trade.
 */
import { readFileSync } from "node:fs";
const DIR="/private/tmp/claude-501/-Users-hux-Desktop-huxtrade/499bb97e-f722-4740-975b-f921f3a83a72/scratchpad";
type Row=[number,number,number,number,number,number];
const uni=JSON.parse(readFileSync(`${DIR}/histohlc.json`,"utf8")) as Record<string,Row[]>;
const tradable=new Set(readFileSync(`${DIR}/tradable.txt`,"utf8").trim().split(","));
// RESTRICT=1 runs the same rules over only what Variational lists. Those 46
// were picked in August 2026, so a three-year run over them carries the same
// hindsight bias that invalidated the earlier momentum result — it answers
// "is there enough dispersion in 46 names", not "what would this have earned".
const symbols=process.env.RESTRICT?Object.keys(uni).filter((s)=>tradable.has(s)):Object.keys(uni);
const DAY=86_400_000,LIQUID=process.env.RESTRICT?999:200,LOOK=60,N=5,PER_LEG=120,START_EQUITY=600,TP=2.0;
const index=new Map<string,Map<number,Row>>();
for(const s of symbols)index.set(s,new Map(uni[s]!.map((r)=>[Math.floor(r[0]/DAY)*DAY,r])));
const at=(s:string,t:number)=>index.get(s)!.get(Math.floor(t/DAY)*DAY)??null;
const bars=[...new Set(symbols.flatMap((s)=>uni[s]!.map((r)=>Math.floor(r[0]/DAY)*DAY)))].sort((a,b)=>a-b);

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
  if(pool.length<(process.env.RESTRICT?20:50))continue;
  pool.sort((a,b)=>b.vol-a.vol);
  baskets.push([t,pool.slice(0,LIQUID).sort((a,b)=>b.ret-a.ret).slice(0,N).map((x)=>x.s)]);
}

function simulate(fee:number,target:number|null){
  type Held={entry:number;last:number};
  let held=new Map<string,Held>();
  const blocked=new Map<string,number>();
  const daily:Array<[number,number]>=[];
  let tpHits=0,entries=0;
  for(let i=0;i<baskets.length;i+=1){
    const [t,want]=baskets[i]!;
    let pnl=0;const next=new Map<string,Held>();
    for(const [s,h] of held){
      const bar=at(s,t);if(!bar)continue;
      const tgt=target?h.entry*(1+target):null;
      if(tgt!==null&&bar[2]>=tgt){pnl+=PER_LEG*(tgt-h.last)/h.last-PER_LEG*fee;blocked.set(s,i);tpHits+=1;continue;}
      pnl+=PER_LEG*(bar[4]-h.last)/h.last;
      if(!want.includes(s)){pnl-=PER_LEG*fee;continue;}
      next.set(s,{entry:h.entry,last:bar[4]});
    }
    for(const s of want){
      if(next.has(s))continue;
      if(blocked.has(s)){
        if(!baskets.slice(blocked.get(s)!,i).some(([,b])=>!b.includes(s)))continue;
        blocked.delete(s);
      }
      const bar=at(s,t);if(!bar)continue;
      next.set(s,{entry:bar[4],last:bar[4]});pnl-=PER_LEG*fee;entries+=1;
    }
    held=next;daily.push([t,pnl]);
  }
  return {daily,tpHits,entries};
}

const {daily,tpHits,entries}=simulate(0.0005,TP);
const years=(daily.at(-1)![0]-daily[0]![0])/(365*DAY);

// Equity path from the real starting balance, no compounding: the plan is a
// fixed 120 per leg, so the account either survives the drawdown or it cannot
// fund five legs any more.
let eq=START_EQUITY,peak=START_EQUITY,worstEq=START_EQUITY,worstDd=0,worstAt=0;
for(const [t,pnl] of daily){
  eq+=pnl;peak=Math.max(peak,eq);
  if(eq<worstEq)worstEq=eq;
  if((eq-peak)/peak<worstDd){worstDd=(eq-peak)/peak;worstAt=t;}
}
console.log(`每腿 ${PER_LEG} USDC × ${N} 腿 = ${PER_LEG*N} USDC，起始余额 ${START_EQUITY}，止盈 ${TP*100}%，${years.toFixed(1)} 年\n`);
console.log("整段表现（不复投，每腿固定 120）");
console.log(`  最终余额 ${eq.toFixed(0)} USDC   总盈亏 ${(eq-START_EQUITY).toFixed(0)}`);
console.log(`  最低余额 ${worstEq.toFixed(0)} USDC   最大回撤 ${(100*worstDd).toFixed(0)}%（发生在 ${new Date(worstAt).toISOString().slice(0,10)}）`);
console.log(`  开仓次数 ${entries}（平均每 ${(daily.length/entries).toFixed(1)} 天一次），止盈触发 ${tpHits} 次\n`);

// The average is not the experience. These are the quarters it is made of.
const win=90,outcomes:number[]=[];
for(let i=0;i+win<daily.length;i+=1)outcomes.push(daily.slice(i,i+win).reduce((a,b)=>a+b[1],0));
outcomes.sort((a,b)=>a-b);
const q=(p:number)=>outcomes[Math.min(outcomes.length-1,Math.floor(p*outcomes.length))]!;
console.log(`任意 90 天的盈亏分布（${outcomes.length} 个重叠窗口，起始 ${START_EQUITY} USDC）`);
console.log(`  最差 ${q(0).toFixed(0)}   P10 ${q(0.10).toFixed(0)}   P25 ${q(0.25).toFixed(0)}   中位 ${q(0.5).toFixed(0)}   P75 ${q(0.75).toFixed(0)}   P90 ${q(0.90).toFixed(0)}   最好 ${q(0.999).toFixed(0)}`);
console.log(`  亏损窗口占比 ${(100*outcomes.filter((x)=>x<0).length/outcomes.length).toFixed(0)}%   亏超过 150 USDC 的占比 ${(100*outcomes.filter((x)=>x<-150).length/outcomes.length).toFixed(0)}%\n`);

console.log("成本敏感性（Variational 是 RFQ，点差就是成本，比 Binance 手续费高）");
for(const fee of [0.0005,0.001,0.0015,0.002,0.003]){
  const r=simulate(fee,TP),sum=r.daily.reduce((a,b)=>a+b[1],0);
  console.log(`  单边 ${(fee*10000).toFixed(0).padStart(2)}bp   总盈亏 ${sum.toFixed(0).padStart(7)}   年化 ${(100*(sum/(PER_LEG*N))/years).toFixed(0).padStart(5)}%`);
}

// The picks have to exist where the orders go.
let need=0,have=0;const missing=new Map<string,number>();
for(const [,want] of baskets.slice(-365))for(const s of want){need+=1;if(tradable.has(s))have+=1;else missing.set(s,(missing.get(s)??0)+1);}
console.log(`\n选出来的币在我们平台上有没有（最近 365 天，共 ${need} 个持仓日）`);
console.log(`  能交易 ${have} (${(100*have/need).toFixed(0)}%)   买不到 ${need-have} (${(100*(need-have)/need).toFixed(0)}%)`);
console.log(`  最常选中但买不到的：${[...missing].sort((a,b)=>b[1]-a[1]).slice(0,8).map(([s,n])=>`${s.replace("USDT","")}(${n}天)`).join("  ")}`);
process.exit(0);
