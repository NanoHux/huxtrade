/**
 * Cross-sectional strategies — the ones that rank assets against each other
 * rather than each against its own past. The per-asset harness cannot express
 * them, and momentum-by-ranking is the most documented anomaly in crypto, so
 * leaving it untested would be leaving out the obvious candidate.
 *
 * Equal money per leg, rebalanced on a fixed clock, costs charged on turnover.
 */
import { readFileSync } from "node:fs";
const DIR="/private/tmp/claude-501/-Users-hux-Desktop-huxtrade/499bb97e-f722-4740-975b-f921f3a83a72/scratchpad";
type Raw=[number,number,number,number,number,number];
const ohlc=JSON.parse(readFileSync(`${DIR}/ohlc5m.json`,"utf8")) as Record<string,Raw[]>;
const EXCLUDE=(process.env.EXCLUDE??"").split(",").filter(Boolean);
const codes=Object.keys(ohlc).filter((c)=>ohlc[c]!.length>1000&&!EXCLUDE.includes(c));
const fund=new Map<string,Array<[number,number]>>();
for(const line of readFileSync(`${DIR}/baselines.csv`,"utf8").split("\n")){
  if(!line)continue;const [code,metric,ts,value]=line.split(",");
  if(metric!=="FUNDING_RAW")continue;
  const arr=fund.get(code!)??[];arr.push([Number(ts)*1000,Number(value)]);fund.set(code!,arr);
}
for(const arr of fund.values())arr.sort((a,b)=>a[0]-b[0]);

const DAY=86_400_000,FEE=0.0005,LEG=500;
const grid:number[]=[];{
  const s=Math.max(...codes.map((c)=>ohlc[c]![0]![0])),e=Math.min(...codes.map((c)=>ohlc[c]!.at(-1)![0]));
  for(let t=Math.ceil(s/DAY)*DAY;t<=e;t+=DAY)grid.push(t);
}
const priceAt=(code:string,t:number)=>{const b=ohlc[code]!;let lo=0,hi=b.length-1,r=-1;
  while(lo<=hi){const m=(lo+hi)>>1;if(b[m]![0]<=t){r=m;lo=m+1;}else hi=m-1;}return r<0?null:b[r]![4];};
const fundAt=(code:string,t:number)=>{const a=fund.get(code);if(!a)return null;let lo=0,hi=a.length-1,r=-1;
  while(lo<=hi){const m=(lo+hi)>>1;if(a[m]![0]<=t){r=m;lo=m+1;}else hi=m-1;}return r<0?null:a[r]![1];};

type Score=(code:string,t:number)=>number|null;
function run(name:string,score:Score,n:number,shortLeg:boolean,holdDays:number){
  const legs:number[]=[];
  for(let g=0;g+holdDays<grid.length;g+=holdDays){
    const t=grid[g]!,t2=grid[g+holdDays]!;
    const ranked=codes.map((c)=>({c,s:score(c,t)})).filter((x):x is {c:string;s:number}=>x.s!==null&&Number.isFinite(x.s)).sort((a,b)=>b.s-a.s);
    if(ranked.length<2*n)continue;
    const legReturn=(code:string,side:1|-1)=>{
      const p1=priceAt(code,t),p2=priceAt(code,t2);
      if(p1===null||p2===null||!(p1>0))return 0;
      return LEG*(side*(p2-p1)/p1-2*FEE);
    };
    let pnl=0;
    for(const {c} of ranked.slice(0,n))pnl+=legReturn(c,1);
    if(shortLeg)for(const {c} of ranked.slice(-n))pnl+=legReturn(c,-1);
    legs.push(pnl);
  }
  if(legs.length<2)return null;
  const sum=legs.reduce((a,b)=>a+b,0),mean=sum/legs.length;
  const sd=Math.sqrt(legs.reduce((a,b)=>a+(b-mean)**2,0)/(legs.length-1)),se=sd/Math.sqrt(legs.length);
  let e=0,peak=0,dd=0;for(const p of legs){e+=p;peak=Math.max(peak,e);dd=Math.min(dd,e-peak);}
  const capital=LEG*n*(shortLeg?2:1);
  return {name,periods:legs.length,sum,mean,t:mean/se,win:100*legs.filter((x)=>x>0).length/legs.length,dd,capital};
}
const ret=(days:number):Score=>(code,t)=>{const a=priceAt(code,t-days*DAY),b=priceAt(code,t);return a&&b&&a>0?(b-a)/a:null;};

if(process.env.SWEEP){
  // A real anomaly is not knife-edge. If only one lookback and one basket size
  // work, the grid found a coincidence and named it a strategy.
  console.log(`只做多，持 1 日${EXCLUDE.length?`（已剔除 ${EXCLUDE.join("、")}）`:""}\n`);
  console.log(`${"回看".padStart(6)}${[3,5,10].map((n)=>`  篮子${n}`.padStart(20)).join("")}`);
  for(const look of [1,3,5,7,14,21]){
    const cells=[3,5,10].map((n)=>{const r=run("",ret(look),n,false,1);
      return r?`${(100*r.sum/r.capital).toFixed(0)}% (t=${r.t.toFixed(2)})`.padStart(20):"".padStart(20);});
    console.log(`${(look+"日").padStart(6)}${cells.join("")}`);
  }
  process.exit(0);
}
const rows=[
  run("横截面动量 7日 多空各5 持1日",ret(7),5,true,1),
  run("横截面动量 7日 只做多5 持1日",ret(7),5,false,1),
  run("横截面动量 7日 多空各5 持7日",ret(7),5,true,7),
  run("横截面动量 30日 多空各5 持7日",ret(30),5,true,7),
  run("横截面动量 1日 多空各5 持1日",ret(1),5,true,1),
  run("横截面反转 1日 多空各5 持1日",(c,t)=>{const v=ret(1)(c,t);return v===null?null:-v;},5,true,1),
  run("横截面反转 7日 多空各5 持1日",(c,t)=>{const v=ret(7)(c,t);return v===null?null:-v;},5,true,1),
  run("资金费率套利 空高费率5 持1日",(c,t)=>fundAt(c,t),5,true,1),
  run("资金费率反向 多高费率5 持1日",(c,t)=>{const v=fundAt(c,t);return v===null?null:-v;},5,true,1),
].filter((x):x is NonNullable<typeof x>=>x!==null).sort((a,b)=>b.sum-a.sum);

const w=(s:string,n:number)=>s+" ".repeat(Math.max(0,n-[...s].reduce((a,ch)=>a+(ch.charCodeAt(0)>127?2:1),0)));
console.log(`46 币 / 36 天 / 每腿 ${LEG} USDC / 单边 ${FEE*10000}bp\n`);
console.log(`${w("策略",34)}${"调仓次数".padStart(10)}${"总盈亏".padStart(10)}${"投入本金".padStart(10)}${"回报率".padStart(9)}${"t".padStart(7)}${"胜率".padStart(7)}${"回撤".padStart(9)}`);
for(const r of rows)console.log(`${w(r.name,34)}${String(r.periods).padStart(10)}${r.sum.toFixed(0).padStart(10)}${String(r.capital).padStart(10)}${(100*r.sum/r.capital).toFixed(1).padStart(8)}%${r.t.toFixed(2).padStart(7)}${r.win.toFixed(0).padStart(6)}%${r.dd.toFixed(0).padStart(9)}`);
process.exit(0);
