"use client";
import { useState } from "react";
import { publicApi } from "../lib/api";

type Preference={event_type:string;enabled:boolean};

const labels:Record<string,string>={
  gainers_basket:"篮子建仓汇总",gainers_leg:"篮子逐腿成交",gainers_closed:"篮子平仓结算",
  system_error:"系统异常",service_recovered:"服务恢复",margin_pause_resume:"保证金暂停 / 恢复",operator_reply:"助手回复",
  signal:"策略信号触发",order_created:"订单创建成功",order_failed:"订单创建失败",entry_filled:"入场成交",
  closed_tp:"止盈关闭",closed_sl_or_liquidated:"止损关闭 / 强平",closed_reversed:"反向信号平仓",
  resting_order_replaced:"驻留单被替换",scaled_out:"分批止盈",breakeven_stop_failed:"保本止损失败",
  direction_halted:"方向熔断",venue_limit_rejected:"平台限制拒单",order_desynced:"订单状态失步",
  asset_resumed:"币种自动恢复监控",variational_session_lost:"Variational 登录失效"
};

/**
 * Events the live strategy can actually emit. Everything else belongs to the
 * retired resting-entry model — its producer code is still in the tree, so the
 * toggles stay rather than being deleted, but they are separated so the list
 * does not read as twenty equally-live notifications.
 */
const liveEvents=new Set(["gainers_basket","gainers_leg","gainers_closed","system_error","service_recovered","margin_pause_resume","operator_reply"]);

export function SystemSettings({status,initialPreferences}:{status:Record<string,unknown>;initialPreferences:Preference[]}){
  const [token,setToken]=useState(""),[chatId,setChatId]=useState("");
  const [showTelegram,setShowTelegram]=useState(false);
  const [message,setMessage]=useState(""),[preferences,setPreferences]=useState(initialPreferences);

  async function reveal(){
    const response=await fetch(`${publicApi}/api/settings/secrets/telegram`);if(!response.ok){setMessage("读取本机密钥失败");return;}
    const body=await response.json();
    setToken(body.botToken??"");setChatId(body.chatId??"");setShowTelegram(true);
  }
  async function action(save:boolean){
    setMessage(save?"正在测试并保存…":"正在发送测试消息…");
    try{
      const response=await fetch(`${publicApi}/api/settings/telegram/${save?"save":"test"}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({botToken:token,chatId})});
      const body=await response.json().catch(()=>({}));
      setMessage(response.ok?(save?"已保存并请求重启 telegram-worker":"测试消息发送成功"):`验证失败：${body.message??body.error??"请检查 Token 与 Chat ID"}`);
    }catch(error){
      setMessage(`请求失败：${error instanceof Error?error.message:String(error)}`);
    }
  }
  async function toggle(item:Preference){
    const enabled=!item.enabled;
    await fetch(`${publicApi}/api/settings/notifications/${item.event_type}`,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({enabled})});
    setPreferences(preferences.map((value)=>value.event_type===item.event_type?{...value,enabled}:value));
  }

  const live=preferences.filter((p)=>liveEvents.has(p.event_type));
  const dormant=preferences.filter((p)=>!liveEvents.has(p.event_type));
  const row=(item:Preference)=><label key={item.event_type} className="notificationToggle">
    <span>{labels[item.event_type]??item.event_type}</span>
    <input type="checkbox" checked={item.enabled} onChange={()=>toggle(item)}/>
  </label>;

  return <div className="pageGrid">
    <section className="panel">
      <div className="panelHead"><div><h2>Telegram</h2><small>密钥只写入本机 .env，不进入 PostgreSQL</small></div><span className={`tag ${status.telegramConfigured?"":"orange"}`}>{status.telegramConfigured?"CONFIGURED":"NOT SET"}</span></div>
      <div className="formGrid">
        <div className="field"><label>Bot Token</label><input type={showTelegram?"text":"password"} value={token} onChange={event=>setToken(event.target.value)} placeholder="••••••••••••••••"/></div>
        <div className="field"><label>固定 Chat ID</label><input type={showTelegram?"text":"password"} value={chatId} onChange={event=>setChatId(event.target.value)} placeholder="••••••••"/></div>
        <div className="toolbar"><button className="btn" onClick={reveal}>显示现值</button><button className="btn" onClick={()=>action(false)}>发送测试</button><button className="btn primary" onClick={()=>action(true)}>验证并保存</button><span className="subtle">{message}</span></div>
      </div>
    </section>

    <section className="panel">
      <div className="panelHead"><h2>通知事件</h2><small>异常期间产生的新通知仍会直接丢弃</small></div>
      <div className="notificationGrid">{live.map(row)}</div>
      {dormant.length>0&&<>
        <div className="divider"/>
        <p className="subtle" style={{margin:"0 0 8px"}}>以下属于已退役的驻留限价策略，signal-engine 未运行时不会触发：</p>
        <div className="notificationGrid">{dormant.map(row)}</div>
      </>}
    </section>
  </div>;
}
