/**
 * Every entry hour and hold length, short side, on one screen.
 *
 * Ranked by arithmetic daily mean rather than the compounded balance: with a
 * basket this volatile the compounded number is mostly variance drag, which
 * says more about the leverage of compounding than about whether the window
 * holds an edge. Both are printed — the mean to judge the rule, the balance to
 * judge what it would have done to the account.
 */
import { readFileSync } from "node:fs";
const DIR="/private/tmp/claude-501/-Users-hux-Desktop-huxtrade/499bb97e-f722-4740-975b-f921f3a83a72/scratchpad";
type H=[number,number,number];type D=[number,number,number,number,number,number];
const hourly=JSON.parse(readFileSync(`${DIR}/hourly1h.json`,"utf8")) as Record<string,H[]>;
const daily=JSON.parse(readFileSync(`${DIR}/histohlc.json`,"utf8")) as Record<string,D[]>;
const listed=new Set(JSON.parse(readFileSync(`${DIR}/vari_assets.json`,"utf8")) as string[]);
const VENUE_ONLY=Boolean(process.env.VARI);
const SIDE=Number(process.env.SIDE??-1)<0?-1:1;
// LOSERS ranks by the weakest 24h change instead of the strongest. Shorting
// the decliners is short-side momentum, which is a different claim from
// shorting the gainers, and the two need separating.
const LOSERS=Boolean(process.env.LOSERS);
// PAIR is long the gainers and short the losers at once, half the capital per
// side. Gross exposure equals the account, net is zero — so the pair earns the
// time-of-day effect twice and carries no market direction, which is the whole
// point of testing it against a long-only book that drew down 62%.
const PAIR=Boolean(process.env.PAIR);
const symbols=Object.keys(hourly);
const HOUR=3_600_000,DAY=86_400_000,LIQUID=200,N=5,FEE=0.0005;
const hI=new Map(symbols.map((s)=>[s,new Map(hourly[s]!.map((r)=>[Math.floor(r[0]/HOUR)*HOUR,r]))]));
const dI=new Map(symbols.filter((s)=>daily[s]).map((s)=>[s,new Map(daily[s]!.map((r)=>[Math.floor(r[0]/DAY)*DAY,r]))]));
const H_=(s:string,t:number)=>hI.get(s)?.get(Math.floor(t/HOUR)*HOUR)??null;
const D_=(s:string,t:number)=>dI.get(s)?.get(Math.floor(t/DAY)*DAY)??null;
const all=[...new Set(symbols.flatMap((s)=>hourly[s]!.map((r)=>Math.floor(r[0]/HOUR)*HOUR)))].sort((a,b)=>a-b);
const FIRST=all[0]!+31*DAY,LAST=all.at(-1)!;

// The liquidity screen only moves once a day, so it is computed once per day
// and reused for every entry hour tested against it.
const dayList:number[]=[];
const liquidByDay=new Map<number,string[]>();
// SINCE limits the sample so this harness can be compared against the 15m one
// on identical days; two harnesses that disagree on the same period mean one
// of them is wrong, which matters more than either number.
const SINCE=process.env.SINCE?Number(process.env.SINCE):0;
for(let d=Math.ceil(FIRST/DAY)*DAY;d<LAST-2*DAY;d+=DAY){
  if(SINCE&&d<Date.now()-SINCE*DAY)continue;
  const pool:Array<{s:string;vol:number}>=[];
  for(const s of symbols){
    if(VENUE_ONLY&&!listed.has(s.replace("USDT","")))continue;
    let v=0,k=0;for(let i=1;i<=30;i+=1){const r=D_(s,d-i*DAY);if(r){v+=r[5];k+=1;}}
    if(k>=25)pool.push({s,vol:v/k});
  }
  if(pool.length<2*N)continue;
  dayList.push(d);
  liquidByDay.set(d,pool.sort((a,b)=>b.vol-a.vol).slice(0,LIQUID).map((x)=>x.s));
}

function window(entryUtc:number,hold:number){
  const rets:number[]=[];
  for(const d of dayList){
    const t=d+entryUtc*HOUR,exit=t+hold*HOUR;
    if(exit>LAST)continue;
    const ranked:Array<{s:string;c:number}>=[];
    for(const s of liquidByDay.get(d)!){
      const now=H_(s,t-HOUR),past=H_(s,t-HOUR-24*HOUR);
      if(now&&past&&past[2]>0)ranked.push({s,c:(now[2]-past[2])/past[2]});
    }
    if(ranked.length<2*N)continue;
    ranked.sort((a,b)=>LOSERS?a.c-b.c:b.c-a.c);
    const leg=(sym:string,side:1|-1)=>{
      const i=H_(sym,t),o=H_(sym,exit);
      return i&&o&&i[1]>0?side*(o[1]-i[1])/i[1]-2*FEE:null;
    };
    if(PAIR){
      const up=ranked.slice(0,N).map((x)=>leg(x.s,1)).filter((x):x is number=>x!==null);
      const down=ranked.slice(-N).map((x)=>leg(x.s,-1)).filter((x):x is number=>x!==null);
      if(!up.length||!down.length)continue;
      // Half the capital each side, so the number reported is a return on the
      // whole account rather than on one leg of it.
      rets.push(0.5*(up.reduce((a,b)=>a+b,0)/up.length)+0.5*(down.reduce((a,b)=>a+b,0)/down.length));
      continue;
    }
    const legs=ranked.slice(0,N).map((x)=>leg(x.s,SIDE as 1|-1)).filter((x):x is number=>x!==null);
    if(legs.length)rets.push(legs.reduce((a,b)=>a+b,0)/legs.length);
  }
  if(rets.length<200)return null;
  const mean=rets.reduce((a,b)=>a+b,0)/rets.length;
  const sd=Math.sqrt(rets.reduce((a,b)=>a+(b-mean)**2,0)/(rets.length-1));
  let eq=1;for(const r of rets)eq*=1+r;
  return {n:rets.length,mean,t:mean/(sd/Math.sqrt(rets.length)),end:eq,win:100*rets.filter((x)=>x>0).length/rets.length};
}

const holds=(process.env.HOLDS??"4,6,8,9,12").split(",").map(Number);
const cn=(u:number)=>(u+8)%24;
const w=(s:string,n:number)=>s+" ".repeat(Math.max(0,n-[...s].reduce((a,c)=>a+(c.charCodeAt(0)>127?2:1),0)));
console.log(`${PAIR?`多涨幅榜前 ${N} + 空跌幅榜前 ${N}（各半仓，市场中性）`:`${SIDE<0?"做空":"做多"}${LOSERS?"跌幅榜":"涨幅榜"}前 ${N}`}${VENUE_ONLY?"（只算 Variational 上市的）":"（全部币安合约）"} · ${dayList.length} 天 · 单边 ${FEE*10000}bp`);
console.log(`格内为「每日均值% (t值)」，均值为固定仓位算术平均\n`);
console.log(`${w("入场 UTC+8",12)}${holds.map((h)=>`持${h}h`.padStart(16)).join("")}`);
const cells:Array<{entry:number;hold:number;mean:number;t:number;end:number;win:number}>=[];
const entries=(process.env.ENTRIES??"").split(",").filter(Boolean).map((x)=>((Number(x)+24-8)%24));
for(const e of (entries.length?entries:[...Array(24).keys()])){
  const row=holds.map((h)=>{
    const r=window(e,h);
    if(!r)return "".padStart(16);
    cells.push({entry:cn(e),hold:h,mean:r.mean,t:r.t,end:r.end,win:r.win});
    return `${(100*r.mean).toFixed(3)} (${r.t.toFixed(2)})`.padStart(16);
  });
  console.log(`${w(`${String(cn(e)).padStart(2,"0")}:00`,12)}${row.join("")}`);
}
// Pooling beats cherry-picking: one good cell out of 120 is what noise looks
// like, but a session boundary that holds across every entry hour on both
// sides of it is a claim the whole table can be tested against.
if(process.env.DETAIL){
  const [e,h]=process.env.DETAIL.split(",").map(Number);
  const entryUtc=((e!+24-8)%24),hold=h!;
  const rets:number[]=[];const stamps:number[]=[];
  for(const d of dayList){
    const t=d+entryUtc*HOUR,exit=t+hold*HOUR;
    if(exit>LAST)continue;
    const ranked:Array<{s:string;c:number}>=[];
    for(const s of liquidByDay.get(d)!){
      const now=H_(s,t-HOUR),past=H_(s,t-HOUR-24*HOUR);
      if(now&&past&&past[2]>0)ranked.push({s,c:(now[2]-past[2])/past[2]});
    }
    if(ranked.length<2*N)continue;
    ranked.sort((a,b)=>b.c-a.c);
    const leg=(sym:string,side:1|-1)=>{const i=H_(sym,t),o=H_(sym,exit);return i&&o&&i[1]>0?side*(o[1]-i[1])/i[1]-2*FEE:null;};
    const up=ranked.slice(0,N).map((x)=>leg(x.s,1)).filter((x):x is number=>x!==null);
    const down=ranked.slice(-N).map((x)=>leg(x.s,-1)).filter((x):x is number=>x!==null);
    if(!up.length||!down.length)continue;
    rets.push(PAIR?0.5*(up.reduce((a,b)=>a+b,0)/up.length)+0.5*(down.reduce((a,b)=>a+b,0)/down.length)
                  :up.reduce((a,b)=>a+b,0)/up.length);
    stamps.push(d);
  }
  const START=500;
  // Leverage multiplies the daily return, so it multiplies the mean once and
  // the variance twice — the compounded outcome has to be re-walked, never
  // scaled. A day that takes the balance to zero ends the account: the curve
  // stops there rather than recovering on paper from a wipeout.
  if(process.env.LEV){
    console.log(`${PAIR?"市场中性对":"单边"} · UTC+8 ${e}:00 入场持 ${hold}h · ${rets.length} 天 · 起始 ${START} USDC\n`);
    console.log(`${"杠杆".padStart(5)}${"期末".padStart(11)}${"最低".padStart(9)}${"最大回撤".padStart(10)}${"单日最差".padStart(10)}${"爆仓".padStart(7)}${"日均".padStart(9)}`);
    for(const lev of [1,2,3,4,5]){
      let eq=START,peak=START,low=START,dd=0,dead=false,deadAt=0;
      for(let i=0;i<rets.length;i+=1){
        const r=rets[i]!*lev;
        eq*=1+r;
        if(eq<=0){dead=true;deadAt=i;eq=0;break;}
        peak=Math.max(peak,eq);low=Math.min(low,eq);dd=Math.min(dd,(eq-peak)/peak);
      }
      const worst=Math.min(...rets)*lev;
      console.log(`${(lev+"x").padStart(5)}${(dead?"归零":eq.toFixed(0)).padStart(11)}${low.toFixed(0).padStart(9)}${(100*dd).toFixed(0).padStart(9)}%${(100*worst).toFixed(1).padStart(9)}%${(dead?`第${deadAt}天`:"否").padStart(7)}${(100*lev*rets.reduce((a,b)=>a+b,0)/rets.length).toFixed(3).padStart(8)}%`);
    }
    const sorted=[...rets].sort((a,b)=>a-b);
    console.log(`\n1 倍下最差的 5 天：${sorted.slice(0,5).map((x)=>(100*x).toFixed(1)+"%").join("  ")}`);
    console.log(`对应 3 倍：${sorted.slice(0,5).map((x)=>(100*3*x).toFixed(1)+"%").join("  ")}`);
    // Equity hits zero when the levered day equals -100%, i.e. when the 1x
    // return reaches -1/L. Stated in 1x terms so it can be compared directly
    // against the observed daily series.
    console.log(`\n归零线（1 倍口径的单日跌幅）与实际观测的距离：`);
    const worstDay=Math.min(...rets);
    for(const lev of [2,3,4,5]){
      const ruin=-1/lev;
      console.log(`  ${lev} 倍  需要 1 倍单日跌 ${(100*ruin).toFixed(1)}%   367 天里实际发生 ${rets.filter((x)=>x<=ruin).length} 次   最差那天离它还差 ${(100*(ruin-worstDay)).toFixed(1)} 个百分点`);
    }
    console.log(`\n注意：交易所在权益归零之前就会强平，维持保证金触发点远早于此。以上是数学下界，不是安全边际。`);
    process.exit(0);
  }
  let eq=START,peak=START,low=START,dd=0;
  for(const r of rets){eq*=1+r;peak=Math.max(peak,eq);low=Math.min(low,eq);dd=Math.min(dd,(eq-peak)/peak);}
  const m=rets.reduce((a,b)=>a+b,0)/rets.length;
  const sd=Math.sqrt(rets.reduce((a,b)=>a+(b-m)**2,0)/(rets.length-1));
  const half=Math.floor(rets.length/2);
  const grow=(v:number[])=>v.reduce((a,b)=>a*(1+b),1);
  console.log(`${PAIR?"市场中性对":"仅做多涨幅榜"} · UTC+8 ${e}:00 入场，持 ${hold} 小时 · ${rets.length} 天`);
  console.log(`  期末 ${eq.toFixed(0)}（起始 ${START}）  最低 ${low.toFixed(0)}  最大回撤 ${(100*dd).toFixed(0)}%`);
  console.log(`  每日均值 ${(100*m).toFixed(3)}%  t=${(m/(sd/Math.sqrt(rets.length))).toFixed(2)}  夏普 ${((m/sd)*Math.sqrt(365)).toFixed(2)}  日胜率 ${(100*rets.filter((x)=>x>0).length/rets.length).toFixed(0)}%`);
  console.log(`  上半年 ${((grow(rets.slice(0,half))-1)*100).toFixed(0)}%   下半年 ${((grow(rets.slice(half))-1)*100).toFixed(0)}%`);
  const worst=[...rets].sort((a,b)=>a-b);
  console.log(`  单日最差 ${(100*worst[0]!).toFixed(1)}%   P5 ${(100*worst[Math.floor(0.05*worst.length)]!).toFixed(1)}%   最好 ${(100*worst.at(-1)!).toFixed(1)}%`);
  process.exit(0);
}
if(process.env.SESSIONS){
  const evening=(h:number)=>h>=18||h<6;
  const pool=(pick:(c:typeof cells[number])=>boolean)=>{
    const sel=cells.filter(pick);
    if(!sel.length)return null;
    const m=sel.reduce((a,b)=>a+b.mean,0)/sel.length;
    const sd=Math.sqrt(sel.reduce((a,b)=>a+(b.mean-m)**2,0)/Math.max(1,sel.length-1));
    return {n:sel.length,mean:m,spread:sd,pos:100*sel.filter((c)=>c.mean>0).length/sel.length};
  };
  const ev=pool((c)=>evening(c.entry)),dy=pool((c)=>!evening(c.entry));
  console.log("\n按时段汇总（该时段内所有入场时点 × 所有持有时长的平均）");
  console.log(`  晚间入场 18:00–06:00   ${ev?`${(100*ev.mean).toFixed(3)}% (${ev.n} 格，${ev.pos.toFixed(0)}% 为正)`:"—"}`);
  console.log(`  白天入场 06:00–18:00   ${dy?`${(100*dy.mean).toFixed(3)}% (${dy.n} 格，${dy.pos.toFixed(0)}% 为正)`:"—"}`);
  if(ev&&dy)console.log(`  差值 ${(100*(ev.mean-dy.mean)).toFixed(3)} 个百分点/天`);
  process.exit(0);
}
console.log("\n最好的 6 个组合（按 t 值）");
console.log(`${w("入场→出场 UTC+8",22)}${"每日均值".padStart(10)}${"t".padStart(7)}${"日胜率".padStart(8)}${"复利一年".padStart(11)}`);
for(const c of [...cells].sort((a,b)=>b.t-a.t).slice(0,6))
  console.log(`${w(`${String(c.entry).padStart(2,"0")}:00 → ${String((c.entry+c.hold)%24).padStart(2,"0")}:00 （持${c.hold}h）`,22)}${(100*c.mean).toFixed(3).padStart(9)}%${c.t.toFixed(2).padStart(7)}${c.win.toFixed(0).padStart(7)}%${((c.end-1)*100).toFixed(0).padStart(10)}%`);
process.exit(0);
