"use client";
import { useEffect,useMemo,useRef,useState } from "react";
import * as echarts from "echarts";
import { publicApi } from "../lib/api";

type MarketPayload={
  candles:Array<{openTime:number;open:number;high:number;low:number;close:number;volume:number}>;
  signals:Array<{closed_at:string;direction:"LONG"|"SHORT";accepted:boolean;executable:boolean}>;
  orders:Array<{created_at:string;direction:"LONG"|"SHORT";entry_price:string;take_profit:string;stop_loss:string;state:string}>;
  heatmap:Array<{price:number;lowPrice:number;highPrice:number;intensity:number;rank:number}>;
};

const intervals=["5m","15m","1h","4h","1d"] as const;
type Interval=typeof intervals[number];
const selectStyle={background:"#071217",border:"1px solid var(--line)",color:"var(--text)",padding:"7px 10px",fontSize:11};

export function MarketChart({symbols=["BTCUSDT"]}:{symbols?:string[]}){
  const ref=useRef<HTMLDivElement>(null);
  const options=useMemo(()=>symbols.length?symbols:["BTCUSDT"],[symbols]);
  const [symbol,setSymbol]=useState(options[0]!);
  const [candleInterval,setCandleInterval]=useState<Interval>("15m");
  const [status,setStatus]=useState("正在加载 Binance K 线…");

  useEffect(()=>{if(!options.includes(symbol))setSymbol(options[0]!);},[options,symbol]);

  useEffect(()=>{
    if(!ref.current)return;
    const chart=echarts.init(ref.current);
    let disposed=false;
    async function load(){
      setStatus("正在加载 Binance K 线…");
      try{
        const response=await fetch(`${publicApi}/api/market/${symbol}/candles?interval=${candleInterval}&limit=200`);
        if(!response.ok)throw new Error(`HTTP ${response.status}`);
        const payload=await response.json() as MarketPayload;
        if(disposed)return;
        if(!payload.candles.length){setStatus("暂无 K 线数据");return;}
        setStatus("");
        const labels=payload.candles.map((c)=>new Date(c.openTime).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"}));
        const indexByTime=(time:string)=>{
          const target=new Date(time).getTime();let best=0,distance=Number.POSITIVE_INFINITY;
          payload.candles.forEach((c,i)=>{const d=Math.abs(c.openTime-target);if(d<distance){best=i;distance=d;}});return best;
        };
        const signalData=payload.signals.filter((s)=>s.accepted).map((s)=>{const i=indexByTime(s.closed_at),c=payload.candles[i]!;return {value:[i,s.direction==="LONG"?c.low:c.high],symbol:s.direction==="LONG"?"triangle":"pin",symbolRotate:s.direction==="LONG"?0:180,itemStyle:{color:s.executable?"#35d29a":"#f4b653"}};});

        // Spec 12.3: heatmap targets are price *regions*, so they render as
        // bands rather than a single line. The strongest three stay readable.
        const bands=[...payload.heatmap]
          .filter((region)=>Number.isFinite(region.lowPrice)&&Number.isFinite(region.highPrice))
          .sort((a,b)=>b.intensity-a.intensity).slice(0,3)
          .map((region,index)=>[
            {yAxis:region.lowPrice,itemStyle:{color:`rgba(244,182,83,${0.18-index*0.05})`},label:{show:index===0,formatter:`Heatmap ${Number(region.price).toLocaleString()}`,color:"#f4b653",position:"insideEndTop" as const,fontSize:9}},
            {yAxis:region.highPrice}
          ]);

        const lines:Array<Record<string,unknown>>=[];
        for(const order of payload.orders){
          const colour=order.direction==="LONG"?"#61a9ff":"#8d7bff";
          lines.push(
            {name:"Entry",yAxis:Number(order.entry_price),lineStyle:{color:colour},label:{formatter:`入场 ${Number(order.entry_price).toLocaleString()}`,fontSize:9}},
            {name:"TP",yAxis:Number(order.take_profit),lineStyle:{color:"#35d29a",type:"dashed"},label:{formatter:"TP",fontSize:9}},
            {name:"SL",yAxis:Number(order.stop_loss),lineStyle:{color:"#f0655b",type:"dashed"},label:{formatter:"SL",fontSize:9}}
          );
        }

        chart.setOption({
          animationDuration:400,
          grid:{left:8,right:12,top:16,bottom:32,containLabel:true},
          xAxis:{type:"category",data:labels,axisLine:{lineStyle:{color:"#25333c"}},axisLabel:{color:"#64747c",fontSize:10,interval:Math.max(0,Math.floor(labels.length/8))}},
          yAxis:{scale:true,position:"right",splitLine:{lineStyle:{color:"#1d2a31"}},axisLabel:{color:"#64747c",fontSize:10}},
          dataZoom:[{type:"inside",start:35,end:100}],
          series:[
            {name:"K线",type:"candlestick",data:payload.candles.map((c)=>[c.open,c.close,c.low,c.high]),
              itemStyle:{color:"#35d29a",color0:"#f0655b",borderColor:"#35d29a",borderColor0:"#f0655b"},
              markArea:{silent:true,data:bands},
              markLine:{silent:true,symbol:"none",label:{color:"#a9b8b5",position:"insideEndTop"},data:lines}},
            {name:"信号",type:"scatter",data:signalData,symbolSize:12}
          ],
          tooltip:{trigger:"axis",backgroundColor:"#0e171c",borderColor:"#2a3a42",textStyle:{color:"#eaf1ee"}}
        },true);
      }catch(error){if(!disposed)setStatus(`K 线加载失败：${error instanceof Error?error.message:"未知错误"}`);}
    }
    void load();
    const resize=()=>chart.resize();window.addEventListener("resize",resize);
    return()=>{disposed=true;window.removeEventListener("resize",resize);chart.dispose();};
  },[symbol,candleInterval]);

  return <div>
    <div className="toolbar" style={{marginBottom:10,flexWrap:"wrap"}}>
      <select aria-label="选择币种" value={symbol} onChange={(event)=>setSymbol(event.target.value)} style={selectStyle}>
        {options.map((value)=><option key={value} value={value}>{value}</option>)}
      </select>
      <select aria-label="选择周期" value={candleInterval} onChange={(event)=>setCandleInterval(event.target.value as Interval)} style={selectStyle}>
        {intervals.map((value)=><option key={value} value={value}>{value}</option>)}
      </select>
      <span className="subtle">黄色区带为 Heatmap 目标区域 · 三角/针为策略信号</span>
    </div>
    <div className="chartWrap"><div className="marketChart" ref={ref}/>{status&&<div className="chartStatus">{status}</div>}</div>
  </div>;
}
