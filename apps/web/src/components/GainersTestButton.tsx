"use client";
import { useCallback, useEffect, useState } from "react";
import { publicApi } from "../lib/api";
import { gainersStrategy as s } from "@huxtrade/shared-types";

type Props={state:string;legs:number;binanceMode?:boolean};

/** The agent sizes a test basket off this share of the balance, not the daily one. */
const TEST_BALANCE_SHARE=0.10;

export function GainersTestButton({state:initialState,legs:initialLegs,binanceMode}:Props){
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState("");
  const [state,setState]=useState(initialState);
  const [legs,setLegs]=useState(initialLegs);
  const running=state!=="IDLE";
  const pending=state==="START_REQUESTED"||state==="STOP_REQUESTED";

  const refresh=useCallback(async()=>{
    try{
      const response=await fetch(`${publicApi}/api/settings/status`,{cache:"no-store"});
      if(!response.ok)return;
      const body=await response.json() as {gainersTestState?:string;gainersTestLegs?:number};
      setState(String(body.gainersTestState??"IDLE"));
      setLegs(Number(body.gainersTestLegs??0));
    }catch{/* a failed poll just leaves the last known state on screen */}
  },[]);

  useEffect(()=>{
    const period=pending?3_000:15_000;
    const timer=setInterval(refresh,period);
    return ()=>clearInterval(timer);
  },[refresh,pending]);

  async function toggle(){
    if(!binanceMode){setMessage("未配置 Binance API Key，无法测试。");return;}
    if(!running&&!window.confirm(
      `立即建仓：做多 Binance ${s.lookbackHours}h 涨幅榜前 ${s.basket}，${s.leverage} 倍杠杆，` +
      `每单保证金 = 余额的 ${TEST_BALANCE_SHARE*100}% ÷ ${s.basket}。\n\n` +
      `这会用真实资金在 Binance 市价成交，且不会自动平仓——要用下面同一个按钮结束。确认开始测试？`))return;
    if(running&&!window.confirm("将市价平掉账户内的全部持仓（包括手动开的）。确认结束？"))return;
    setBusy(true);setMessage("已提交，等待 Agent 执行（最多 30 秒）…");
    try{
      const response=await fetch(`${publicApi}/api/settings/gainers/test`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({running:!running})});
      const body=await response.json().catch(()=>({}));
      if(!response.ok){setMessage(`操作失败：${body.message??body.error??"未知错误"}`);return;}
      setMessage(running?"平仓指令已下达，结果见 Telegram。":"开仓指令已下达，逐单结果见 Telegram。");
      await refresh();
    }catch(error){
      setMessage(`请求失败：${error instanceof Error?error.message:String(error)}`);
    }finally{
      setBusy(false);
    }
  }

  const label=state==="START_REQUESTED"?"正在开仓…"
    :state==="STOP_REQUESTED"?"正在平仓…"
    :running?"结束测试（平掉账户全部持仓）"
    :"开始测试（立即按榜单开仓）";

  return <div className="toolbar" style={{marginTop:8}}>
    <button className={`btn ${running?"danger":""}`} disabled={busy||pending||!binanceMode} onClick={toggle}>{label}</button>
    <span className="subtle">
      {!binanceMode?"需要 Binance API Key"
        :running?`测试进行中 · ${legs} 条腿 · 不会自动平仓`
        :`未在测试 · 余额 ${TEST_BALANCE_SHARE*100}% ÷ ${s.basket} 腿`}
    </span>
    <span className="subtle">{message}</span>
  </div>;
}
