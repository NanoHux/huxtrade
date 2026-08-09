"use client";
import { useState } from "react";
import { publicApi } from "../lib/api";

type Preference={event_type:string;enabled:boolean};
const labels:Record<string,string>={signal:"策略信号触发",order_created:"订单创建成功",order_failed:"订单创建失败",entry_filled:"入场成交",closed_tp:"止盈关闭",closed_sl_or_liquidated:"止损关闭 / 强平",closed_reversed:"反向信号平仓",system_error:"系统异常",variational_session_lost:"Variational 登录失效",margin_pause_resume:"保证金暂停 / 恢复",service_recovered:"服务恢复",asset_resumed:"币种自动恢复监控"};

export function SystemSettings({status,initialPreferences}:{status:Record<string,unknown>;initialPreferences:Preference[]}){
  const [token,setToken]=useState(""),[chatId,setChatId]=useState("");
  const [showTelegram,setShowTelegram]=useState(false);
  const [message,setMessage]=useState(""),[preferences,setPreferences]=useState(initialPreferences);

  const [coinGlassMessage,setCoinGlassMessage]=useState("");
  const [variationalMessage,setVariationalMessage]=useState(""),[variationalBusy,setVariationalBusy]=useState(false);

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
      setMessage(response.ok?(save?"已保存并请求重启 Telegram Worker；重启结果见「密钥更新与服务重启」":"测试消息发送成功"):`验证失败：${body.message??body.error??"请检查 Token 与 Chat ID"}`);
    }catch(error){
      setMessage(`请求失败：${error instanceof Error?error.message:String(error)}`);
    }
  }
  async function toggle(item:Preference){const enabled=!item.enabled;await fetch(`${publicApi}/api/settings/notifications/${item.event_type}`,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({enabled})});setPreferences(preferences.map((value)=>value.event_type===item.event_type?{...value,enabled}:value));}

  async function testCoinGlass(){
    setCoinGlassMessage("正在请求 CoinGlass Agent 真实抓取…");
    const response=await fetch(`${publicApi}/api/settings/coinglass/test`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({})});
    const body=await response.json().catch(()=>({}));
    if(!response.ok){setCoinGlassMessage(`测试失败：${body.message??body.error??"未知错误"}`);return;}
    setCoinGlassMessage(`测试成功：抓到 ${body.regionCount} 个有效区域（${body.url}）`);
  }

  async function reopenVariationalBrowser(){
    setVariationalBusy(true);setVariationalMessage("正在重启 variational-agent，它会自动重新打开 Chrome 窗口…");
    try{
      const response=await fetch(`${publicApi}/api/settings/variational/reopen-browser`,{method:"POST"});
      const body=await response.json().catch(()=>({}));
      if(!response.ok){setVariationalMessage(`请求失败：${body.message??body.error??"未知错误"}`);return;}
      setVariationalMessage("已请求，几秒内会弹出一个新的 Chrome 窗口（用的是同一个登录态）；重启结果见下方「密钥更新与服务重启」。");
    }catch(error){
      setVariationalMessage(`请求失败：${error instanceof Error?error.message:String(error)}`);
    }finally{
      setVariationalBusy(false);
    }
  }

  return <div className="pageGrid">
    <section className="panel"><div className="panelHead"><div><h2>CoinGlass 免费网页版</h2><small>登录态保存在 coinglass-agent 自己打开的 Chrome Profile 里，不经过本页面</small></div><span className={`tag ${status.coinglassReady?"":"orange"}`}>{status.coinglassReady?"DATA READY":"WAITING"}</span></div>
      <div className="formGrid">
        <div className="toolbar" style={{gridColumn:"1 / -1",flexWrap:"wrap"}}>
          <button className="btn primary" onClick={testCoinGlass}>重新测试</button>
          <span className="subtle">{coinGlassMessage}</span>
        </div>
        <p className="subtle" style={{gridColumn:"1 / -1",margin:0}}>
          当前模式：{String(status.coinglassMode??"disabled")}{status.coinglassError?` · ${String(status.coinglassError)}`:""}。
          页面本身不解密 Heatmap——coinglass-agent 打开一个真实 Chrome 窗口访问 CoinGlass 网页，由页面自己完成解密，Agent 只读取结果；若显示 WAITING，请在该窗口里登录一次 CoinGlass 账号（`COINGLASS_ADAPTER_MODE=browser`，可选 `COINGLASS_CDP_URL` 复用已打开的调试端口），登录后点击「重新测试」。
        </p>
      </div>
    </section>
    <section className="panel"><div className="panelHead"><div><h2>Variational 浏览器窗口</h2><small>登录态保存在 variational-agent 自己打开的 Chrome Profile 里，不经过本页面</small></div></div>
      <div className="formGrid">
        <div className="toolbar" style={{gridColumn:"1 / -1",flexWrap:"wrap"}}>
          <button className="btn primary" disabled={variationalBusy} onClick={reopenVariationalBrowser}>重新打开 Variational 浏览器</button>
          <span className="subtle">{variationalMessage}</span>
        </div>
        <p className="subtle" style={{gridColumn:"1 / -1",margin:0}}>
          agent 检测到这个窗口崩溃或被关闭时，下一次轮询（最多 30 秒内）会自动用同一份登录态重新打开，通常不用管；这个按钮是想立刻重开时用的手动入口。重新打开后如果卡在登录页，说明登录态本身失效了，需要在弹出的窗口里手动登录一次。
        </p>
      </div>
    </section>
    <section className="panel"><div className="panelHead"><div><h2>Telegram</h2><small>密钥只写入本机 .env，不进入 PostgreSQL</small></div><span className={`tag ${status.telegramConfigured?"":"orange"}`}>{status.telegramConfigured?"CONFIGURED":"NOT SET"}</span></div><div className="formGrid"><div className="field"><label>Bot Token</label><input type={showTelegram?"text":"password"} value={token} onChange={event=>setToken(event.target.value)} placeholder="••••••••••••••••"/></div><div className="field"><label>固定 Chat ID</label><input type={showTelegram?"text":"password"} value={chatId} onChange={event=>setChatId(event.target.value)} placeholder="••••••••"/></div><div className="toolbar"><button className="btn" onClick={reveal}>显示现值</button><button className="btn" onClick={()=>action(false)}>发送测试</button><button className="btn primary" onClick={()=>action(true)}>验证并保存</button><span className="subtle">{message}</span></div></div></section>
    <section className="panel"><div className="panelHead"><h2>通知事件</h2><small>异常期间产生的新通知仍会直接丢弃</small></div><div className="notificationGrid">{preferences.map((item)=><label key={item.event_type} className="notificationToggle"><span>{labels[item.event_type]??item.event_type}</span><input type="checkbox" checked={item.enabled} onChange={()=>toggle(item)}/></label>)}</div></section>
  </div>;
}
