"use client";
import { useEffect,useRef,useState } from "react";
import * as echarts from "echarts";
import { publicApi } from "../lib/api";

type MarketPayload={
  candles:Array<{openTime:number;open:number;high:number;low:number;close:number;volume:number}>;
  signals:Array<{closed_at:string;direction:"LONG"|"SHORT";accepted:boolean;executable:boolean}>;
  orders:Array<{created_at:string;entry_price:string;take_profit:string;stop_loss:string;state:string}>;
  heatmap:Array<{price:number;intensity:number;rank:number}>;
};

export function MarketChart({symbol="BTCUSDT"}:{symbol?:string}){
  const ref=useRef<HTMLDivElement>(null);
  const [status,setStatus]=useState("正在加载 Binance K 线…");
  useEffect(()=>{
    if(!ref.current)return;
    const chart=echarts.init(ref.current);
    let disposed=false;
    async function load(){
      try{
        const response=await fetch(`${publicApi}/api/market/${symbol}/candles?interval=15m&limit=200`);
        if(!response.ok)throw new Error(`HTTP ${response.status}`);
        const payload=await response.json() as MarketPayload;
        if(disposed)return;
        if(!payload.candles.length){setStatus("暂无 K 线数据");return;}
        setStatus("");
        const labels=payload.candles.map((c)=>new Date(c.openTime).toLocaleTimeString("zh-CN",{timeZone:"Asia/Shanghai",hour:"2-digit",minute:"2-digit",month:"2-digit",day:"2-digit"}));
        const indexByTime=(time:string)=>{
          const target=new Date(time).getTime();let best=0,distance=Number.POSITIVE_INFINITY;
          payload.candles.forEach((c,i)=>{const d=Math.abs(c.openTime-target);if(d<distance){best=i;distance=d;}});return best;
        };
        const signalData=payload.signals.filter((s)=>s.accepted).map((s)=>{const i=indexByTime(s.closed_at),c=payload.candles[i]!;return {value:[i,s.direction==="LONG"?c.low:c.high],symbol:s.direction==="LONG"?"triangle":"pin",symbolRotate:s.direction==="LONG"?0:180,itemStyle:{color:s.executable?"#35d29a":"#f4b653"}};});
        const strongest=[...payload.heatmap].sort((a,b)=>b.intensity-a.intensity)[0];
        const latestOrder=payload.orders.at(-1);
        const lines:Array<Record<string,unknown>>=[];
        if(strongest)lines.push({name:"Heatmap",yAxis:strongest.price,label:{formatter:`Heatmap ${Number(strongest.price).toLocaleString()}`},lineStyle:{color:"#f4b653",type:"dashed"}});
        if(latestOrder){lines.push({name:"Entry",yAxis:Number(latestOrder.entry_price),lineStyle:{color:"#61a9ff"}},{name:"TP",yAxis:Number(latestOrder.take_profit),lineStyle:{color:"#35d29a"}},{name:"SL",yAxis:Number(latestOrder.stop_loss),lineStyle:{color:"#f0655b"}});}
        chart.setOption({animationDuration:400,grid:{left:8,right:12,top:16,bottom:32,containLabel:true},xAxis:{type:"category",data:labels,axisLine:{lineStyle:{color:"#25333c"}},axisLabel:{color:"#64747c",fontSize:10,interval:Math.max(0,Math.floor(labels.length/8))}},yAxis:{scale:true,position:"right",splitLine:{lineStyle:{color:"#1d2a31"}},axisLabel:{color:"#64747c",fontSize:10}},dataZoom:[{type:"inside",start:35,end:100}],series:[{name:"K线",type:"candlestick",data:payload.candles.map((c)=>[c.open,c.close,c.low,c.high]),itemStyle:{color:"#35d29a",color0:"#f0655b",borderColor:"#35d29a",borderColor0:"#f0655b"},markLine:{silent:true,symbol:"none",label:{color:"#a9b8b5",position:"insideEndTop"},data:lines}},{name:"信号",type:"scatter",data:signalData,symbolSize:12}],tooltip:{trigger:"axis",backgroundColor:"#0e171c",borderColor:"#2a3a42",textStyle:{color:"#eaf1ee"}}});
      }catch(error){if(!disposed)setStatus(`K 线加载失败：${error instanceof Error?error.message:"未知错误"}`);}
    }
    void load();
    const resize=()=>chart.resize();window.addEventListener("resize",resize);
    return()=>{disposed=true;window.removeEventListener("resize",resize);chart.dispose();};
  },[symbol]);
  return <div className="chartWrap"><div className="marketChart" ref={ref}/>{status&&<div className="chartStatus">{status}</div>}</div>;
}
