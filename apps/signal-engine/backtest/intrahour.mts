/**
 * Does the quarter-hour you act on matter?
 *
 * Everything so far has been measured on the hour, which is also when every
 * other clock-driven participant acts — candles close, bots fire, boards
 * refresh. If the hour is a crowded, thin moment then stepping fifteen minutes
 * off it should show up as a better fill, and if it is not, the four offsets
 * will be indistinguishable and the question is settled.
 *
 * Entry and exit offsets are varied separately: a difference that only appears
 * when both move is a difference in the holding period, not in the timing.
 */
import { readFileSync } from "node:fs";
const DIR="/private/tmp/claude-501/-Users-hux-Desktop-huxtrade/499bb97e-f722-4740-975b-f921f3a83a72/scratchpad";
type D=[number,number,number,number,number,number];
const daily=JSON.parse(readFileSync(`${DIR}/histohlc.json`,"utf8")) as Record<string,D[]>;
const listed=new Set(JSON.parse(readFileSync(`${DIR}/vari_assets.json`,"utf8")) as string[]);
const VENUE_ONLY=Boolean(process.env.VARI);

const bars=new Map<string,Map<number,number>>();
for(const line of readFileSync(`${DIR}/m15.ndjson`,"utf8").split("\n")){
  if(!line)continue;
  const [sym,rows]=JSON.parse(line) as [string,Array<[number,number]>];
  if(VENUE_ONLY&&!listed.has(sym.replace("USDT","")))continue;
  bars.set(sym,new Map(rows));
}
const symbols=[...bars.keys()];
const MIN=60_000,DAY=86_400_000,LIQUID=200,N=5,FEE=0.0005;
const dI=new Map(symbols.filter((s)=>daily[s]).map((s)=>[s,new Map(daily[s]!.map((r)=>[Math.floor(r[0]/DAY)*DAY,r]))]));
const P=(s:string,t:number)=>bars.get(s)?.get(t)??null;
const D_=(s:string,t:number)=>dI.get(s)?.get(Math.floor(t/DAY)*DAY)??null;
const stamps=[...new Set(symbols.flatMap((s)=>[...bars.get(s)!.keys()]))].sort((a,b)=>a-b);
const FIRST=stamps[0]!+31*DAY,LAST=stamps.at(-1)!;

const days:number[]=[],pool=new Map<number,string[]>();
for(let d=Math.ceil(FIRST/DAY)*DAY;d<LAST-2*DAY;d+=DAY){
  const rows:Array<{s:string;vol:number}>=[];
  for(const s of symbols){
    let v=0,k=0;for(let i=1;i<=30;i+=1){const r=D_(s,d-i*DAY);if(r){v+=r[5];k+=1;}}
    if(k>=25)rows.push({s,vol:v/k});
  }
  if(rows.length<2*N)continue;
  days.push(d);pool.set(d,rows.sort((a,b)=>b.vol-a.vol).slice(0,LIQUID).map((x)=>x.s));
}

/** entryOffset/exitOffset are minutes past UTC 16:00 and UTC 00:00. */
function run(entryOffset:number,exitOffset:number){
  const rets:number[]=[];
  for(const d of days){
    const t=d+16*3600_000+entryOffset*MIN,exit=d+24*3600_000+exitOffset*MIN;
    if(exit>LAST)continue;
    const ranked:Array<{s:string;c:number}>=[];
    for(const s of pool.get(d)!){
      const now=P(s,t-15*MIN),past=P(s,t-15*MIN-DAY);
      if(now!==null&&past!==null&&past>0)ranked.push({s,c:(now-past)/past});
    }
    if(ranked.length<2*N)continue;
    ranked.sort((a,b)=>b.c-a.c);
    const leg=(sym:string,side:1|-1)=>{const i=P(sym,t),o=P(sym,exit);return i!==null&&o!==null&&i>0?side*(o-i)/i-2*FEE:null;};
    const up=ranked.slice(0,N).map((x)=>leg(x.s,1)).filter((x):x is number=>x!==null);
    const down=ranked.slice(-N).map((x)=>leg(x.s,-1)).filter((x):x is number=>x!==null);
    if(!up.length||!down.length)continue;
    rets.push(0.5*(up.reduce((a,b)=>a+b,0)/up.length)+0.5*(down.reduce((a,b)=>a+b,0)/down.length));
  }
  if(rets.length<60)return null;
  const m=rets.reduce((a,b)=>a+b,0)/rets.length;
  const sd=Math.sqrt(rets.reduce((a,b)=>a+(b-m)**2,0)/(rets.length-1));
  return {n:rets.length,mean:m,t:m/(sd/Math.sqrt(rets.length)),sd};
}

const offsets=[0,15,30,45];
const w=(s:string,n:number)=>s+" ".repeat(Math.max(0,n-[...s].reduce((a,c)=>a+(c.charCodeAt(0)>127?2:1),0)));
console.log(`多空组合${VENUE_ONLY?"（只算 Variational）":"（全部币安合约）"} · UTC+8 00:00 建仓 / 08:00 平仓 · ${days.length} 天 · 单边 ${FEE*10000}bp`);
console.log(`格内为每日均值%（t 值）。行=入场偏移，列=出场偏移\n`);
console.log(`${w("入场",10)}${offsets.map((o)=>`出场 +${o}分`.padStart(16)).join("")}`);
const flat:number[]=[];
for(const ein of offsets){
  const row=offsets.map((eout)=>{
    const r=run(ein,eout);
    if(!r)return "".padStart(16);
    flat.push(r.mean);
    return `${(100*r.mean).toFixed(3)} (${r.t.toFixed(2)})`.padStart(16);
  });
  console.log(`${w(`+${ein} 分`,10)}${row.join("")}`);
}
const base=run(0,0);
if(base){
  const spread=Math.max(...flat)-Math.min(...flat);
  console.log(`\n16 格全距 ${(100*spread).toFixed(3)} 个百分点/天`);
  console.log(`整点那一格的单日标准差 ${(100*base.sd).toFixed(2)}%，标准误 ${(100*base.sd/Math.sqrt(base.n)).toFixed(3)}%`);
  console.log(`→ 全距是标准误的 ${(spread/(base.sd/Math.sqrt(base.n))).toFixed(1)} 倍`);
}
process.exit(0);
