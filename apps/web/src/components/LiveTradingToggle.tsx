"use client";
import { useState } from "react";
import { publicApi } from "../lib/api";

export function LiveTradingToggle({enabled}:{enabled:boolean}){
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState("");

  async function toggle(){
    if(!enabled&&!window.confirm("即将开启真实资金交易：满足条件的策略信号会自动在 Variational 下真实限价单。确认开启？"))return;
    setBusy(true);setMessage("正在切换并请求重启 Variational Agent…");
    try{
      const response=await fetch(`${publicApi}/api/settings/live-trading`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({enabled:!enabled})});
      const body=await response.json().catch(()=>({}));
      if(!response.ok){setMessage(`操作失败：${body.message??body.error??"未知错误"}`);return;}
      setMessage("已切换，Variational Agent 重启后生效；重启结果见下方「密钥更新与服务重启」。");
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
