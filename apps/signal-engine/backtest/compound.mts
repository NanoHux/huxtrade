/**
 * UTC+8 22:00 in, next-day 07:00 out, with the balance rolled forward.
 *
 * Compounding is not a presentation choice — it changes the result. Every
 * earlier run staked a fixed 120 per leg, so a drawdown cost the same whether
 * it arrived rich or poor. Here the stake is balance/5, which compounds gains
 * and, more to the point, shrinks the bet after losses: the same sequence of
 * daily returns lands somewhere else, and ruin becomes reachable in a way a
 * fixed stake never shows.
 */
import { readFileSync } from "node:fs";
const DIR="/private/tmp/claude-501/-Users-hux-Desktop-huxtrade/499bb97e-f722-4740-975b-f921f3a83a72/scratchpad";
type H=[number,number,number];      // openTime, open, close
type D=[number,number,number,number,number,number];
const hourly=JSON.parse(readFileSync(`${DIR}/hourly1h.json`,"utf8")) as Record<string,H[]>;
const daily=JSON.parse(readFileSync(`${DIR}/histohlc.json`,"utf8")) as Record<string,D[]>;
// VARI=1 keeps only what the venue lists, and fills however many of the five
// survive that filter — the rule the account will actually run under.
const listed=new Set(JSON.parse(readFileSync(`${DIR}/vari_assets.json`,"utf8")) as string[]);
const onVenue=(sym:string)=>listed.has(sym.replace(/USDT$/,""));
const symbols=Object.keys(hourly);
const HOUR=3_600_000,DAY=86_400_000,FEE=0.0005,LIQUID=200,N=5,START_EQUITY=500;
const ENTRY_UTC=Number(process.env.ENTRY_UTC??14),EXIT_UTC=Number(process.env.EXIT_UTC??23);
// +1 long, -1 short. Shorting the gainers board is a different trade from
// declining to buy it, and the venue charges for it — see the funding note in
// the report; none of it is in these numbers.
const SIDE=Number(process.env.SIDE??1)<0?-1:1;
const hI=new Map<string,Map<number,H>>();
for(const s of symbols)hI.set(s,new Map(hourly[s]!.map((r)=>[Math.floor(r[0]/HOUR)*HOUR,r])));
const dI=new Map<string,Map<number,D>>();
for(const s of symbols)if(daily[s])dI.set(s,new Map(daily[s]!.map((r)=>[Math.floor(r[0]/DAY)*DAY,r])));
const H_=(s:string,t:number)=>hI.get(s)?.get(Math.floor(t/HOUR)*HOUR)??null;
const D_=(s:string,t:number)=>dI.get(s)?.get(Math.floor(t/DAY)*DAY)??null;
const allHours=[...new Set(symbols.flatMap((s)=>hourly[s]!.map((r)=>Math.floor(r[0]/HOUR)*HOUR)))].sort((a,b)=>a-b);
const FIRST=allHours[0]!+31*DAY,LAST=allHours.at(-1)!;

type Day={t:number;ret:number;picks:string[]};
const days:Day[]=[];
for(let d=Math.ceil(FIRST/DAY)*DAY;d<LAST-DAY;d+=DAY){
  const entry=d+ENTRY_UTC*HOUR,exit=d+EXIT_UTC*HOUR;
  if(exit>LAST)break;
  const pool:Array<{s:string;vol:number}>=[];
  for(const s of symbols){
    let vol=0,k=0;
    for(let i=1;i<=30;i+=1){const r=D_(s,entry-i*DAY);if(r){vol+=r[5];k+=1;}}
    if(k>=25)pool.push({s,vol:vol/k});
  }
  const liquid=pool.sort((a,b)=>b.vol-a.vol).slice(0,LIQUID);
  const ranked:Array<{s:string;ret:number}>=[];
  for(const {s} of liquid){
    // Last CLOSED hour before the order, against the same hour a day earlier.
    const now=H_(s,entry-HOUR),past=H_(s,entry-HOUR-24*HOUR);
    if(now&&past&&past[2]>0)ranked.push({s,ret:(now[2]-past[2])/past[2]});
  }
  if(ranked.length<2*N)continue;
  ranked.sort((a,b)=>b.ret-a.ret);
  const rets:number[]=[],picks:string[]=[];
  const chosen=process.env.VARI?ranked.filter((x)=>onVenue(x.s)).slice(0,N):ranked.slice(0,N);
  for(const {s} of chosen){
    const i=H_(s,entry),o=H_(s,exit);
    if(!i||!o||!(i[1]>0))continue;
    rets.push(SIDE*(o[1]-i[1])/i[1]-2*FEE);picks.push(s);
  }
  // Equal weight across whatever filled, so a two-name day still deploys the
  // whole balance — that is what "剩几个做几个，仓位都一样" means.
  if(rets.length)days.push({t:d,ret:rets.reduce((a,b)=>a+b,0)/rets.length,picks});
}

function walk(list:Day[],start:number){
  let eq=start,peak=start,low=start,dd=0;
  const curve:number[]=[];
  for(const day of list){
    // Equal split of whatever the balance is that evening.
    eq=eq*(1+day.ret);
    peak=Math.max(peak,eq);low=Math.min(low,eq);
    dd=Math.min(dd,(eq-peak)/peak);
    curve.push(eq);
  }
  const r=list.map((x)=>x.ret),m=r.reduce((a,b)=>a+b,0)/r.length;
  const sd=Math.sqrt(r.reduce((a,b)=>a+(b-m)**2,0)/Math.max(1,r.length-1));
  return {end:eq,low,dd,days:list.length,win:100*r.filter((x)=>x>0).length/r.length,
    t:m/(sd/Math.sqrt(r.length)),sharpe:(m/sd)*Math.sqrt(365),best:Math.max(...r),worst:Math.min(...r),curve};
}
const fmt=(x:number)=>x.toFixed(0).padStart(8);
const mid=Math.floor(days.length/2);
const whole=walk(days,START_EQUITY);
const h1=walk(days.slice(0,mid),START_EQUITY);
const h2=walk(days.slice(mid),START_EQUITY);
const label=(list:Day[])=>`${new Date(list[0]!.t).toISOString().slice(0,10)} ~ ${new Date(list.at(-1)!.t).toISOString().slice(0,10)}`;

const cn=(u:number)=>(u+8)%24;
const hold=((EXIT_UTC-ENTRY_UTC+24)%24)||24;
console.log(`UTC+8 ${String(cn(ENTRY_UTC)).padStart(2,"0")}:00 ${SIDE>0?"买入":"做空"}涨幅榜前 ${N}，${String(cn(EXIT_UTC)).padStart(2,"0")}:00 全部平仓（= UTC ${ENTRY_UTC}:00 → ${EXIT_UTC}:00，持有 ${hold} 小时）`);
console.log(`起始 ${START_EQUITY} USDC（每只 100），每天余额均分 5 份复投，单边 ${FEE*10000}bp\n`);
console.log(`${"区间".padEnd(26)}${"天数".padStart(6)}${"期末余额".padStart(11)}${"最低".padStart(9)}${"最大回撤".padStart(10)}${"日胜率".padStart(8)}${"夏普".padStart(7)}${"t".padStart(7)}`);
for(const [name,r,list] of [["全年",whole,days],["上半年",h1,days.slice(0,mid)],["下半年",h2,days.slice(mid)]] as const)
  console.log(`${(name+"  "+label(list)).padEnd(26)}${String(r.days).padStart(6)}${fmt(r.end).padStart(11)}${fmt(r.low)}${(100*r.dd).toFixed(0).padStart(9)}%${r.win.toFixed(0).padStart(7)}%${r.sharpe.toFixed(2).padStart(7)}${r.t.toFixed(2).padStart(7)}`);

console.log(`\n单日涨跌幅  最好 +${(100*whole.best).toFixed(1)}%   最差 ${(100*whole.worst).toFixed(1)}%`);
// Fixed stake separates a genuinely losing edge from variance drag: the same
// daily returns, not compounded, show what the rule earns before compounding
// taxes its own volatility.
const flat=days.reduce((a,b)=>a+b.ret,0),mean=flat/days.length;
const sd=Math.sqrt(days.reduce((a,b)=>a+(b.ret-mean)**2,0)/(days.length-1));
console.log(`固定仓位（不复投）每日均值 ${(100*mean).toFixed(3)}% ± ${(100*sd/Math.sqrt(days.length)).toFixed(3)}%  (t=${(mean/(sd/Math.sqrt(days.length))).toFixed(2)})`);
console.log(`  一年累计（算术） ${(100*flat).toFixed(1)}%   复利实际 ${(100*(whole.end/START_EQUITY-1)).toFixed(1)}%   波动拖累 ${(100*(flat-(whole.end/START_EQUITY-1))).toFixed(1)} 个百分点`);
console.log(`下半年若接着上半年的余额跑：${(START_EQUITY*(whole.end/START_EQUITY)).toFixed(0)} USDC（全年复利结果）`);

// The average of a compounded path is not what the path does. Month by month
// is where a good year hiding three bad quarters shows itself.
console.log("\n分月（每月都从当月起点算，%）");
const byMonth=new Map<string,number[]>();
for(const day of days){const k=new Date(day.t).toISOString().slice(0,7);const a=byMonth.get(k)??[];a.push(day.ret);byMonth.set(k,a);}
for(const [month,rets] of [...byMonth].sort((a,b)=>a[0]<b[0]?-1:1)){
  const growth=rets.reduce((a,b)=>a*(1+b),1);
  const bar=growth>=1?"+".repeat(Math.min(30,Math.round((growth-1)*20))):"-".repeat(Math.min(30,Math.round((1-growth)*20)));
  console.log(`  ${month}  ${String(rets.length).padStart(2)} 天  ${((growth-1)*100).toFixed(1).padStart(7)}%  ${bar}`);
}
// A month that carries the whole year deserves the same question that
// overturned the earlier momentum result: is it a regime, or two coins?
const april=days.filter((d)=>new Date(d.t).toISOString().slice(0,7)==="2026-04").sort((a,b)=>b.ret-a.ret);
console.log("\n2026-04 最好的 6 天（当月 +301%）");
for(const d of april.slice(0,6))
  console.log(`  ${new Date(d.t).toISOString().slice(0,10)}  ${(100*d.ret).toFixed(1).padStart(6)}%   ${d.picks.map((s)=>s.replace("USDT","")).join(" ")}`);
const rest=april.slice(6).reduce((a,b)=>a*(1+b.ret),1);
console.log(`  去掉这 6 天，当月剩余 ${april.length-6} 天合计 ${((rest-1)*100).toFixed(1)}%`);
const noApril=days.filter((d)=>new Date(d.t).toISOString().slice(0,7)!=="2026-04").reduce((a,b)=>a*(1+b.ret),1);
console.log(`\n整年剔除 2026-04：500 → ${(500*noApril).toFixed(0)} USDC（对比含 4 月的 ${whole.end.toFixed(0)}）`);
const counts=new Map<string,number>();
for(const d of days)for(const s of d.picks)counts.set(s,(counts.get(s)??0)+1);
console.log(`\n全年被选中最多的币：${[...counts].sort((a,b)=>b[1]-a[1]).slice(0,8).map(([s,n])=>`${s.replace("USDT","")}(${n})`).join("  ")}`);
process.exit(0);
