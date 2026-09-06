/**
 * The same 9-hour window, sliced by where a coin sits on the gainers board.
 *
 * Rank bands are reported per position and as a compounding basket, because
 * the two answer different questions: per-position says whether that slice of
 * the board is worth owning, the basket says what it would have done to the
 * account. Bands are also run against the Variational listing, since a rank
 * that cannot be filled is not an option.
 */
import { readFileSync } from "node:fs";
const DIR="/private/tmp/claude-501/-Users-hux-Desktop-huxtrade/499bb97e-f722-4740-975b-f921f3a83a72/scratchpad";
type H=[number,number,number];type D=[number,number,number,number,number,number];
const hourly=JSON.parse(readFileSync(`${DIR}/hourly1h.json`,"utf8")) as Record<string,H[]>;
const daily=JSON.parse(readFileSync(`${DIR}/histohlc.json`,"utf8")) as Record<string,D[]>;
const listed=new Set(JSON.parse(readFileSync(`${DIR}/vari_assets.json`,"utf8")) as string[]);
const symbols=Object.keys(hourly);
const HOUR=3_600_000,DAY=86_400_000,LIQUID=200,ENTRY=14,EXIT=23,FEE=0.0005;
const hI=new Map(symbols.map((s)=>[s,new Map(hourly[s]!.map((r)=>[Math.floor(r[0]/HOUR)*HOUR,r]))]));
const dI=new Map(symbols.filter((s)=>daily[s]).map((s)=>[s,new Map(daily[s]!.map((r)=>[Math.floor(r[0]/DAY)*DAY,r]))]));
const H_=(s:string,t:number)=>hI.get(s)?.get(Math.floor(t/HOUR)*HOUR)??null;
const D_=(s:string,t:number)=>dI.get(s)?.get(Math.floor(t/DAY)*DAY)??null;
const all=[...new Set(symbols.flatMap((s)=>hourly[s]!.map((r)=>Math.floor(r[0]/HOUR)*HOUR)))].sort((a,b)=>a-b);
const FIRST=all[0]!+31*DAY,LAST=all.at(-1)!;

// One pass over the year: every day's full ranked board with each name's
// nine-hour outcome, so a band is just a slice of an already-computed list.
type Day={t:number;board:Array<{sym:string;ret:number;change:number;onVenue:boolean}>};
const days:Day[]=[];
for(let d=Math.ceil(FIRST/DAY)*DAY;d<LAST-DAY;d+=DAY){
  const t=d+ENTRY*HOUR,exit=d+EXIT*HOUR;
  if(exit>LAST)break;
  const pool:Array<{s:string;vol:number}>=[];
  for(const s of symbols){let v=0,k=0;for(let i=1;i<=30;i+=1){const r=D_(s,t-i*DAY);if(r){v+=r[5];k+=1;}}if(k>=25)pool.push({s,vol:v/k});}
  const liquid=pool.sort((a,b)=>b.vol-a.vol).slice(0,LIQUID);
  const ranked:Array<{s:string;change:number}>=[];
  for(const {s} of liquid){const now=H_(s,t-HOUR),past=H_(s,t-HOUR-24*HOUR);
    if(now&&past&&past[2]>0)ranked.push({s,change:(now[2]-past[2])/past[2]});}
  if(ranked.length<30)continue;
  ranked.sort((a,b)=>b.change-a.change);
  const board:Day["board"]=[];
  for(const {s,change} of ranked.slice(0,40)){
    const i=H_(s,t),o=H_(s,exit);
    if(!i||!o||!(i[1]>0))continue;
    board.push({sym:s.replace("USDT",""),ret:(o[1]-i[1])/i[1]-2*FEE,change,onVenue:listed.has(s.replace("USDT",""))});
  }
  if(board.length>=20)days.push({t:d,board});
}

const pct=(x:number)=>`${(100*x).toFixed(2)}%`;
function band(from:number,to:number,venueOnly:boolean){
  const rets:number[]=[],basket:Array<[number,number]>=[];
  for(const day of days){
    const list=venueOnly?day.board.filter((x)=>x.onVenue):day.board;
    const slice=list.slice(from-1,to);
    if(!slice.length)continue;
    for(const x of slice)rets.push(x.ret);
    basket.push([day.t,slice.reduce((a,b)=>a+b.ret,0)/slice.length]);
  }
  if(rets.length<50)return null;
  const mean=rets.reduce((a,b)=>a+b,0)/rets.length;
  const sd=Math.sqrt(rets.reduce((a,b)=>a+(b-mean)**2,0)/(rets.length-1));
  let eq=500,peak=500,dd=0;
  for(const [,r] of basket){eq*=1+r;peak=Math.max(peak,eq);dd=Math.min(dd,(eq-peak)/peak);}
  const bm=basket.map((x)=>x[1]),bmean=bm.reduce((a,b)=>a+b,0)/bm.length;
  const bsd=Math.sqrt(bm.reduce((a,b)=>a+(b-bmean)**2,0)/(bm.length-1));
  const half=Math.floor(basket.length/2);
  const grow=(rows:typeof basket)=>rows.reduce((a,b)=>a*(1+b[1]),1);
  return {n:rets.length,mean,t:mean/(sd/Math.sqrt(rets.length)),
    win:100*rets.filter((x)=>x>0).length/rets.length,
    d20:100*rets.filter((x)=>x<=-0.20).length/rets.length,
    end:eq,dd,sharpe:(bmean/bsd)*Math.sqrt(365),
    h1:grow(basket.slice(0,half)),h2:grow(basket.slice(half))};
}
const w=(s:string,n:number)=>s+" ".repeat(Math.max(0,n-[...s].reduce((a,c)=>a+(c.charCodeAt(0)>127?2:1),0)));
function table(title:string,venueOnly:boolean){
  console.log(`\n${title}`);
  console.log(`${w("名次区间",12)}${"仓位数".padStart(7)}${"单笔均值".padStart(10)}${"t".padStart(7)}${"胜率".padStart(7)}${"跌>20%".padStart(8)}${"500→".padStart(9)}${"回撤".padStart(8)}${"夏普".padStart(7)}${"上半年".padStart(8)}${"下半年".padStart(8)}`);
  // Single ranks first: if the edge lives in one seat, every band containing
  // it inherits the credit and every band that misses it looks broken.
  for(const [a,b] of [[1,1],[2,2],[3,3],[4,4],[5,5],[1,2],[1,3],[1,4],[1,5],[2,5],[3,5],[4,5],[5,10]] as const){
    const r=band(a,b,venueOnly);
    if(!r){console.log(`${w(`${a}–${b} 名`,12)}  样本不足`);continue;}
    console.log(`${w(`${a}–${b} 名`,12)}${String(r.n).padStart(7)}${pct(r.mean).padStart(10)}${r.t.toFixed(2).padStart(7)}${(r.win.toFixed(0)+"%").padStart(7)}${(r.d20.toFixed(1)+"%").padStart(8)}${r.end.toFixed(0).padStart(9)}${(100*r.dd).toFixed(0).padStart(7)}%${r.sharpe.toFixed(2).padStart(7)}${((r.h1-1)*100).toFixed(0).padStart(7)}%${((r.h2-1)*100).toFixed(0).padStart(7)}%`);
  }
}
console.log(`${days.length} 天 / UTC 14:00 → 23:00（UTC+8 22:00 → 次日 07:00）/ 单边 ${FEE*10000}bp / 复利，起始 500`);
table("【全部币安合约】","" as unknown as boolean?true:false);
table("【只算 Variational 上市的（实际能买到的）】",true);
process.exit(0);
