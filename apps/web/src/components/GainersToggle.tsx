"use client";
import { useCallback, useEffect, useState } from "react";
import { publicApi } from "../lib/api";
import { gainersStrategy as s } from "@huxtrade/shared-types";

type Props={enabled:boolean;marginUsdc:number|null;closeAt:string|null;openLegs:number};

const beijing=(hourUtc:number,minute:number)=>`${String((hourUtc+8)%24).padStart(2,"0")}:${String(minute).padStart(2,"0")}`;
const OPEN=beijing(s.openHourUtc,s.openMinuteUtc),CLOSE=beijing(s.openHourUtc+s.holdHours,s.openMinuteUtc);

/**
 * The daily gainers basket switch.
 *
 * Turning it off never touches a basket that is already open — the agent keeps
 * that basket's exit time and closes it in the morning regardless. Saying so on
 * the button matters: an operator who reads "off" as "flat" would go looking
 * for positions that are still there.
 *
 * Every number here is read from the strategy constants rather than typed out.
 * The previous copy described a retired strategy — a 00:07 entry, a short leg,
 * 75% of balance — on the one dialog that arms real leveraged orders.
 */
export function GainersToggle({enabled:initialEnabled,marginUsdc:initialMargin,closeAt:initialCloseAt,openLegs:initialLegs}:Props){
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState("");
  const [enabled,setEnabled]=useState(initialEnabled);
  const [marginUsdc,setMargin]=useState(initialMargin);
  const [closeAt,setCloseAt]=useState(initialCloseAt);
  const [openLegs,setOpenLegs]=useState(initialLegs);

  // Same reason as the test button: the agent opens and closes baskets on its
  // own clock, so a server-rendered label goes stale the moment it does.
  const refresh=useCallback(async()=>{
    try{
      const response=await fetch(`${publicApi}/api/settings/status`,{cache:"no-store"});
      if(!response.ok)return;
      const body=await response.json() as {gainersEnabled?:boolean;gainersMarginUsdc?:number|null;gainersCloseAt?:string|null;gainersOpenLegs?:number};
      setEnabled(Boolean(body.gainersEnabled));
      setMargin(body.gainersMarginUsdc==null?null:Number(body.gainersMarginUsdc));
      setCloseAt(body.gainersCloseAt==null?null:String(body.gainersCloseAt));
      setOpenLegs(Number(body.gainersOpenLegs??0));
    }catch{/* keep the last known state on screen */}
  },[]);
  useEffect(()=>{const timer=setInterval(refresh,15_000);return ()=>clearInterval(timer);},[refresh]);

  async function toggle(){
    if(!enabled&&!window.confirm(
      `开启后每天 UTC+8 ${OPEN} 自动建仓：做多 ${s.lookbackHours}h 涨幅榜前 ${s.basket}，${s.leverage} 倍杠杆，` +
      `用余额的 ${s.deployFraction*100}% 均分到各腿；止盈 +${s.takeProfitFraction*100}%、止损 −${s.stopFraction*100}%；` +
      `${CLOSE} 平掉全部持仓。\n\n这会用真实资金下单。确认开启？`))return;
    setBusy(true);setMessage("正在切换…");
    try{
      const response=await fetch(`${publicApi}/api/settings/gainers`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({enabled:!enabled})});
      const body=await response.json().catch(()=>({}));
      if(!response.ok){setMessage(`操作失败：${body.message??body.error??"未知错误"}`);return;}
      setMessage(enabled
        ?(openLegs?"已关闭，但当前持仓仍会在预定时间平掉。":"已关闭，今晚不会开仓。")
        :`已开启，30 秒内生效。今晚 UTC+8 ${OPEN} 自动开仓。`);
      await refresh();
    }catch(error){
      setMessage(`请求失败：${error instanceof Error?error.message:String(error)}`);
    }finally{
      setBusy(false);
    }
  }

  return <div className="toolbar" style={{marginTop:8}}>
    <button className={`btn ${enabled?"danger":"primary"}`} disabled={busy} onClick={toggle}>
      {enabled?"停止涨幅榜定时器":"启动涨幅榜定时器"}
    </button>
    <span className="subtle">
      {enabled?`每天 ${OPEN} 建仓 / ${CLOSE} 平仓（UTC+8）`:"未启动"}
      {marginUsdc?` · 每单 ${marginUsdc} USDC`:` · 每单 = 余额×${s.deployFraction*100}% / ${s.basket}，${s.leverage} 倍`}
      {openLegs>0&&closeAt?` · 持仓 ${openLegs} 个，${new Date(closeAt).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai",hour12:false})} 平仓`:""}
    </span>
    <span className="subtle">{message}</span>
  </div>;
}
