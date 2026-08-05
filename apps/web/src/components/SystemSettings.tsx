"use client";
import { useState } from "react";
import { publicApi } from "../lib/api";

type Preference={event_type:string;enabled:boolean};
const labels:Record<string,string>={signal:"策略信号触发",order_created:"订单创建成功",order_failed:"订单创建失败",entry_filled:"入场成交",closed_tp:"止盈关闭",closed_sl_or_liquidated:"止损关闭 / 强平",system_error:"系统异常",variational_session_lost:"Variational 登录失效",margin_pause_resume:"保证金暂停 / 恢复",service_recovered:"服务恢复"};

export function SystemSettings({status,initialPreferences}:{status:Record<string,unknown>;initialPreferences:Preference[]}){
  const [token,setToken]=useState(""),[chatId,setChatId]=useState("");
  const [showTelegram,setShowTelegram]=useState(false);
  const [message,setMessage]=useState(""),[preferences,setPreferences]=useState(initialPreferences);

  const [obe,setObe]=useState(""),[fingerprint,setFingerprint]=useState("");
  const [showCoinGlass,setShowCoinGlass]=useState(false);
  const [coinGlassMessage,setCoinGlassMessage]=useState("");

  async function reveal(){
    const response=await fetch(`${publicApi}/api/settings/secrets/telegram`);if(!response.ok){setMessage("读取本机密钥失败");return;}
    const body=await response.json();
    setToken(body.botToken??"");setChatId(body.chatId??"");setShowTelegram(true);
  }
  async function action(save:boolean){setMessage(save?"正在测试并保存…":"正在发送测试消息…");const response=await fetch(`${publicApi}/api/settings/telegram/${save?"save":"test"}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({botToken:token,chatId})});setMessage(response.ok?(save?"已保存并请求重启 Telegram Worker；重启结果见「密钥更新与服务重启」":"测试消息发送成功"):"验证失败，请检查 Token 与 Chat ID");}
  async function toggle(item:Preference){const enabled=!item.enabled;await fetch(`${publicApi}/api/settings/notifications/${item.event_type}`,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({enabled})});setPreferences(preferences.map((value)=>value.event_type===item.event_type?{...value,enabled}:value));}

  async function revealCoinGlass(){
    const response=await fetch(`${publicApi}/api/settings/secrets/coinglass`);if(!response.ok){setCoinGlassMessage("读取本机密钥失败");return;}
    const body=await response.json();
    setObe(body.obe??"");setFingerprint(JSON.stringify(body.browserHeaders??{}));setShowCoinGlass(true);
  }
  async function coinGlassAction(save:boolean){
    let browserHeaders:unknown={};
    if(fingerprint.trim()){
      try{browserHeaders=JSON.parse(fingerprint);}
      catch{setCoinGlassMessage("浏览器指纹不是合法 JSON");return;}
    }
    setCoinGlassMessage(save?"正在真实抓取 Heatmap 校验并保存…":"正在真实抓取 Heatmap 校验…");
    const response=await fetch(`${publicApi}/api/settings/coinglass/${save?"save":"test"}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({obe:obe.trim(),browserHeaders})});
    const body=await response.json().catch(()=>({}));
    if(!response.ok){setCoinGlassMessage(`验证失败：${body.message??body.error??"未知错误"}`);return;}
    setCoinGlassMessage(save
      ?`已保存并请求重启 CoinGlass Agent；校验抓到 ${body.regionCount} 个有效区域`
      :`校验成功：抓到 ${body.regionCount} 个有效区域（${body.url}）`);
  }

  return <div className="pageGrid">
    <section className="panel"><div className="panelHead"><div><h2>CoinGlass 免费网页版</h2><small>会话头与浏览器指纹只写入本机 .env；保存前先做一次真实 Heatmap 抓取</small></div><span className={`tag ${status.coinglassReady?"":"orange"}`}>{status.coinglassReady?"DATA READY":"WAITING"}</span></div>
      <div className="formGrid">
        <div className="field"><label>obe 会话头</label><input type={showCoinGlass?"text":"password"} value={obe} onChange={(event)=>setObe(event.target.value)} placeholder="部分非 BTC 币种需要；BTC 可留空"/></div>
        <div className="field"><label>浏览器指纹 · JSON</label><input type={showCoinGlass?"text":"password"} value={fingerprint} onChange={(event)=>setFingerprint(event.target.value)} placeholder='{"user-agent":"Mozilla/5.0 …","sec-ch-ua-platform":"\"macOS\""}'/></div>
        <div className="toolbar" style={{gridColumn:"1 / -1",flexWrap:"wrap"}}>
          <button className="btn" onClick={revealCoinGlass}>显示现值</button>
          <button className="btn" onClick={()=>coinGlassAction(false)}>测试抓取</button>
          <button className="btn primary" onClick={()=>coinGlassAction(true)}>验证并保存</button>
          <span className="subtle">{coinGlassMessage}</span>
        </div>
        <p className="subtle" style={{gridColumn:"1 / -1",margin:0}}>
          当前模式：{String(status.coinglassMode??"disabled")} · 会话头 {status.coinglassSessionConfigured?"已配置":"未配置"} · 指纹 {String(status.coinglassFingerprintCount??0)} 项。
          指纹只接受 accept-language、priority、sec-ch-ua、sec-ch-ua-mobile、sec-ch-ua-platform、sec-fetch-dest、sec-fetch-mode、sec-fetch-site、user-agent；也可继续用命令行 discover:har 从 HAR 批量导入。
        </p>
      </div>
    </section>
    <section className="panel"><div className="panelHead"><div><h2>Telegram</h2><small>密钥只写入本机 .env，不进入 PostgreSQL</small></div><span className={`tag ${status.telegramConfigured?"":"orange"}`}>{status.telegramConfigured?"CONFIGURED":"NOT SET"}</span></div><div className="formGrid"><div className="field"><label>Bot Token</label><input type={showTelegram?"text":"password"} value={token} onChange={event=>setToken(event.target.value)} placeholder="••••••••••••••••"/></div><div className="field"><label>固定 Chat ID</label><input type={showTelegram?"text":"password"} value={chatId} onChange={event=>setChatId(event.target.value)} placeholder="••••••••"/></div><div className="toolbar"><button className="btn" onClick={reveal}>显示现值</button><button className="btn" onClick={()=>action(false)}>发送测试</button><button className="btn primary" onClick={()=>action(true)}>验证并保存</button><span className="subtle">{message}</span></div></div></section>
    <section className="panel"><div className="panelHead"><h2>通知事件</h2><small>异常期间产生的新通知仍会直接丢弃</small></div><div className="notificationGrid">{preferences.map((item)=><label key={item.event_type} className="notificationToggle"><span>{labels[item.event_type]??item.event_type}</span><input type="checkbox" checked={item.enabled} onChange={()=>toggle(item)}/></label>)}</div></section>
  </div>;
}
