/**
 * The same strategy on an hourly clock, with a CVD vote that is actually a vote.
 *
 * The 15-minute replay could not test the direction filter at all: baselines
 * only keep the 15m CVD total, so the three 5m bins had to be faked by
 * splitting it in thirds — three identical numbers always agree, and the 3/3
 * rule passed everything. Every count it produced was of a looser strategy
 * than the one that runs.
 *
 * An hourly bar is built from four REAL 15m bins, so k-of-4 is a genuine test.
 */
import { readFileSync } from "node:fs";
import { atr, confirmedDirection, ema, findAtrSwing, fundingAnomaly, oiAnomaly, robustZScore, type Candle } from "@huxtrade/indicators";
import { chooseEntryLevel, makeRestingOrderPlan, resolveRestingEntry } from "@huxtrade/strategy-engine";
import type { Direction, HeatmapRegion } from "@huxtrade/shared-types";

const DIR="/private/tmp/claude-501/-Users-hux-Desktop-huxtrade/499bb97e-f722-4740-975b-f921f3a83a72/scratchpad";
type Bar=[number,number,number,number,number];
const kl=JSON.parse(readFileSync(`${DIR}/klines30d.json`,"utf8")) as Record<string,Bar[]>;
const hm=JSON.parse(readFileSync(`${DIR}/heatmap30d.json`,"utf8")) as Record<string,Array<{at:number;price:number;regions:Array<{p:number;lo:number;hi:number;i:number;pc:number;rk:number}>}>>;
const codemap=readFileSync(`${DIR}/codemap.txt`,"utf8").split("\n").filter(Boolean).map((l)=>l.split("|"));
const base=new Map<string,Array<[number,number]>>();
for(const line of readFileSync(`${DIR}/baselines.csv`,"utf8").split("\n")){
  if(!line)continue;const [code,metric,ts,value]=line.split(",");
  const key=`${code}:${metric}`;const arr=base.get(key)??[];arr.push([Number(ts)*1000,Number(value)]);base.set(key,arr);
}
for(const arr of base.values())arr.sort((a,b)=>a[0]-b[0]);

const settings=resolveRestingEntry(null);
const NOTIONAL=500,SLIP=0.0005,TRIG=0.5,FRAC=0.5,BE=0.05,HOUR=3600_000,FILL_W=6*HOUR,TRADE_W=24*HOUR;
const toCandles=(b:Bar[]):Candle[]=>b.map((x)=>({openTime:x[0],open:x[1],high:x[2],low:x[3],close:x[4],volume:0}));
const upto=(a:Array<[number,number]>,t:number)=>{let lo=0,hi=a.length-1,r=-1;while(lo<=hi){const m=(lo+hi)>>1;if(a[m]![0]<=t){r=m;lo=m+1;}else hi=m-1;}return r;};
function regionsAt(code:string,t:number):HeatmapRegion[]{
  const s=hm[code];if(!s?.length)return [];
  let lo=0,hi=s.length-1,r=-1;while(lo<=hi){const m=(lo+hi)>>1;if(s[m]!.at<=t){r=m;lo=m+1;}else hi=m-1;}
  return r<0?[]:s[r]!.regions.map((g)=>({price:g.p,lowPrice:g.lo,highPrice:g.hi,intensity:g.i,percentile:g.pc,rank:g.rk}));
}
/** Hourly CVD totals built from the real 15m series, aligned to the hour. */
function hourlyCvd(code:string){
  const raw=base.get(`${code}:CVD_15M`)??[];
  const buckets=new Map<number,number[]>();
  for(const [ts,value] of raw){
    const h=Math.floor(ts/HOUR)*HOUR;
    const arr=buckets.get(h)??[];arr.push(value);buckets.set(h,arr);
  }
  return [...buckets.entries()].filter(([,bins])=>bins.length===4).sort((a,b)=>a[0]-b[0]);
}
function walk(bars:Bar[],start:number,d:Direction,entry:number,sl:number,tp:number){
  const R=Math.abs(entry-sl);if(!(R>0))return null;
  const trig=d==="LONG"?entry+TRIG*R:entry-TRIG*R,be=d==="LONG"?entry+BE*R:entry-BE*R;
  let scaled=false,banked=0,qty=1,stop=sl;
  for(let j=start;j<bars.length;j+=1){
    if(bars[j]![0]>bars[start]![0]+TRADE_W)break;
    const hi=bars[j]![2],lo=bars[j]![3];
    if(d==="LONG"?lo<=stop:hi>=stop)return {pnl:banked+NOTIONAL*qty*((stop-entry)/entry*(d==="LONG"?1:-1)),out:scaled?"BE":"SL"};
    if(d==="LONG"?hi>=tp:lo<=tp)return {pnl:banked+NOTIONAL*qty*((tp-entry)/entry*(d==="LONG"?1:-1)),out:"TP"};
    if(!scaled&&(d==="LONG"?hi>=trig:lo<=trig)){banked+=NOTIONAL*FRAC*((trig-entry)/entry*(d==="LONG"?1:-1)-SLIP);qty=1-FRAC;scaled=true;stop=be;}
  }
  return null;
}

const votes=[3,4] as const;
const results:Record<number,Array<{pnl:number;out:string}>>={3:[],4:[]};
const armed:Record<number,number>={3:0,4:0};
for(const [code,sym] of codemap){
  const h1=kl[`${sym}:h1`],m15=kl[`${sym}:m15`];
  if(!h1?.length||!m15?.length)continue;
  const h1c=toCandles(h1);
  const cvdHours=hourlyCvd(code);
  const oi=base.get(`${code}:OI_RAW`),fund=base.get(`${code}:FUNDING_RAW`);
  if(!oi||!fund)continue;
  const totals=cvdHours.map(([,bins])=>bins.reduce((a,b)=>a+b,0));
  for(let n=300;n<cvdHours.length;n+=1){
    const [hourStart,bins]=cvdHours[n]!;
    const t=hourStart+HOUR;                       // decision at the hour's close
    const history=totals.slice(Math.max(0,n-720),n);
    if(history.length<200)continue;
    const z=robustZScore(totals[n]!,history);
    if(!Number.isFinite(z)||Math.abs(z)<1)continue;
    const io=upto(oi,t),ifd=upto(fund,t);
    if(io<200||ifd<200)continue;
    const o=oiAnomaly({values:oi.slice(Math.max(0,io-2888),io+1).map((x)=>x[1]),baselineSamples:2880});
    const f=fundingAnomaly({values:fund.slice(Math.max(0,ifd-2897),ifd+1).map((x)=>x[1]),baselineSamples:2880});
    if(!o.ready||!f.ready||!o.passed||!f.passed)continue;
    const hIdx=h1.findIndex((b)=>b[0]>t-HOUR)-1;
    if(hIdx<30)continue;
    const window=h1c.slice(Math.max(0,hIdx-99),hIdx+1);
    const atrV=atr(window,14).at(-1);
    if(!atrV||!(atrV>0))continue;
    const emaV=ema(window.map((c)=>c.close),20).at(-1)??null;
    const iM=m15.findIndex((b)=>b[0]>=t)-1;
    if(iM<1)continue;
    const price=m15[iM]![4];
    const regions=regionsAt(code,t);
    for(const k of votes){
      const vote=confirmedDirection(bins,k,4);
      if(vote===0)continue;
      const dir:Direction=vote>0?"LONG":"SHORT";
      if(Math.sign(z)!==Math.sign(totals[n]!))continue;
      armed[k]!+=1;
      let swing:number|null=null;try{swing=findAtrSwing(window,atrV,dir);}catch{swing=null;}
      const cand=chooseEntryLevel({direction:dir,price,atr1h:atrV,ema:emaV,swing,regions},settings);
      if(!cand)continue;
      let plan;
      try{plan=makeRestingOrderPlan({symbol:sym,direction:dir,closedAt:new Date(t).toISOString(),candidate:cand,price,atr1h:atrV,regions,marginUsdc:100,leverage:5},settings);}
      catch{continue;}
      for(let j=iM+1;j<m15.length;j+=1){
        if(m15[j]![0]>t+FILL_W)break;
        if(m15[j]![3]<=plan.entryPrice&&plan.entryPrice<=m15[j]![2]){
          const r=walk(m15,j,dir,plan.entryPrice,plan.stopLoss,plan.takeProfit);
          if(r)results[k]!.push(r);
          break;
        }
      }
    }
  }
}
console.log("1 小时决策，CVD 方向由该小时内 4 根真实 15 分钟桶投票\n");
console.log(`${"投票".padEnd(8)}${"武装".padStart(7)}${"成交".padStart(7)}${"止盈".padStart(6)}${"保本".padStart(6)}${"止损".padStart(6)}${"总额".padStart(11)}${"均值".padStart(9)}${"胜率".padStart(7)}`);
for(const k of votes){
  const r=results[k]!;if(!r.length){console.log(`${k}/4`,"无成交");continue;}
  const pnl=r.map((x)=>x.pnl),sum=pnl.reduce((a,b)=>a+b,0);
  console.log(`${(k+"/4").padEnd(8)}${String(armed[k]).padStart(7)}${String(r.length).padStart(7)}${String(r.filter((x)=>x.out==="TP").length).padStart(6)}`+
    `${String(r.filter((x)=>x.out==="BE").length).padStart(6)}${String(r.filter((x)=>x.out==="SL").length).padStart(6)}`+
    `${sum.toFixed(2).padStart(11)}${(sum/r.length).toFixed(3).padStart(9)}${(100*pnl.filter((x)=>x>0).length/r.length).toFixed(0).padStart(6)}%`);
}
process.exit(0);
