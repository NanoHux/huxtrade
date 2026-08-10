/**
 * Thirty-day replay of the three entry policies.
 *
 * Uses the production decision functions rather than a re-implementation: the
 * point is to measure the strategy that runs, and an approximation would be
 * measuring something else. Heatmap regions come from a 30d capture that keeps
 * its time axis, so each decision sees the map as it was at that moment.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { atr, cvdAnomaly, ema, findAtrSwing, fundingAnomaly, oiAnomaly, type Candle } from "@huxtrade/indicators";
import { chooseEntryLevel, makeRestingOrderPlan, resolveRestingEntry } from "@huxtrade/strategy-engine";
import type { Direction, HeatmapRegion } from "@huxtrade/shared-types";

const DIR="/private/tmp/claude-501/-Users-hux-Desktop-huxtrade/499bb97e-f722-4740-975b-f921f3a83a72/scratchpad";
type Bar=[number,number,number,number,number];
const kl=JSON.parse(readFileSync(`${DIR}/klines30d.json`,"utf8")) as Record<string,Bar[]>;
const hm=JSON.parse(readFileSync(`${DIR}/heatmap30d.json`,"utf8")) as Record<string,Array<{at:number;price:number;regions:Array<{p:number;lo:number;hi:number;i:number;pc:number;rk:number}>}>>;
const codemap=readFileSync(`${DIR}/codemap.txt`,"utf8").split("\n").filter(Boolean).map((l)=>l.split("|"));

// baselines: code|metric|epoch|value
const base=new Map<string,Array<[number,number]>>();
for(const line of readFileSync(`${DIR}/baselines.csv`,"utf8").split("\n")){
  if(!line) continue;
  const [code,metric,ts,value]=line.split(",");
  const key=`${code}:${metric}`;
  const arr=base.get(key)??[];arr.push([Number(ts)*1000,Number(value)]);base.set(key,arr);
}
for(const arr of base.values())arr.sort((a,b)=>a[0]-b[0]);

const settings=resolveRestingEntry(null);
const NOTIONAL=500,SLIP=0.0005,TRIG=0.5,FRAC=0.5,BE=0.05;
const HOUR=3600_000,Q=900_000,FILL_W=6*HOUR,TRADE_W=24*HOUR;

const toCandles=(bars:Bar[]):Candle[]=>bars.map((b)=>({openTime:b[0],open:b[1],high:b[2],low:b[3],close:b[4],volume:0}));
const upto=(arr:Array<[number,number]>,t:number)=>{let hi=arr.length-1,lo=0,ans=-1;while(lo<=hi){const m=(lo+hi)>>1;if(arr[m]![0]<=t){ans=m;lo=m+1;}else hi=m-1;}return ans;};

function regionsAt(code:string,t:number):HeatmapRegion[]{
  const slices=hm[code];if(!slices?.length)return [];
  let lo=0,hi=slices.length-1,ans=-1;
  while(lo<=hi){const m=(lo+hi)>>1;if(slices[m]!.at<=t){ans=m;lo=m+1;}else hi=m-1;}
  if(ans<0)return [];
  return slices[ans]!.regions.map((r)=>({price:r.p,lowPrice:r.lo,highPrice:r.hi,intensity:r.i,percentile:r.pc,rank:r.rk}));
}

function conditionsAt(code:string,t:number){
  const oi=base.get(`${code}:OI_RAW`),cvd=base.get(`${code}:CVD_15M`),fund=base.get(`${code}:FUNDING_RAW`);
  if(!oi||!cvd||!fund)return null;
  const io=upto(oi,t),ic=upto(cvd,t),ifd=upto(fund,t);
  if(io<200||ic<200||ifd<200)return null;
  const N=2880;
  const oiR=oiAnomaly({values:oi.slice(Math.max(0,io-N-8),io+1).map((x)=>x[1]),baselineSamples:Math.min(N,io-8)});
  const cvdVals=cvd.slice(Math.max(0,ic-N),ic+1).map((x)=>x[1]);
  const cvdR=cvdAnomaly({currentBins:[cvdVals.at(-1)!/3,cvdVals.at(-1)!/3,cvdVals.at(-1)!/3],history:cvdVals.slice(0,-1),baselineSamples:Math.min(N,ic-1)});
  const fR=fundingAnomaly({values:fund.slice(Math.max(0,ifd-N-17),ifd+1).map((x)=>x[1]),baselineSamples:Math.min(N,ifd-17)});
  if(!oiR.ready||!cvdR.ready||!fR.ready)return null;
  if(!(oiR.passed&&cvdR.passed&&fR.passed))return null;
  return cvdR.direction>0?"LONG" as Direction:cvdR.direction<0?"SHORT" as Direction:null;
}

type Trade={pnl:number;out:string};
function walk(bars:Bar[],start:number,d:Direction,entry:number,sl:number,tp:number):Trade|null{
  const R=Math.abs(entry-sl);if(!(R>0))return null;
  const trig=d==="LONG"?entry+TRIG*R:entry-TRIG*R,be=d==="LONG"?entry+BE*R:entry-BE*R;
  let scaled=false,banked=0,qty=1,stop=sl;
  for(let j=start;j<bars.length;j+=1){
    if(bars[j]![0]>bars[start]![0]+TRADE_W)break;
    const hi=bars[j]![2],lo=bars[j]![3];
    if(d==="LONG"?lo<=stop:hi>=stop)
      return {pnl:banked+NOTIONAL*qty*((stop-entry)/entry*(d==="LONG"?1:-1)),out:scaled?"BE":"SL"};
    if(d==="LONG"?hi>=tp:lo<=tp)
      return {pnl:banked+NOTIONAL*qty*((tp-entry)/entry*(d==="LONG"?1:-1)),out:"TP"};
    if(!scaled&&(d==="LONG"?hi>=trig:lo<=trig)){
      banked+=NOTIONAL*FRAC*((trig-entry)/entry*(d==="LONG"?1:-1)-SLIP);
      qty=1-FRAC;scaled=true;stop=be;
    }
  }
  return null;
}
const proportional=(d:Direction,entry:number,lvl:number,sl:number,tp:number)=>{
  const sp=Math.abs(lvl-sl)/lvl,tpp=Math.abs(lvl-tp)/lvl;
  return d==="LONG"?[entry*(1-sp),entry*(1+tpp)] as const:[entry*(1+sp),entry*(1-tpp)] as const;
};

const results:Record<string,Trade[]>={A:[],B:[],C:[]};
const dumped:Array<Record<string,unknown>>=[];
let plans=0;
for(const [code,sym] of codemap){
  const h1=kl[`${sym}:h1`],m15=kl[`${sym}:m15`];
  if(!h1?.length||!m15?.length)continue;
  const h1c=toCandles(h1);
  for(let i=100;i<m15.length-1;i+=1){
    const t=m15[i]![0]+Q;                       // decision at bar close
    const dir=conditionsAt(code,t);
    if(!dir)continue;
    const hIdx=h1.findIndex((b)=>b[0]>t-HOUR)-1;
    if(hIdx<30)continue;
    const window=h1c.slice(Math.max(0,hIdx-99),hIdx+1);
    const atrV=atr(window,14).at(-1);
    if(!atrV||!(atrV>0))continue;
    let swing:number|null=null;
    try{swing=findAtrSwing(window,atrV,dir);}catch{swing=null;}
    const emaV=ema(window.map((c)=>c.close),20).at(-1)??null;
    const price=m15[i]![4];
    const regions=regionsAt(code,t);
    const cand=chooseEntryLevel({direction:dir,price,atr1h:atrV,ema:emaV,swing,regions},settings);
    if(!cand)continue;
    let plan;
    try{plan=makeRestingOrderPlan({symbol:sym,direction:dir,closedAt:new Date(t).toISOString(),candidate:cand,price,atr1h:atrV,regions,marginUsdc:100,leverage:5},settings);}
    catch{continue;}
    plans+=1;
    const lvl=plan.entryPrice,sl=plan.stopLoss,tp=plan.takeProfit;
    // Everything a rule sweep needs, so the expensive reconstruction runs once.
    const anchors=[cand.region?(dir==="LONG"?cand.region.lowPrice:cand.region.highPrice):undefined,cand.swing]
      .filter((v):v is number=>typeof v==="number"&&Number.isFinite(v));
    dumped.push({sym,dir,t,i,level:lvl,stop:sl,target:tp,atr:atrV,
      anchor:anchors.length?(dir==="LONG"?Math.min(...anchors):Math.max(...anchors)):null,
      peak:plan.heatmapTarget?.price??null,sources:cand.sources});
    // A: market at plan time
    const iA=m15[i+1]?[...Array(1)].map(()=>i+1)[0]:null;
    const barsA=m15;
    if(iA!==null){
      const e=barsA[iA]![1]*(dir==="LONG"?1+SLIP:1-SLIP);
      const [s2,t2]=proportional(dir,e,lvl,sl,tp);
      const r=walk(barsA,iA,dir,e,s2,t2);if(r)results.A.push(r);
    }
    // touch + two 5m closes approximated on 15m bars: use the touching bar and the next
    let touch=-1;
    for(let j=i+1;j<m15.length;j+=1){
      if(m15[j]![0]>t+FILL_W)break;
      if(m15[j]![3]<=lvl&&lvl<=m15[j]![2]){touch=j;break;}
    }
    if(touch<0||touch+1>=m15.length)continue;
    const against=(b:Bar)=>dir==="LONG"?b[4]<b[1]:b[4]>b[1];
    if(against(m15[touch]!)&&against(m15[touch+1]!))continue;
    const k=touch+2;
    if(k>=m15.length)continue;
    const eB=m15[k]![1]*(dir==="LONG"?1+SLIP:1-SLIP);
    const [sB,tB]=proportional(dir,eB,lvl,sl,tp);
    const rB=walk(m15,k,dir,eB,sB,tB);if(rB)results.B.push(rB);
    for(let j=k;j<m15.length;j+=1){
      if(m15[j]![0]>m15[k]![0]+TRADE_W)break;
      if(m15[j]![3]<=lvl&&lvl<=m15[j]![2]){const rC=walk(m15,j,dir,lvl,sl,tp);if(rC)results.C.push(rC);break;}
    }
  }
}
writeFileSync(`${DIR}/plans30d.json`,JSON.stringify(dumped));
console.log(`重建计划 ${plans} 条，已落盘 ${dumped.length}\n`);
console.log(`${"策略".padEnd(22)}${"成交".padStart(6)}${"止盈".padStart(6)}${"保本".padStart(6)}${"止损".padStart(6)}${"总额".padStart(11)}${"均值".padStart(9)}${"胜率".padStart(7)}`);
for(const [k,label] of [["A","A 计划生成即市价"],["B","B 确认后市价"],["C","C 现行:确认后限价"]] as const){
  const r=results[k]!;if(!r.length){console.log(label,"无成交");continue;}
  const pnl=r.map((x)=>x.pnl),sum=pnl.reduce((a,b)=>a+b,0);
  console.log(`${label.padEnd(20)}${String(r.length).padStart(6)}${String(r.filter((x)=>x.out==="TP").length).padStart(6)}`+
    `${String(r.filter((x)=>x.out==="BE").length).padStart(6)}${String(r.filter((x)=>x.out==="SL").length).padStart(6)}`+
    `${sum.toFixed(2).padStart(11)}${(sum/r.length).toFixed(3).padStart(9)}${(100*pnl.filter((x)=>x>0).length/r.length).toFixed(0).padStart(6)}%`);
}
process.exit(0);
