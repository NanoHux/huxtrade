/**
 * The strategy as it actually runs, replayed over 30 days.
 *
 * Not a variant sweep — one configuration, the live TwoSignal settings, with
 * the parts earlier replays skipped: real 5m CVD bins, one slot per
 * symbol+direction, the five-orders-per-side cap, virtual entry confirmation
 * on 5m closes, replace hysteresis, the flip cancel, the 24h extreme-move
 * veto and the account-wide losing-streak breaker. Assets share one clock so
 * the account-wide rules see the account.
 */
import { readFileSync } from "node:fs";
import { atr, cvdAnomaly, ema, findAtrSwing, fundingAnomaly, oiAnomaly, type Candle } from "@huxtrade/indicators";
import { breakevenStopPrice, chooseEntryLevel, confirmVirtualEntry, directionAllowedAfterMove, haltedDirections, makeRestingOrderPlan, resolveRestingEntry, scaleOutDecision } from "@huxtrade/strategy-engine";
import type { Direction, HeatmapRegion } from "@huxtrade/shared-types";

const DIR="/private/tmp/claude-501/-Users-hux-Desktop-huxtrade/499bb97e-f722-4740-975b-f921f3a83a72/scratchpad";
type Bar5=[number,number,number,number,number,number];
type Bar=[number,number,number,number,number];
const ohlc=JSON.parse(readFileSync(`${DIR}/ohlc5m.json`,"utf8")) as Record<string,Bar5[]>;
const kl=JSON.parse(readFileSync(`${DIR}/klines30d.json`,"utf8")) as Record<string,Bar[]>;
const hm=JSON.parse(readFileSync(`${DIR}/heatmap30d.json`,"utf8")) as Record<string,Array<{at:number;price:number;regions:Array<{p:number;lo:number;hi:number;i:number;pc:number;rk:number}>}>>;
const codemap=readFileSync(`${DIR}/codemap.txt`,"utf8").split("\n").filter(Boolean).map((l)=>l.split("|") as [string,string]);
const base=new Map<string,Array<[number,number]>>();
for(const line of readFileSync(`${DIR}/baselines.csv`,"utf8").split("\n")){
  if(!line)continue;const [code,metric,ts,value]=line.split(",");
  const key=`${code}:${metric}`;const arr=base.get(key)??[];arr.push([Number(ts)*1000,Number(value)]);base.set(key,arr);
}
for(const arr of base.values())arr.sort((a,b)=>a[0]-b[0]);

// Live TwoSignal overrides on top of fixedRules.
const settings=resolveRestingEntry({emaScore:0.31,swingScore:0.56,entryOffsetAtr:0.1,maxArmedAssets:50,entryBandAtrMax:2.5,entryBandAtrMin:0.3,confluenceMergeAtr:0.35,incumbentScoreBonus:0.5,replaceThresholdAtr:0.8,biasPersistenceScans:8,flipConfirmationScans:1});
const MAX_PER_SIDE=5,MARGIN=100,LEV=5,NOTIONAL=MARGIN*LEV,SLIP=0.0005;
const M5=300_000,M15=900_000,HOUR=3_600_000;
const FULL=2880,FLOOR=672;
const LIFETIME=settings.biasPersistenceScans*M15;

type Asset={code:string;sym:string;bars5:Bar5[];idx5:Map<number,number>;h1:Bar[];h1c:Candle[];q15:Array<[number,number[]]>;t15:number[];pos15:Map<number,number>;oi:Array<[number,number]>;fund:Array<[number,number]>};
const assets:Asset[]=[];
for(const [code,sym] of codemap){
  const bars5=ohlc[code],h1=kl[`${sym}:h1`],oi=base.get(`${code}:OI_RAW`),fund=base.get(`${code}:FUNDING_RAW`);
  if(!bars5?.length||!h1?.length||!oi||!fund)continue;
  const q=new Map<number,number[]>();
  for(const b of bars5){const k=Math.floor(b[0]/M15)*M15;const a=q.get(k)??[];a.push(b[5]);q.set(k,a);}
  const q15=[...q.entries()].filter(([,b])=>b.length===3).sort((a,b)=>a[0]-b[0]);
  const pos15=new Map<number,number>();q15.forEach(([k],i)=>pos15.set(k,i));
  const idx5=new Map<number,number>();bars5.forEach((b,i)=>idx5.set(b[0],i));
  assets.push({code,sym,bars5,idx5,h1,h1c:h1.map((x)=>({openTime:x[0],open:x[1],high:x[2],low:x[3],close:x[4],volume:0})),q15,t15:q15.map(([k])=>k),pos15,oi,fund});
}
const upto=(a:Array<[number,number]>,t:number)=>{let lo=0,hi=a.length-1,r=-1;while(lo<=hi){const m=(lo+hi)>>1;if(a[m]![0]<=t){r=m;lo=m+1;}else hi=m-1;}return r;};
function regionsAt(code:string,t:number):HeatmapRegion[]{
  const s=hm[code];if(!s?.length)return [];
  let lo=0,hi=s.length-1,r=-1;while(lo<=hi){const m=(lo+hi)>>1;if(s[m]!.at<=t){r=m;lo=m+1;}else hi=m-1;}
  return r<0?[]:s[r]!.regions.map((g)=>({price:g.p,lowPrice:g.lo,highPrice:g.hi,intensity:g.i,percentile:g.pc,rank:g.rk}));
}

type Pending={level:number;stop:number;tp:number;atr:number;refreshedAt:number;touchedAt:number|null;widened:boolean};
type Open={dir:Direction;entry:number;stop:number;tp:number;risk:number;openedAt:number;scaled:boolean;banked:number;bankedR:number;qty:number;widened:boolean};
type Trade={code:string;dir:Direction;openedAt:number;closedAt:number;pnl:number;r:number;out:string;entry:number;stopPct:number;widened:boolean};
const pending=new Map<string,Pending>(),open=new Map<string,Open>();
// Trades the spread gate would have refused outright, had the floor not saved them.
const widened=new Set<string>();
const losses:Array<{direction:Direction;closedAt:string}>=[];
const trades:Trade[]=[];
let armed=0,placed=0,replaced=0,expired=0,flipped=0,abandoned=0,blockedSlot=0,blockedHalt=0,blockedMove=0;

const start=Math.max(...assets.map((a)=>a.bars5[0]![0])),end=Math.min(...assets.map((a)=>a.bars5.at(-1)![0]));
for(let t=start;t<=end;t+=M5){
  const nowIso=new Date(t).toISOString();
  const halts=new Set(haltedDirections(losses,nowIso,settings).map((h)=>h.direction));

  // --- execution: positions first, then resting orders, on this 5m bar ---
  for(const asset of assets){
    const i=asset.idx5.get(t);if(i===undefined)continue;
    const bar=asset.bars5[i]!,hi=bar[2],lo=bar[3];
    for(const dir of ["LONG","SHORT"] as const){
      const key=`${asset.code}:${dir}`,p=open.get(key);
      if(!p)continue;
      const R=p.risk,sign=dir==="LONG"?1:-1;
      const close=(exit:number,out:string)=>{
        const pnl=p.banked+NOTIONAL*p.qty*((exit-p.entry)/p.entry*sign-SLIP);
        trades.push({code:asset.code,dir,openedAt:p.openedAt,closedAt:t,pnl,r:p.bankedR+p.qty*sign*(exit-p.entry)/p.risk,out,entry:p.entry,stopPct:100*p.risk/p.entry,widened:p.widened});
        if(pnl<0)losses.push({direction:dir,closedAt:nowIso});
        open.delete(key);
      };
      if(dir==="LONG"?lo<=p.stop:hi>=p.stop){close(p.stop,p.scaled?"BE":"SL");continue;}
      if(dir==="LONG"?hi>=p.tp:lo<=p.tp){close(p.tp,"TP");continue;}
      if(!p.scaled){
        const mark=dir==="LONG"?hi:lo;
        if(scaleOutDecision({direction:dir,entryPrice:p.entry,stopLoss:p.stop,markPrice:mark,alreadyScaledOut:false},settings).action==="SCALE_OUT"){
          const trigger=dir==="LONG"?p.entry+settings.scaleOutTriggerR*R:p.entry-settings.scaleOutTriggerR*R;
          p.banked+=NOTIONAL*settings.scaleOutFraction*((trigger-p.entry)/p.entry*sign-SLIP);
          p.bankedR+=settings.scaleOutFraction*settings.scaleOutTriggerR;p.qty=1-settings.scaleOutFraction;p.scaled=true;
          p.stop=breakevenStopPrice(dir,p.entry,p.stop,settings);
        }
      }
    }
    for(const dir of ["LONG","SHORT"] as const){
      const key=`${asset.code}:${dir}`,order=pending.get(key);
      if(!order)continue;
      if(t-order.refreshedAt>LIFETIME){pending.delete(key);expired+=1;continue;}
      if(open.has(key))continue;
      const window=asset.bars5.slice(Math.max(0,i-11),i+1).map((b)=>({openTime:b[0],open:b[1],high:b[2],low:b[3],close:b[4]}));
      const verdict=confirmVirtualEntry({direction:dir,level:order.level,candles:window,touchedAt:order.touchedAt,nowMs:t+M5,intervalMs:M5});
      if(verdict.touchedAt!==undefined)order.touchedAt=verdict.touchedAt;
      if(verdict.action==="ABANDON"){pending.delete(key);abandoned+=1;continue;}
      if(verdict.action!=="SUBMIT")continue;
      if(lo<=order.level&&order.level<=hi){
        open.set(key,{dir,entry:order.level,stop:order.stop,tp:order.tp,risk:Math.abs(order.level-order.stop),openedAt:t,scaled:false,banked:0,bankedR:0,qty:1,widened:order.widened});
        pending.delete(key);placed+=1;
      }
    }
  }

  // --- decisions: only at a 15m close ---
  if(t%M15!==0)continue;
  for(const asset of assets){
    const n=asset.pos15.get(t-M15);
    if(n===undefined||n<FLOOR)continue;
    const bins=asset.q15[n]![1];
    // The unanimous vote costs three sign tests and abstains on most bars;
    // running it before the z-scores changes nothing and skips the sorting.
    if(!(bins[0]!>0&&bins[1]!>0&&bins[2]!>0)&&!(bins[0]!<0&&bins[1]!<0&&bins[2]!<0))continue;
    const io=upto(asset.oi,t),ifd=upto(asset.fund,t);
    if(io<FLOOR+8||ifd<FLOOR+17)continue;
    const hist=asset.q15.slice(Math.max(0,n-FULL),n).map(([,b])=>b.reduce((x,y)=>x+y,0));
    const c=cvdAnomaly({currentBins:bins,history:hist,baselineSamples:Math.min(FULL,hist.length)});
    if(!c.passed)continue;
    const o=oiAnomaly({values:asset.oi.slice(Math.max(0,io-FULL-8),io+1).map((x)=>x[1]),baselineSamples:Math.min(FULL,io-8)});
    if(!o.passed)continue;
    const f=fundingAnomaly({values:asset.fund.slice(Math.max(0,ifd-FULL-17),ifd+1).map((x)=>x[1]),baselineSamples:Math.min(FULL,ifd-17)});
    if(!f.passed)continue;
    const dir:Direction=c.direction>0?"LONG":"SHORT",key=`${asset.code}:${dir}`;

    if(halts.has(dir)){blockedHalt+=1;continue;}
    const i5=asset.idx5.get(t);if(i5===undefined||i5<288)continue;
    const price=asset.bars5[i5-1]![4];
    const change24h=100*(price-asset.bars5[i5-288]![4])/asset.bars5[i5-288]![4];
    if(!directionAllowedAfterMove(change24h,dir,settings)){blockedMove+=1;continue;}
    if(open.has(key))continue;

    const hIdx=asset.h1.findIndex((b)=>b[0]>t-HOUR)-1;if(hIdx<30)continue;
    const win=asset.h1c.slice(Math.max(0,hIdx-99),hIdx+1);
    const atrV=atr(win,14).at(-1);if(!atrV||!(atrV>0))continue;
    let swing:number|null=null;try{swing=findAtrSwing(win,atrV,dir);}catch{swing=null;}
    const cand=chooseEntryLevel({direction:dir,price,atr1h:atrV,ema:ema(win.map((x)=>x.close),20).at(-1)??null,swing,regions:regionsAt(asset.code,t)},settings);
    if(!cand)continue;
    let plan:ReturnType<typeof makeRestingOrderPlan>;
    try{plan=makeRestingOrderPlan({symbol:asset.sym,direction:dir,closedAt:new Date(t).toISOString(),candidate:cand,price,atr1h:atrV,regions:regionsAt(asset.code,t),marginUsdc:MARGIN,leverage:LEV},settings);}catch{continue;}
    armed+=1;

    // Stop floor under test: a structural stop narrower than this is widened
    // to it, and the 2R target follows the new risk. Historical spreads are not
    // stored, so this cannot show the benefit — the JUP-type orders that would
    // stop being refused — only what widening costs the trades already taken.
    const floorPct=Number(process.env.MIN_STOP??0);
    if(floorPct>0){
      const risk=Math.abs(plan.entryPrice-plan.stopLoss),floor=plan.entryPrice*floorPct/100;
      if(risk<floor){widened.add(plan.idempotencyKey);plan={...plan,
        stopLoss:dir==="LONG"?plan.entryPrice-floor:plan.entryPrice+floor,
        takeProfit:dir==="LONG"?plan.entryPrice+2*floor:plan.entryPrice-2*floor};}
    }
    const opposite=`${asset.code}:${dir==="LONG"?"SHORT":"LONG"}`;
    if(pending.has(opposite)){pending.delete(opposite);flipped+=1;}
    const incumbent=pending.get(key);
    if(incumbent){
      // Hysteresis: refresh the clock, but only move the order when the level
      // has travelled further than replaceThresholdAtr.
      incumbent.refreshedAt=t;
      if(Math.abs(plan.entryPrice-incumbent.level)>settings.replaceThresholdAtr*atrV){
        pending.set(key,{level:plan.entryPrice,stop:plan.stopLoss,tp:plan.takeProfit,atr:atrV,refreshedAt:t,touchedAt:null,widened:widened.has(plan.idempotencyKey)});
        replaced+=1;
      }
      continue;
    }
    let live=0;
    for(const k of pending.keys())if(k.endsWith(`:${dir}`))live+=1;
    for(const k of open.keys())if(k.endsWith(`:${dir}`))live+=1;
    if(live>=MAX_PER_SIDE){blockedSlot+=1;continue;}
    pending.set(key,{level:plan.entryPrice,stop:plan.stopLoss,tp:plan.takeProfit,atr:atrV,refreshedAt:t,touchedAt:null,widened:widened.has(plan.idempotencyKey)});
  }
}

const days=(end-start)/86_400_000;
const pnl=trades.map((x)=>x.pnl),sum=pnl.reduce((a,b)=>a+b,0);
const mean=sum/trades.length,sd=Math.sqrt(pnl.reduce((a,b)=>a+(b-mean)**2,0)/(trades.length-1)),se=sd/Math.sqrt(trades.length);
const rs=trades.map((x)=>x.r),meanR=rs.reduce((a,b)=>a+b,0)/rs.length;
let equity=0,peak=0,dd=0;const curve=[...trades].sort((a,b)=>a.closedAt-b.closedAt);
for(const trade of curve){equity+=trade.pnl;peak=Math.max(peak,equity);dd=Math.min(dd,equity-peak);}
const count=(out:string)=>trades.filter((x)=>x.out===out).length;

console.log(`实盘配置 TwoSignal / 46 币 / ${days.toFixed(1)} 天 / 每单保证金 ${MARGIN} × ${LEV}x = ${NOTIONAL} 名义\n`);
console.log("信号漏斗");
console.log(`  通过四因子 + CVD 全票        ${armed}`);
console.log(`  熔断拦截 ${blockedHalt}   极端行情拦截 ${blockedMove}   满槽拦截 ${blockedSlot}`);
console.log(`  换单 ${replaced}   反向撤单 ${flipped}   超时过期 ${expired}   两根 5m 反向放弃 ${abandoned}`);
console.log(`  实际成交                     ${placed}\n`);
console.log("成交结果");
console.log(`  笔数 ${trades.length}   止盈 ${count("TP")}   保本 ${count("BE")}   止损 ${count("SL")}   未平仓 ${open.size}`);
console.log(`  总盈亏 ${sum.toFixed(2)} USDC   均值 ${mean.toFixed(3)} ± ${se.toFixed(3)}  (t=${(mean/se).toFixed(2)})`);
console.log(`  胜率 ${(100*pnl.filter((x)=>x>0).length/trades.length).toFixed(1)}%   均值 R ${meanR.toFixed(3)}   最大回撤 ${dd.toFixed(2)} USDC`);
console.log(`  最好 ${Math.max(...pnl).toFixed(2)}   最差 ${Math.min(...pnl).toFixed(2)}   每天约 ${(trades.length/days).toFixed(1)} 笔\n`);
for(const dir of ["LONG","SHORT"] as const){
  const t2=trades.filter((x)=>x.dir===dir);if(!t2.length)continue;
  const s=t2.reduce((a,b)=>a+b.pnl,0);
  console.log(`  ${dir.padEnd(6)} ${String(t2.length).padStart(4)} 笔   ${s.toFixed(2).padStart(10)}   均值 ${(s/t2.length).toFixed(3).padStart(7)}   胜率 ${(100*t2.filter((x)=>x.pnl>0).length/t2.length).toFixed(0)}%`);
}
const byCode=new Map<string,number[]>();
for(const trade of trades){const a=byCode.get(trade.code)??[];a.push(trade.pnl);byCode.set(trade.code,a);}
const ranked=[...byCode].map(([code,v])=>[code,v.reduce((a,b)=>a+b,0),v.length] as const).sort((a,b)=>b[1]-a[1]);
console.log(`\n最好 5 个 / 最差 5 个（共 ${ranked.length} 个币有成交）`);
for(const [code,s,n] of ranked.slice(0,5))console.log(`  +${code.padEnd(8)} ${s.toFixed(2).padStart(9)}  ${n} 笔`);
for(const [code,s,n] of ranked.slice(-5))console.log(`  -${code.padEnd(8)} ${s.toFixed(2).padStart(9)}  ${n} 笔`);
// Same trades, same exits — only the size changes, so every trade risks one
// unit. This separates whether the rules pick well from whether the sizing
// lets the picks survive.
const UNIT=10;
const normalised=trades.reduce((a,b)=>a+b.r*UNIT,0);
const nMean=normalised/trades.length,nSd=Math.sqrt(trades.map((x)=>x.r*UNIT).reduce((a,b)=>a+(b-nMean)**2,0)/(trades.length-1));
let ne=0,np=0,ndd=0;for(const trade of curve){ne+=trade.r*UNIT;np=Math.max(np,ne);ndd=Math.min(ndd,ne-np);}
console.log(`\n风险归一化（每笔固定风险 ${UNIT} USDC，同样的成交、同样的出场，只改仓位大小）`);
console.log(`  总盈亏 ${normalised.toFixed(2)} USDC   均值 ${nMean.toFixed(3)} ± ${(nSd/Math.sqrt(trades.length)).toFixed(3)}  (t=${(nMean/(nSd/Math.sqrt(trades.length))).toFixed(2)})   最大回撤 ${ndd.toFixed(2)}`);
console.log(`  对比实盘固定保证金：${sum.toFixed(2)} USDC，回撤 ${dd.toFixed(2)}`);
const cap=100*settings.maxStopLossPercent/100/LEV;
const clamped=trades.filter((x)=>x.stopPct>=cap-1e-6).length;
console.log(`\n止损上限 ${settings.maxStopLossPercent}% 保证金 ÷ ${LEV}x = 价格 ${cap.toFixed(2)}%   ${clamped}/${trades.length} 笔被截断 (${(100*clamped/trades.length).toFixed(0)}%)`);
console.log("止损宽度分布（占入场价百分比）");
const widths=trades.map((x)=>x.stopPct).sort((a,b)=>a-b);
const pct=(q:number)=>widths[Math.min(widths.length-1,Math.floor(q*widths.length))]!.toFixed(2);
console.log(`  最小 ${pct(0)}%  P25 ${pct(0.25)}%  中位 ${pct(0.5)}%  P75 ${pct(0.75)}%  最大 ${pct(0.999)}%`);
console.log("\n最差 6 笔");
for(const trade of [...trades].sort((a,b)=>a.pnl-b.pnl).slice(0,6))
  console.log(`  ${trade.code.padEnd(8)} ${trade.dir.padEnd(6)} ${new Date(trade.openedAt).toISOString().slice(5,16)}  入场 ${trade.entry}  止损宽 ${trade.stopPct.toFixed(2)}%  ${trade.out.padEnd(3)} ${trade.r.toFixed(2)}R  ${trade.pnl.toFixed(2)}`);
const w2=trades.filter((x)=>x.widened),rest=trades.filter((x)=>!x.widened);
const show=(label:string,v:typeof trades)=>{
  if(!v.length){console.log(`  ${label} 无成交`);return;}
  const sum=v.reduce((a,b)=>a+b.pnl,0),m=sum/v.length;
  const sd=Math.sqrt(v.reduce((a,b)=>a+(b.pnl-m)**2,0)/Math.max(1,v.length-1));
  // R strips the position-size effect out: a widened stop loses more dollars
  // per -1R at fixed margin, so dollars alone cannot say whether the trades are
  // bad or merely bigger.
  const rs=v.map((x)=>x.r),mr=rs.reduce((a,b)=>a+b,0)/rs.length;
  const sdr=Math.sqrt(rs.reduce((a,b)=>a+(b-mr)**2,0)/Math.max(1,rs.length-1));
  console.log(`  ${label.padEnd(14)}${String(v.length).padStart(4)} 笔  ${sum.toFixed(2).padStart(9)}  均值 ${m.toFixed(3).padStart(7)} (t=${(m/(sd/Math.sqrt(v.length))).toFixed(2)})   均值R ${mr.toFixed(3).padStart(7)} (t=${(mr/(sdr/Math.sqrt(rs.length))).toFixed(2)})  胜率 ${(100*v.filter((x)=>x.pnl>0).length/v.length).toFixed(0)}%`);
};
console.log(`\n止损下限 ${process.env.MIN_STOP??0}%：被撑宽的单子（点差闸门本来会拒掉的）单独看`);
show("被撑宽",w2);show("其余",rest);
process.exit(0);
