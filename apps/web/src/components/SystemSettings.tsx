"use client";
import { useState } from "react";
import { publicApi } from "../lib/api";

type Preference={event_type:string;enabled:boolean};
const labels:Record<string,string>={signal:"策略信号触发",order_created:"订单创建成功",order_failed:"订单创建失败",entry_filled:"入场成交",closed_tp:"止盈关闭",closed_sl_or_liquidated:"止损关闭 / 强平",system_error:"系统异常",variational_session_lost:"Variational 登录失效",margin_pause_resume:"保证金暂停 / 恢复",service_recovered:"服务恢复"};

export function SystemSettings({status,initialPreferences}:{status:Record<string,unknown>;initialPreferences:Preference[]}){
  const [token,setToken]=useState(""),[chatId,setChatId]=useState(""),[cgKey,setCgKey]=useState("");
  const [showTelegram,setShowTelegram]=useState(false),[showCoinglass,setShowCoinglass]=useState(false);
  const [message,setMessage]=useState(""),[preferences,setPreferences]=useState(initialPreferences);
  async function reveal(kind:"telegram"|"coinglass"){
    const response=await fetch(`${publicApi}/api/settings/secrets/${kind}`);if(!response.ok){setMessage("读取本机密钥失败");return;}
    const body=await response.json();
    if(kind==="telegram"){setToken(body.botToken??"");setChatId(body.chatId??"");setShowTelegram(true);}else{setCgKey(body.apiKey??"");setShowCoinglass(true);}
  }
  async function action(save:boolean){setMessage(save?"正在测试并保存…":"正在发送测试消息…");const response=await fetch(`${publicApi}/api/settings/telegram/${save?"save":"test"}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({botToken:token,chatId})});setMessage(response.ok?(save?"已保存并请求重启 Telegram Worker":"测试消息发送成功"):"验证失败，请检查 Token 与 Chat ID");}
  async function coinglass(save:boolean){setMessage("正在验证 CoinGlass Heatmap…");const response=await fetch(`${publicApi}/api/settings/coinglass/${save?"save":"test"}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({apiKey:cgKey})});setMessage(response.ok?(save?"CoinGlass Key 已保存并请求重启采集器":"CoinGlass Heatmap 验证成功"):"CoinGlass 验证失败");}
  async function toggle(item:Preference){const enabled=!item.enabled;await fetch(`${publicApi}/api/settings/notifications/${item.event_type}`,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({enabled})});setPreferences(preferences.map((value)=>value.event_type===item.event_type?{...value,enabled}:value));}
  return <div className="pageGrid">
    <section className="panel"><div className="panelHead"><div><h2>市场数据密钥</h2><small>Binance USDⓈ-M 公开行情无需 API Key</small></div><span className={`tag ${status.coinglassConfigured?"":"orange"}`}>{status.coinglassConfigured?"COINGLASS READY":"COINGLASS NOT SET"}</span></div><div className="formGrid"><div className="field"><label>CoinGlass API Key</label><input type={showCoinglass?"text":"password"} value={cgKey} onChange={event=>setCgKey(event.target.value)} placeholder="••••••••••••••••"/></div><div className="toolbar"><button className="btn" onClick={()=>reveal("coinglass")}>显示现值</button><button className="btn" onClick={()=>coinglass(false)}>验证 Heatmap</button><button className="btn primary" onClick={()=>coinglass(true)}>验证并保存</button></div></div></section>
    <section className="panel"><div className="panelHead"><div><h2>Telegram</h2><small>密钥只写入本机 .env，不进入 PostgreSQL</small></div><span className={`tag ${status.telegramConfigured?"":"orange"}`}>{status.telegramConfigured?"CONFIGURED":"NOT SET"}</span></div><div className="formGrid"><div className="field"><label>Bot Token</label><input type={showTelegram?"text":"password"} value={token} onChange={event=>setToken(event.target.value)} placeholder="••••••••••••••••"/></div><div className="field"><label>固定 Chat ID</label><input type={showTelegram?"text":"password"} value={chatId} onChange={event=>setChatId(event.target.value)} placeholder="••••••••"/></div><div className="toolbar"><button className="btn" onClick={()=>reveal("telegram")}>显示现值</button><button className="btn" onClick={()=>action(false)}>发送测试</button><button className="btn primary" onClick={()=>action(true)}>验证并保存</button><span className="subtle">{message}</span></div></div></section>
    <section className="panel"><div className="panelHead"><h2>通知事件</h2><small>异常期间产生的新通知仍会直接丢弃</small></div><div className="notificationGrid">{preferences.map((item)=><label key={item.event_type} className="notificationToggle"><span>{labels[item.event_type]??item.event_type}</span><input type="checkbox" checked={item.enabled} onChange={()=>toggle(item)}/></label>)}</div></section>
  </div>;
}
