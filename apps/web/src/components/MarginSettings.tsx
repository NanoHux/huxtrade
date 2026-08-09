"use client";
import { useState } from "react";
import { publicApi } from "../lib/api";

export function MarginSettings({defaultMarginUsdc,maxMarginUsdc}:{defaultMarginUsdc:number;maxMarginUsdc:number}){
  const [defaultValue,setDefaultValue]=useState(String(defaultMarginUsdc));
  const [maxValue,setMaxValue]=useState(String(maxMarginUsdc));
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState("");

  async function save(){
    const defaultMarginUsdc=Number(defaultValue),maxMarginUsdc=Number(maxValue);
    if(!(defaultMarginUsdc>0)||!(maxMarginUsdc>0)){setMessage("请输入大于 0 的数字");return;}
    if(defaultMarginUsdc>maxMarginUsdc){setMessage("默认保证金不能超过保证金上限");return;}
    setBusy(true);setMessage("正在保存并请求重启 signal-engine / variational-agent…");
    try{
      const response=await fetch(`${publicApi}/api/settings/margin`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({defaultMarginUsdc,maxMarginUsdc})});
      const body=await response.json().catch(()=>({}));
      if(!response.ok){setMessage(`保存失败：${body.message??body.error??"未知错误"}`);return;}
      setMessage("已保存，重启后新信号会按新的保证金下单；重启结果见下方「密钥更新与服务重启」。");
    }catch(error){
      setMessage(`请求失败：${error instanceof Error?error.message:String(error)}`);
    }finally{
      setBusy(false);
    }
  }

  return <div className="formGrid" style={{marginTop:8}}>
    <div className="field"><label>默认保证金 (USDC)</label><input type="number" min="1" step="1" value={defaultValue} disabled={busy} onChange={(e)=>setDefaultValue(e.target.value)}/></div>
    <div className="field"><label>保证金上限 (USDC)</label><input type="number" min="1" step="1" value={maxValue} disabled={busy} onChange={(e)=>setMaxValue(e.target.value)}/></div>
    <div className="toolbar" style={{gridColumn:"1 / -1"}}>
      <button className="btn primary" disabled={busy} onClick={save}>保存</button>
      <span className="subtle">每笔新订单的本金；上限是平台最低保证金要求可以被抬高到的最大值。{message}</span>
    </div>
  </div>;
}
