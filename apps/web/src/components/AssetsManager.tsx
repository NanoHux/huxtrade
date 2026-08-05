"use client";
import { useState } from "react";
import type { Asset } from "@huxtrade/shared-types";
import { publicApi } from "../lib/api";

const emptyForm={code:"",binanceSymbol:"",coinglassUrl:"",variationalUrl:"",collectEnabled:true,signalEnabled:true,tradeEnabled:false};

export function AssetsManager({initial}:{initial:Asset[]}){
  const [assets,setAssets]=useState(initial);
  const [message,setMessage]=useState("");
  const [editingId,setEditingId]=useState<string|null>(null);
  const [form,setForm]=useState(emptyForm);
  function edit(asset:Asset){setEditingId(asset.id);setForm({code:asset.code,binanceSymbol:asset.binanceSymbol,coinglassUrl:asset.coinglassUrl,variationalUrl:asset.variationalUrl,collectEnabled:asset.collectEnabled,signalEnabled:asset.signalEnabled,tradeEnabled:asset.tradeEnabled});setMessage("正在编辑，保存时会重新校验变更的数据映射");}
  function reset(){setEditingId(null);setForm(emptyForm);}
  /** Spec 4.2: prove both data sources before the record is created. */
  async function validate(){
    if(!form.binanceSymbol||!form.coinglassUrl){setMessage("请先填写内部代码与 CoinGlass Heatmap URL");return;}
    setMessage("正在真实校验 Binance 合约与 CoinGlass Heatmap…");
    const response=await fetch(`${publicApi}/api/assets/validate`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({binanceSymbol:form.binanceSymbol,coinglassUrl:form.coinglassUrl})});
    const body=await response.json().catch(()=>({}));
    if(!response.ok){setMessage(`校验未通过：Binance ${body.binanceOk?"正常":"无效"} · CoinGlass ${body.coinglassOk?"正常":body.heatmapError??"无效"}`);return;}
    setMessage(`校验通过：CoinGlass 抓到 ${body.regionCount} 个有效区域（${new Date(body.capturedAt).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai"})}）`);
  }
  async function submit(event:React.FormEvent){
    event.preventDefault();setMessage("正在校验 Binance 与 CoinGlass 页面链接…");
    const response=await fetch(`${publicApi}/api/assets${editingId?`/${editingId}`:""}`,{method:editingId?"PATCH":"POST",headers:{"content-type":"application/json"},body:JSON.stringify(form)});
    const body=await response.json();
    if(!response.ok){setMessage(`保存失败：${body.message??body.error}`);return;}
    setAssets(editingId?assets.map((asset)=>asset.id===editingId?body:asset):[...assets,body]);setMessage("已保存；Binance 映射与首份 CoinGlass Heatmap 已完成真实校验");reset();
  }
  async function pause(asset:Asset){await fetch(`${publicApi}/api/control/assets/${asset.id}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({paused:!asset.paused,reason:!asset.paused?"Dashboard manual pause":null})});setAssets(assets.map((item)=>item.id===asset.id?{...item,paused:!item.paused,pauseReason:!item.paused?"Dashboard manual pause":null}:item));}
  async function remove(asset:Asset){if(!window.confirm(`确认删除 ${asset.code}？有信号或订单历史时系统会拒绝删除。`))return;const response=await fetch(`${publicApi}/api/assets/${asset.id}`,{method:"DELETE"});if(response.ok){setAssets(assets.filter((item)=>item.id!==asset.id));setMessage(`${asset.code} 已删除`);}else{const body=await response.json();setMessage(body.message??"删除失败");}}
  return <div className="pageGrid">
    <section className="panel"><div className="panelHead"><div><h2>{editingId?"编辑白名单币种":"新增白名单币种"}</h2><small>Binance 合约自动识别；CoinGlass 使用你粘贴的 Model 1 Pair Heatmap 链接</small></div>{editingId&&<button className="btn" onClick={reset}>取消编辑</button>}</div>
      <form onSubmit={submit} className="formGrid"><div className="field"><label>内部代码</label><input required value={form.code} onChange={(event)=>{const code=event.target.value.toUpperCase();setForm({...form,code,binanceSymbol:`${code}USDT`});}} placeholder="BTC"/></div><div className="field"><label>Binance Symbol · 自动识别</label><input required readOnly value={form.binanceSymbol} placeholder="BTCUSDT"/></div><div className="field"><label>CoinGlass Heatmap URL</label><input required type="url" value={form.coinglassUrl} onChange={(event)=>setForm({...form,coinglassUrl:event.target.value})} placeholder="https://www.coinglass.com/pro/futures/LiquidationHeatMap?coin=BTC&type=pair"/></div><div className="field"><label>Variational 市场 URL</label><input required type="url" value={form.variationalUrl} onChange={(event)=>setForm({...form,variationalUrl:event.target.value})} placeholder="https://omni.variational.io/perpetual/BTC"/></div><div className="checkboxes"><label><input type="checkbox" checked={form.collectEnabled} onChange={(event)=>setForm({...form,collectEnabled:event.target.checked})}/> 采集</label><label><input type="checkbox" checked={form.signalEnabled} onChange={(event)=>setForm({...form,signalEnabled:event.target.checked})}/> 信号</label><label><input type="checkbox" checked={form.tradeEnabled} onChange={(event)=>setForm({...form,tradeEnabled:event.target.checked})}/> 交易</label></div><div className="toolbar"><button className="btn" type="button" onClick={validate}>先校验数据源</button><button className="btn primary">{editingId?"校验并更新":"自动识别、校验并保存"}</button><span className="subtle">{message}</span></div></form>
    </section>
    <section className="panel"><div className="panelHead"><h2>白名单 · {assets.length}/50</h2><small>数据异常后只允许手动恢复</small></div><table><thead><tr><th>代码</th><th>数据映射</th><th>采集/信号/交易</th><th>连接 / 状态</th><th>最后更新</th><th>原因</th><th>操作</th></tr></thead><tbody>{assets.map((asset)=><tr key={asset.id}><td><b>{asset.code}</b></td><td className="mono">{asset.binanceSymbol}<br/><span className="subtle">CG · {asset.coinglassSymbol}</span></td><td>{[asset.collectEnabled,asset.signalEnabled,asset.tradeEnabled].map((value)=>value?"●":"○").join("  ")}</td><td><span className={`tag ${asset.connectionStatus==="ERROR"?"red":asset.connectionStatus!=="CONNECTED"?"orange":""}`}>{asset.connectionStatus??"PENDING"}</span><br/><span className={`tag ${asset.paused?"red":""}`}>{asset.paused?"PAUSED":"ACTIVE"}</span></td><td className="subtle">{asset.lastUpdatedAt?new Date(asset.lastUpdatedAt).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai"}):"—"}</td><td className="subtle">{asset.pauseReason??"—"}</td><td><div className="toolbar"><button className="btn" onClick={()=>edit(asset)}>编辑</button><button className={asset.paused?"btn primary":"btn"} onClick={()=>pause(asset)}>{asset.paused?"手动恢复":"暂停"}</button><button className="btn danger" onClick={()=>remove(asset)}>删除</button></div></td></tr>)}{!assets.length&&<tr><td colSpan={7} className="empty">尚未配置白名单币种</td></tr>}</tbody></table></section>
  </div>;
}
