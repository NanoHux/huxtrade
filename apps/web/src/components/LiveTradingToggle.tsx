"use client";
import { useState } from "react";
import { publicApi } from "../lib/api";

export function LiveTradingToggle({enabled}:{enabled:boolean}){
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState("");

  async function toggle(){
    if(!enabled&&!window.confirm("即将开启真实资金交易：涨幅榜篮子会在每天的建仓时刻自动在 Binance 市价开仓。确认开启？"))return;
    setBusy(true);setMessage("正在切换并请求重启 variational-agent…");
    try{
      const response=await fetch(`${publicApi}/api/settings/live-trading`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({enabled:!enabled})});
      const body=await response.json().catch(()=>({}));
      if(!response.ok){setMessage(`操作失败：${body.message??body.error??"未知错误"}`);return;}
      setMessage("已切换，variational-agent 重启后生效。");
    }catch(error){
      setMessage(`请求失败：${error instanceof Error?error.message:String(error)}`);
    }finally{
      setBusy(false);
    }
  }

  return <div className="toolbar" style={{marginTop:8}}>
    <button className={`btn ${enabled?"danger":"primary"}`} disabled={busy} onClick={toggle}>
      {enabled?"禁用真实交易":"启用真实交易"}
    </button>
    <span className="subtle">{message}</span>
  </div>;
}
