/**
 * The CVD direction filter, measured instead of assumed.
 *
 * Every earlier replay faked the three 5m bins by splitting the 15m total into
 * thirds. Three identical numbers always agree, so `cvdAnomaly`'s unanimous
 * vote — the filter that abstains on ~71% of bars in production — passed
 * everything. The counts those runs produced belong to a strategy nobody runs.
 *
 * Binance keeps 5m klines for months and CVD is derived from them
 * (2*takerBuyQuote - quoteVolume, exactly as market-collector computes it), so
 * the real bins were always available. Every variant below runs on one window
 * with one baseline policy; only the vote changes.
 */
import { readFileSync } from "node:fs";
import { atr, cvdAnomaly, confirmedDirection, ema, findAtrSwing, fundingAnomaly, oiAnomaly, robustZScore, type Candle } from "@huxtrade/indicators";
import { chooseEntryLevel, makeRestingOrderPlan, resolveRestingEntry } from "@huxtrade/strategy-engine";
import type { Direction, HeatmapRegion } from "@huxtrade/shared-types";

const DIR="/private/tmp/claude-501/-Users-hux-Desktop-huxtrade/499bb97e-f722-4740-975b-f921f3a83a72/scratchpad";
type Bar=[number,number,number,number,number];
const kl=JSON.parse(readFileSync(`${DIR}/klines30d.json`,"utf8")) as Record<string,Bar[]>;
const hm=JSON.parse(readFileSync(`${DIR}/heatmap30d.json`,"utf8")) as Record<string,Array<{at:number;price:number;regions:Array<{p:number;lo:number;hi:number;i:number;pc:number;rk:number}>}>>;
const cvd5m=JSON.parse(readFileSync(`${DIR}/cvd5m.json`,"utf8")) as Record<string,Array<[number,number]>>;
const codemap=readFileSync(`${DIR}/codemap.txt`,"utf8").split("\n").filter(Boolean).map((l)=>l.split("|"));
const base=new Map<string,Array<[number,number]>>();
for(const line of readFileSync(`${DIR}/baselines.csv`,"utf8").split("\n")){
  if(!line)continue;const [code,metric,ts,value]=line.split(",");
  const key=`${code}:${metric}`;const arr=base.get(key)??[];arr.push([Number(ts)*1000,Number(value)]);base.set(key,arr);
}
for(const arr of base.values())arr.sort((a,b)=>a[0]-b[0]);

const settings=resolveRestingEntry(null);
const NOTIONAL=500,SLIP=0.0005,TRIG=0.5,FRAC=0.5,BE=0.05;
const M15=900_000,HOUR=3600_000,FILL_W=6*HOUR,TRADE_W=24*HOUR;
// Production asks for 2880 samples (30 days at 15m). Our OI and funding history
// is 35 days, so demanding it outright would replay five days, not thirty. The
// baseline grows to 2880 and is floored at 672 (7 days) — applied identically to
// every variant, so it cannot favour one vote over another.
const FULL=2880,FLOOR=672;
const toCandles=(b:Bar[]):Candle[]=>b.map((x)=>({openTime:x[0],open:x[1],high:x[2],low:x[3],close:x[4],volume:0}));
const upto=(a:Array<[number,number]>,t:number)=>{let lo=0,hi=a.length-1,r=-1;while(lo<=hi){const m=(lo+hi)>>1;if(a[m]![0]<=t){r=m;lo=m+1;}else hi=m-1;}return r;};
function regionsAt(code:string,t:number):HeatmapRegion[]{
  const s=hm[code];if(!s?.length)return [];
  let lo=0,hi=s.length-1,r=-1;while(lo<=hi){const m=(lo+hi)>>1;if(s[m]!.at<=t){r=m;lo=m+1;}else hi=m-1;}
  return r<0?[]:s[r]!.regions.map((g)=>({price:g.p,lowPrice:g.lo,highPrice:g.hi,intensity:g.i,percentile:g.pc,rank:g.rk}));
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

type Variant={label:string;clock:"15m"|"1h";vote:(bins:number[])=>-1|0|1};
const variants:Variant[]=[
  {label:"旧回测 3/3(假桶)",clock:"15m",vote:(b)=>{const s=b.reduce((x,y)=>x+y,0);return confirmedDirection([s/3,s/3,s/3],3,3);}},
  {label:"真实 3/3(实盘规则)",clock:"15m",vote:(b)=>confirmedDirection(b,3,3)},
  {label:"真实 2/3",clock:"15m",vote:(b)=>confirmedDirection(b,2,3)},
  {label:"1 小时 3/4",clock:"1h",vote:(b)=>confirmedDirection(b,3,4)},
  {label:"1 小时 4/4",clock:"1h",vote:(b)=>confirmedDirection(b,4,4)},
];
const stats=variants.map(()=>({armed:0,plans:0,fills:[] as Array<{pnl:number;out:string}>}));

for(const [code,sym] of codemap){
  const h1=kl[`${sym}:h1`],m15=kl[`${sym}:m15`],raw5=cvd5m[code!];
  if(!h1?.length||!m15?.length||!raw5?.length)continue;
  const h1c=toCandles(h1);
  const oi=base.get(`${code}:OI_RAW`),fund=base.get(`${code}:FUNDING_RAW`);
  if(!oi||!fund)continue;
  // Real 5m deltas regrouped into the 15m windows the collector scans on.
  const q=new Map<number,number[]>();
  for(const [ts,delta] of raw5){const b=Math.floor(ts/M15)*M15;const a=q.get(b)??[];a.push(delta);q.set(b,a);}
  const q15=[...q.entries()].filter(([,b])=>b.length===3).sort((a,b)=>a[0]-b[0]);
  const totals15=q15.map(([,b])=>b.reduce((x,y)=>x+y,0));
  const hourIndex=new Map<number,number[]>();
  q15.forEach(([start],i)=>{const h=Math.floor(start/HOUR)*HOUR;const a=hourIndex.get(h)??[];a.push(i);hourIndex.set(h,a);});

  for(let n=FLOOR;n<q15.length;n+=1){
    const [start,bins5]=q15[n]!;
    const t=start+M15;                                    // the scan fires at the close
    const io=upto(oi,t),ifd=upto(fund,t);
    if(io<FLOOR+8||ifd<FLOOR+17)continue;
    const o=oiAnomaly({values:oi.slice(Math.max(0,io-FULL-8),io+1).map((x)=>x[1]),baselineSamples:Math.min(FULL,io-8)});
    const f=fundingAnomaly({values:fund.slice(Math.max(0,ifd-FULL-17),ifd+1).map((x)=>x[1]),baselineSamples:Math.min(FULL,ifd-17)});
    if(!o.passed||!f.passed)continue;
    const hourBins=(hourIndex.get(Math.floor(start/HOUR)*HOUR)??[]).map((i)=>totals15[i]!);
    const hourReady=hourBins.length===4&&q15[n]![0]%HOUR===45*60_000;   // decide at the hour's close
    const hist15=totals15.slice(Math.max(0,n-FULL),n);
    const c15=cvdAnomaly({currentBins:bins5,history:hist15,baselineSamples:Math.min(FULL,hist15.length)});
    let zHour=0;
    if(hourReady){
      const hourly:number[]=[];
      for(let i=3;i<n;i+=4)hourly.push(totals15[i-3]!+totals15[i-2]!+totals15[i-1]!+totals15[i]!);
      const h=hourly.slice(-FULL);
      zHour=h.length>=FLOOR/4?robustZScore(hourBins.reduce((x,y)=>x+y,0),h):0;
    }

    let shared:{price:number;atrV:number;emaV:number|null;window:Candle[];regions:HeatmapRegion[];iM:number}|null=null;
    for(let v=0;v<variants.length;v+=1){
      const variant=variants[v]!;
      if(variant.clock==="1h"){if(!hourReady||!(Math.abs(zHour)>=1))continue;}
      else if(!c15.ready||!(Math.abs(c15.zScore)>=1))continue;
      const vote=variant.vote(variant.clock==="1h"?hourBins:bins5);
      if(vote===0)continue;
      const dir:Direction=vote>0?"LONG":"SHORT";
      stats[v]!.armed+=1;
      if(!shared){
        const hIdx=h1.findIndex((b)=>b[0]>t-HOUR)-1;
        if(hIdx<30)break;
        const window=h1c.slice(Math.max(0,hIdx-99),hIdx+1);
        const atrV=atr(window,14).at(-1);
        if(!atrV||!(atrV>0))break;
        const iM=m15.findIndex((b)=>b[0]>=t)-1;
        if(iM<1)break;
        shared={price:m15[iM]![4],atrV,emaV:ema(window.map((c)=>c.close),20).at(-1)??null,window,regions:regionsAt(code!,t),iM};
      }
      let swing:number|null=null;try{swing=findAtrSwing(shared.window,shared.atrV,dir);}catch{swing=null;}
      const cand=chooseEntryLevel({direction:dir,price:shared.price,atr1h:shared.atrV,ema:shared.emaV,swing,regions:shared.regions},settings);
      if(!cand)continue;
      let plan;
      try{plan=makeRestingOrderPlan({symbol:sym!,direction:dir,closedAt:new Date(t).toISOString(),candidate:cand,price:shared.price,atr1h:shared.atrV,regions:shared.regions,marginUsdc:100,leverage:5},settings);}catch{continue;}
      stats[v]!.plans+=1;
      for(let j=shared.iM+1;j<m15.length;j+=1){
        if(m15[j]![0]>t+FILL_W)break;
        if(m15[j]![3]<=plan.entryPrice&&plan.entryPrice<=m15[j]![2]){
          const r=walk(m15,j,dir,plan.entryPrice,plan.stopLoss,plan.takeProfit);
          if(r)stats[v]!.fills.push(r);
          break;
        }
      }
    }
  }
}

const se=(v:number[])=>{const m=v.reduce((a,b)=>a+b,0)/v.length;const sd=Math.sqrt(v.reduce((a,b)=>a+(b-m)**2,0)/(v.length-1));const e=sd/Math.sqrt(v.length);return `${m.toFixed(2)}±${e.toFixed(2)} (t=${(m/e).toFixed(2)})`;};
console.log("46 个币 / 30 天 / 同一窗口同一基线，只换 CVD 投票规则\n");
console.log(`${"变体".padEnd(20)}${"武装".padStart(8)}${"挂单".padStart(8)}${"成交".padStart(7)}${"止盈".padStart(6)}${"保本".padStart(6)}${"止损".padStart(6)}${"总额".padStart(11)}${"均值".padStart(9)}${"胜率".padStart(7)}${"均值±标准误 (t)".padStart(14)}`);
variants.forEach((variant,v)=>{
  const s=stats[v]!,r=s.fills;
  const pad=variant.label+" ".repeat(Math.max(0,20-[...variant.label].reduce((w,ch)=>w+(ch.charCodeAt(0)>127?2:1),0)));
  if(!r.length){console.log(`${pad}${String(s.armed).padStart(8)}${String(s.plans).padStart(8)}${"0".padStart(7)}`);return;}
  const sum=r.reduce((a,b)=>a+b.pnl,0);
  console.log(`${pad}${String(s.armed).padStart(8)}${String(s.plans).padStart(8)}${String(r.length).padStart(7)}`+
    `${String(r.filter((x)=>x.out==="TP").length).padStart(6)}${String(r.filter((x)=>x.out==="BE").length).padStart(6)}${String(r.filter((x)=>x.out==="SL").length).padStart(6)}`+
    `${sum.toFixed(2).padStart(11)}${(sum/r.length).toFixed(3).padStart(9)}${(100*r.filter((x)=>x.pnl>0).length/r.length).toFixed(0).padStart(6)}%`+
    `${se(r.map((x)=>x.pnl)).padStart(16)}`);
});
process.exit(0);
