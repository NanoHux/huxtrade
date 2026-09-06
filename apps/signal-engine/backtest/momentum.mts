/**
 * Cross-sectional momentum on a universe that could have been known in advance.
 *
 * The 46 tracked assets were all added to the database between 4 and 9 August,
 * for a window that opens on 5 July — TUT and AKE entered on the 8th, after
 * running 1778% and 1293%. Ranking assets by past return inside a list chosen
 * for having gone up is not a backtest of momentum, it is a restatement of how
 * the list was built. Every symbol here was listed on Binance at least 30 days
 * before the window opens, and the liquidity screen is recomputed from trailing
 * volume at each rebalance, so membership never depends on the future.
 */
import { readFileSync } from "node:fs";
const DIR="/private/tmp/claude-501/-Users-hux-Desktop-huxtrade/499bb97e-f722-4740-975b-f921f3a83a72/scratchpad";
type Row=[number,number,number];   // openTime, close, quoteVolume
const uni=JSON.parse(readFileSync(`${DIR}/universe1d.json`,"utf8")) as Record<string,Row[]>;
const symbols=Object.keys(uni);
const DAY=86_400_000,FEE=0.0005,LEG=500,LIQUID=200;
const days=[...new Set(symbols.flatMap((s)=>uni[s]!.map((r)=>r[0])))].sort((a,b)=>a-b);
const WINDOW_START=Date.now()-36*DAY;
const bars=days.filter((d)=>d>=WINDOW_START);
const at=(sym:string,t:number)=>{const r=uni[sym]!;let lo=0,hi=r.length-1,f=-1;
  while(lo<=hi){const m=(lo+hi)>>1;if(r[m]![0]<=t){f=m;lo=m+1;}else hi=m-1;}return f<0?null:r[f]!;};

function run(look:number,n:number,shortLeg:boolean){
  const legs:number[]=[];
  for(let i=0;i+1<bars.length;i+=1){
    const t=bars[i]!,t2=bars[i+1]!;
    // Liquidity screen from the 30 days BEFORE the decision, never after.
    const pool=symbols.map((s)=>{
      const now=at(s,t),past=at(s,t-look*DAY);
      if(!now||!past||!(past[1]>0))return null;
      let vol=0,k=0;for(let d=1;d<=30;d+=1){const r=at(s,t-d*DAY);if(r){vol+=r[2];k+=1;}}
      return k<25?null:{s,ret:(now[1]-past[1])/past[1],vol:vol/k};
    }).filter((x):x is {s:string;ret:number;vol:number}=>x!==null)
      .sort((a,b)=>b.vol-a.vol).slice(0,LIQUID)
      .sort((a,b)=>b.ret-a.ret);
    if(pool.length<2*n)continue;
    const leg=(sym:string,side:1|-1)=>{const p1=at(sym,t),p2=at(sym,t2);
      return p1&&p2&&p1[1]>0?LEG*(side*(p2[1]-p1[1])/p1[1]-2*FEE):0;};
    let pnl=0;
    for(const {s} of pool.slice(0,n))pnl+=leg(s,1);
    if(shortLeg)for(const {s} of pool.slice(-n))pnl+=leg(s,-1);
    legs.push(pnl);
  }
  if(legs.length<3)return null;
  const sum=legs.reduce((a,b)=>a+b,0),mean=sum/legs.length;
  const sd=Math.sqrt(legs.reduce((a,b)=>a+(b-mean)**2,0)/(legs.length-1));
  let e=0,peak=0,dd=0;for(const p of legs){e+=p;peak=Math.max(peak,e);dd=Math.min(dd,e-peak);}
  const capital=LEG*n*(shortLeg?2:1);
  return {sum,ret:100*sum/capital,t:mean/(sd/Math.sqrt(legs.length)),win:100*legs.filter((x)=>x>0).length/legs.length,dd,periods:legs.length};
}

console.log(`${symbols.length} 个永续（全部在窗口开始前 >30 天上市），每日按前 30 日成交额取前 ${LIQUID} 只，${bars.length-1} 次调仓，每腿 ${LEG} USDC\n`);
for(const [label,shortLeg] of [["只做多",false],["多空对冲",true]] as const){
  console.log(`【${label}】`);
  console.log(`${"回看".padStart(6)}${[3,5,10,20].map((n)=>`篮子${n}`.padStart(19)).join("")}`);
  for(const look of [1,3,5,7,14,21,30]){
    const cells=[3,5,10,20].map((n)=>{const r=run(look,n,shortLeg);
      return r?`${r.ret.toFixed(0)}% (t=${r.t.toFixed(2)})`.padStart(19):"".padStart(19);});
    console.log(`${(look+"日").padStart(6)}${cells.join("")}`);
  }
  console.log("");
}
const best=run(7,10,false)!;
console.log(`参考｜7 日回看、只做多前 10、每日调仓：总盈亏 ${best.sum.toFixed(0)} USDC，本金 ${LEG*10}，回报 ${best.ret.toFixed(1)}%，t=${best.t.toFixed(2)}，胜率 ${best.win.toFixed(0)}%，最大回撤 ${best.dd.toFixed(0)}`);
process.exit(0);
