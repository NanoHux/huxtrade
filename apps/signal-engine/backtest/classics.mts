/**
 * Textbook strategies on our own universe, under one harness.
 *
 * Every strategy sees the same 46 assets over the same 36 days, risks the same
 * 10 USDC per trade, pays the same costs and uses the same 2xATR stop, so the
 * only thing that varies between rows is the entry rule. Signals are read at a
 * bar's close and filled at the NEXT bar's open — a strategy that trades its
 * own signal bar is measuring hindsight, not edge.
 */
import { readFileSync } from "node:fs";
const DIR="/private/tmp/claude-501/-Users-hux-Desktop-huxtrade/499bb97e-f722-4740-975b-f921f3a83a72/scratchpad";
type Raw=[number,number,number,number,number,number];
const ohlc=JSON.parse(readFileSync(`${DIR}/ohlc5m.json`,"utf8")) as Record<string,Raw[]>;
const codes=Object.keys(ohlc).filter((c)=>ohlc[c]!.length>1000);
const base=new Map<string,Array<[number,number]>>();
for(const line of readFileSync(`${DIR}/baselines.csv`,"utf8").split("\n")){
  if(!line)continue;const [code,metric,ts,value]=line.split(",");
  const key=`${code}:${metric}`;const arr=base.get(key)??[];arr.push([Number(ts)*1000,Number(value)]);base.set(key,arr);
}
for(const arr of base.values())arr.sort((a,b)=>a[0]-b[0]);

const RISK=10,MAX_NOTIONAL=500,FEE=0.0005;      // 5bp per side, both ways charged
type Bar={t:number;o:number;h:number;l:number;c:number;cvd:number};
function resample(raw:Raw[],minutes:number):Bar[]{
  const step=minutes*60_000,out:Bar[]=[];let cur:Bar|null=null;
  for(const r of raw){
    const k=Math.floor(r[0]/step)*step;
    if(!cur||cur.t!==k){if(cur)out.push(cur);cur={t:k,o:r[1],h:r[2],l:r[3],c:r[4],cvd:r[5]};}
    else{cur.h=Math.max(cur.h,r[2]);cur.l=Math.min(cur.l,r[3]);cur.c=r[4];cur.cvd+=r[5];}
  }
  if(cur)out.push(cur);return out;
}
function atrSeries(bars:Bar[],period:number):number[]{
  const out=new Array<number>(bars.length).fill(NaN);let sum=0,prev=NaN;
  for(let i=0;i<bars.length;i+=1){
    const tr=i===0?bars[0]!.h-bars[0]!.l:Math.max(bars[i]!.h-bars[i]!.l,Math.abs(bars[i]!.h-bars[i-1]!.c),Math.abs(bars[i]!.l-bars[i-1]!.c));
    if(i<period){sum+=tr;if(i===period-1){prev=sum/period;out[i]=prev;}}
    else{prev=(prev*(period-1)+tr)/period;out[i]=prev;}
  }
  return out;
}
const emaSeries=(v:number[],p:number)=>{const k=2/(p+1);const o=new Array<number>(v.length).fill(NaN);let e=v[0]!;for(let i=0;i<v.length;i+=1){e=i===0?v[0]!:v[i]!*k+e*(1-k);if(i>=p-1)o[i]=e;}return o;};
const smaSeries=(v:number[],p:number)=>{const o=new Array<number>(v.length).fill(NaN);let s=0;for(let i=0;i<v.length;i+=1){s+=v[i]!;if(i>=p)s-=v[i-p]!;if(i>=p-1)o[i]=s/p;}return o;};
function rsiSeries(v:number[],p:number){const o=new Array<number>(v.length).fill(NaN);let g=0,l=0;
  for(let i=1;i<v.length;i+=1){const d=v[i]!-v[i-1]!,up=Math.max(0,d),dn=Math.max(0,-d);
    if(i<=p){g+=up/p;l+=dn/p;if(i===p)o[i]=l===0?100:100-100/(1+g/l);}
    else{g=(g*(p-1)+up)/p;l=(l*(p-1)+dn)/p;o[i]=l===0?100:100-100/(1+g/l);}}
  return o;}
const stdSeries=(v:number[],p:number)=>{const o=new Array<number>(v.length).fill(NaN);
  for(let i=p-1;i<v.length;i+=1){const w=v.slice(i-p+1,i+1),m=w.reduce((a,b)=>a+b,0)/p;o[i]=Math.sqrt(w.reduce((a,b)=>a+(b-m)**2,0)/p);}return o;};

type Trade={t:number;pnl:number;code:string};
/** A strategy returns the position it wants (-1/0/1) at the close of bar i. */
type Strat={name:string;minutes:number;desired:(ctx:Ctx,i:number)=>-1|0|1;stopAtr?:number};
type Ctx={bars:Bar[];close:number[];atr:number[];code:string};

function run(strat:Strat):Trade[]{
  const trades:Trade[]=[],kStop=strat.stopAtr??2;
  for(const code of codes){
    const bars=resample(ohlc[code]!,strat.minutes);
    const warm=Math.min(60,Math.floor(bars.length/4));
    if(bars.length<warm+10)continue;
    const close=bars.map((b)=>b.c),atr=atrSeries(bars,14);
    const ctx:Ctx={bars,close,atr,code};
    let pos=0,entry=0,stop=0,qty=0,openedAt=0;
    for(let i=warm;i<bars.length-1;i+=1){
      const next=bars[i+1]!;
      if(pos!==0){
        const hit=pos>0?next.l<=stop:next.h>=stop;
        if(hit){trades.push({t:next.t,code,pnl:qty*(stop-entry)*pos-qty*(entry+stop)*FEE});pos=0;continue;}
      }
      const want=ctx.atr[i]!>0?strat.desired(ctx,i):0;
      if(want===pos)continue;
      if(pos!==0){trades.push({t:next.t,code,pnl:qty*(next.o-entry)*pos-qty*(entry+next.o)*FEE});pos=0;}
      if(want!==0){
        const dist=kStop*ctx.atr[i]!;
        if(!(dist>0))continue;
        if(kStop>1000){qty=MAX_NOTIONAL/next.o;pos=want;entry=next.o;stop=want>0?0:Infinity;continue;}
        // Fixed risk, but never more notional than the live account can carry:
        // a tight stop otherwise buys an unbounded position.
        qty=Math.min(RISK/dist,MAX_NOTIONAL/next.o);
        pos=want;entry=next.o;openedAt=next.t;stop=want>0?entry-dist:entry+dist;
      }
    }
    if(pos!==0){const last=bars.at(-1)!;trades.push({t:last.t,code,pnl:qty*(last.c-entry)*pos-qty*(entry+last.c)*FEE});}
    void openedAt;
  }
  return trades;
}

const strategies:Strat[]=[
  {name:"买入持有 (1h)",minutes:60,desired:()=>1,stopAtr:1e6},
  {name:"EMA 20/50 交叉 (1h)",minutes:60,desired:(c,i)=>{const f=emaSeries(c.close,20),s=emaSeries(c.close,50);return f[i]!>s[i]!?1:f[i]!<s[i]!?-1:0;}},
  {name:"EMA 9/21 交叉 (1h)",minutes:60,desired:(c,i)=>{const f=emaSeries(c.close,9),s=emaSeries(c.close,21);return f[i]!>s[i]!?1:f[i]!<s[i]!?-1:0;}},
  {name:"EMA 20/50 交叉 (4h)",minutes:240,desired:(c,i)=>{const f=emaSeries(c.close,20),s=emaSeries(c.close,50);return f[i]!>s[i]!?1:f[i]!<s[i]!?-1:0;}},
  {name:"唐奇安 20 突破 (1h)",minutes:60,desired:(c,i)=>{const hi=Math.max(...c.bars.slice(i-20,i).map((b)=>b.h)),lo=Math.min(...c.bars.slice(i-20,i).map((b)=>b.l));return c.close[i]!>hi?1:c.close[i]!<lo?-1:0;}},
  {name:"唐奇安 55 突破 (1h)",minutes:60,desired:(c,i)=>{const hi=Math.max(...c.bars.slice(i-55,i).map((b)=>b.h)),lo=Math.min(...c.bars.slice(i-55,i).map((b)=>b.l));return c.close[i]!>hi?1:c.close[i]!<lo?-1:0;}},
  {name:"唐奇安 20 反向 (1h)",minutes:60,desired:(c,i)=>{const hi=Math.max(...c.bars.slice(i-20,i).map((b)=>b.h)),lo=Math.min(...c.bars.slice(i-20,i).map((b)=>b.l));return c.close[i]!>hi?-1:c.close[i]!<lo?1:0;}},
  {name:"RSI 14 均值回归 (1h)",minutes:60,desired:(c,i)=>{const r=rsiSeries(c.close,14)[i]!;return r<30?1:r>70?-1:0;}},
  {name:"RSI 14 顺势 (1h)",minutes:60,desired:(c,i)=>{const r=rsiSeries(c.close,14)[i]!;return r>70?1:r<30?-1:0;}},
  {name:"布林 20/2 回归 (1h)",minutes:60,desired:(c,i)=>{const m=smaSeries(c.close,20),s=stdSeries(c.close,20);return c.close[i]!<m[i]!-2*s[i]!?1:c.close[i]!>m[i]!+2*s[i]!?-1:0;}},
  {name:"布林 20/2 突破 (1h)",minutes:60,desired:(c,i)=>{const m=smaSeries(c.close,20),s=stdSeries(c.close,20);return c.close[i]!>m[i]!+2*s[i]!?1:c.close[i]!<m[i]!-2*s[i]!?-1:0;}},
  {name:"MACD 12/26/9 (1h)",minutes:60,desired:(c,i)=>{const f=emaSeries(c.close,12),s=emaSeries(c.close,26);const macd=f.map((v,j)=>v-s[j]!);const sig=emaSeries(macd.map((v)=>Number.isFinite(v)?v:0),9);return macd[i]!>sig[i]!?1:macd[i]!<sig[i]!?-1:0;}},
  {name:"超级趋势 10/3 (1h)",minutes:60,desired:(c,i)=>{
    let dir:-1|1=1,up=-Infinity,dn=Infinity;
    for(let j=15;j<=i;j+=1){
      const a=c.atr[j]!,mid=(c.bars[j]!.h+c.bars[j]!.l)/2,bu=mid-3*a,bd=mid+3*a;
      up=(bu>up||c.close[j-1]!<up)?bu:up;dn=(bd<dn||c.close[j-1]!>dn)?bd:dn;
      dir=c.close[j]!>dn?1:c.close[j]!<up?-1:dir;
    }
    return dir;}},
  {name:"CVD 顺势 (1h)",minutes:60,desired:(c,i)=>c.bars[i]!.cvd>0?1:c.bars[i]!.cvd<0?-1:0},
  {name:"CVD 反向 (1h)",minutes:60,desired:(c,i)=>c.bars[i]!.cvd>0?-1:c.bars[i]!.cvd<0?1:0},
  {name:"EMA 50/200 交叉 (1h)",minutes:60,desired:(c,i)=>{const f=emaSeries(c.close,50),s2=emaSeries(c.close,200);return f[i]!>s2[i]!?1:f[i]!<s2[i]!?-1:0;}},
  {name:"EMA 20/50 只做多 (1h)",minutes:60,desired:(c,i)=>{const f=emaSeries(c.close,20),s2=emaSeries(c.close,50);return f[i]!>s2[i]!?1:0;}},
  {name:"EMA 20/50 只做空 (1h)",minutes:60,desired:(c,i)=>{const f=emaSeries(c.close,20),s2=emaSeries(c.close,50);return f[i]!<s2[i]!?-1:0;}},
  {name:"唐奇安20+EMA200过滤",minutes:60,desired:(c,i)=>{const trend=emaSeries(c.close,200)[i]!;const hi=Math.max(...c.bars.slice(i-20,i).map((b)=>b.h)),lo=Math.min(...c.bars.slice(i-20,i).map((b)=>b.l));
    if(c.close[i]!>hi&&c.close[i]!>trend)return 1;if(c.close[i]!<lo&&c.close[i]!<trend)return -1;return 0;}},
  {name:"日内动量：昨涨今追 (1d)",minutes:1440,desired:(c,i)=>c.close[i]!>c.close[i-1]!?1:-1},
  {name:"日内反转：昨涨今空 (1d)",minutes:1440,desired:(c,i)=>c.close[i]!>c.close[i-1]!?-1:1},
];

function report(name:string,trades:Trade[]){
  if(trades.length<2){console.log(`${name}  无成交`);return null;}
  const sorted=[...trades].sort((a,b)=>a.t-b.t);
  const pnl=sorted.map((x)=>x.pnl),sum=pnl.reduce((a,b)=>a+b,0),mean=sum/pnl.length;
  const sd=Math.sqrt(pnl.reduce((a,b)=>a+(b-mean)**2,0)/(pnl.length-1)),se=sd/Math.sqrt(pnl.length);
  let e=0,peak=0,dd=0;for(const p of pnl){e+=p;peak=Math.max(peak,e);dd=Math.min(dd,e-peak);}
  const byCode=new Map<string,number>();
  for(const trade of sorted)byCode.set(trade.code,(byCode.get(trade.code)??0)+trade.pnl);
  const ranked=[...byCode.values()].sort((a,b)=>b-a);
  const exTop2=sum-(ranked[0]??0)-(ranked[1]??0);
  const med=ranked.length?ranked.slice().sort((a,b)=>a-b)[Math.floor(ranked.length/2)]!:0;
  return {name,n:pnl.length,sum,mean,t:mean/se,win:100*pnl.filter((x)=>x>0).length/pnl.length,dd,exTop2,med,assets:ranked.length};
}
const rows=strategies.map((s)=>report(s.name,run(s))).filter((x):x is NonNullable<typeof x>=>x!==null)
  .sort((a,b)=>b.sum-a.sum);
const w=(s:string,n:number)=>s+" ".repeat(Math.max(0,n-[...s].reduce((a,ch)=>a+(ch.charCodeAt(0)>127?2:1),0)));
console.log(`46 币 / 36 天 / 每笔固定风险 ${RISK} USDC / 2xATR 止损 / 单边 ${FEE*10000}bp 成本 / 信号收盘出、下根开盘成交\n`);
console.log(`${w("策略",26)}${"成交".padStart(7)}${"总盈亏".padStart(10)}${"去掉最强2币".padStart(13)}${"币种中位".padStart(10)}${"t".padStart(7)}${"胜率".padStart(7)}`);
for(const r of rows)console.log(`${w(r.name,26)}${String(r.n).padStart(7)}${r.sum.toFixed(0).padStart(10)}${r.exTop2.toFixed(0).padStart(13)}${r.med.toFixed(1).padStart(10)}${r.t.toFixed(2).padStart(7)}${r.win.toFixed(0).padStart(6)}%`);
process.exit(0);
