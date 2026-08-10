"use client";
import { useState } from "react";
import type { ConditionType,RestingEntrySettings,Strategy } from "@huxtrade/shared-types";
import { publicApi } from "../lib/api";

const all:ConditionType[]=["OI","CVD","FUNDING","HEATMAP"];
// Mirrors fixedRules.restingEntry. The API always returns resolved values, so
// this only seeds the "create strategy" form before anything comes back.
const restingDefaults:RestingEntrySettings={
  entryBandAtrMin:0.3,entryBandAtrMax:2.5,entryOffsetAtr:0.1,confluenceMergeAtr:0.35,
  replaceThresholdAtr:0.25,biasPersistenceScans:4,flipConfirmationScans:2,maxArmedAssets:15,swingScore:0.55,emaScore:0.3,incumbentScoreBonus:0.5,extremeMoveBlockPercent:15,lossStreakCount:3,lossStreakWindowHours:6,lossStreakHaltHours:12,
  scaleOutTriggerR:0.5,scaleOutFraction:0.5,scaleOutMinStopPercent:0.8,breakevenOffsetR:0.05,minStopSpreadMultiple:4,structuralRejectionLimit:3,structuralBackoffHours:6,takeProfitRiskReward:2,virtualEntryConfirmation:1,virtualEntryIntervalMinutes:5
};
const restingFields:Array<{key:keyof RestingEntrySettings;label:string;hint:string;step:number;min:number;max:number}>=[
  {key:"maxArmedAssets",label:"同时武装币数上限",hint:"超出按信号强度取前 N，只统计可交易的币",step:1,min:1,max:120},
  {key:"biasPersistenceScans",label:"方向偏置持续扫描数",hint:"4 个扫描 = 1 小时",step:1,min:1,max:96},
  {key:"flipConfirmationScans",label:"反转确认次数",hint:"反方向需连续主张几次才真正翻转并平仓",step:1,min:1,max:12},
  {key:"entryBandAtrMin",label:"入场带近端 · ATR",hint:"太近没有执行优势",step:0.05,min:0.05,max:3},
  {key:"entryBandAtrMax",label:"入场带远端 · ATR",hint:"太远永不成交且结构陈旧",step:0.05,min:0.2,max:8},
  {key:"entryOffsetAtr",label:"结构位前置偏移 · ATR",hint:"抢在扫流动性反转前成交",step:0.05,min:0,max:1},
  {key:"confluenceMergeAtr",label:"候选合并距离 · ATR",hint:"更近的候选视为同一结构并加分",step:0.05,min:0.05,max:2},
  {key:"replaceThresholdAtr",label:"重挂滞后带 · ATR",hint:"小于此幅度不动挂单，防 churn",step:0.05,min:0.05,max:2},
  {key:"swingScore",label:"摆动点权重",hint:"热区按区域百分位计分",step:0.05,min:0.01,max:5},
  {key:"emaScore",label:"EMA 权重",hint:"三者中应最低",step:0.05,min:0.01,max:5},
  {key:"incumbentScoreBonus",label:"在位加成",hint:"现有挂单的结构位加分,防止候选簇之间来回跳",step:0.05,min:0,max:5},
  {key:"extremeMoveBlockPercent",label:"极端行情拒同向 · %",hint:"24h 涨超此值不做空、跌超此值不做多,0 为关闭",step:1,min:0,max:200},
  {key:"lossStreakCount",label:"连败熔断笔数",hint:"同方向亏损止损达到几笔就停止武装该方向,0 为关闭",step:1,min:0,max:20},
  {key:"lossStreakWindowHours",label:"连败统计窗口 · 小时",hint:"往回数这么久之内的亏损止损",step:0.5,min:0.25,max:72},
  {key:"lossStreakHaltHours",label:"熔断持续 · 小时",hint:"触发后该方向停止武装多久",step:1,min:0.25,max:168},
  {key:"scaleOutTriggerR",label:"分批止盈触发 · R",hint:"浮盈达到几倍止损宽度时平掉一部分,0 为关闭",step:0.1,min:0,max:5},
  {key:"scaleOutFraction",label:"分批止盈比例",hint:"触发时平掉的仓位占比,上限 0.9——全平就不是分批而是换了个近止盈",step:0.05,min:0,max:0.9},
  {key:"scaleOutMinStopPercent",label:"分批止盈最小止损宽度 · %",hint:"止损比这更窄就跳过,点差会吃掉利润",step:0.1,min:0,max:5},
  {key:"breakevenOffsetR",label:"保本止损让利 · R",hint:"保本位比入场价多留这么多,用来覆盖平仓点差",step:0.01,min:0,max:0.5}
];
const blank={name:"",enabled:false,logic:"AND" as "AND"|"N_OF_M",requiredCount:2,conditions:[...all] as ConditionType[],heatmapRange:"24h" as Strategy["heatmapRange"],maxOrdersPerSide:5,entryKind:"MARKET_ON_SIGNAL" as Strategy["entryKind"],restingEntry:restingDefaults};

export function StrategyManager({initial}:{initial:Strategy[]}){
  const [items,setItems]=useState(initial);const [message,setMessage]=useState("");const [editingId,setEditingId]=useState<string|null>(null);const [form,setForm]=useState(blank);
  function toggleCondition(condition:ConditionType){setForm({...form,conditions:form.conditions.includes(condition)?form.conditions.filter((value)=>value!==condition):[...form.conditions,condition]});}
  function edit(strategy:Strategy){setEditingId(strategy.id);setForm({name:strategy.name,enabled:strategy.enabled,logic:strategy.logic,requiredCount:strategy.requiredCount??2,conditions:[...strategy.conditions],heatmapRange:strategy.heatmapRange,maxOrdersPerSide:strategy.maxOrdersPerSide,entryKind:strategy.entryKind??"MARKET_ON_SIGNAL",restingEntry:{...restingDefaults,...strategy.restingEntry}});setMessage("编辑运行中的策略会撤销其未成交限价单");}
  function setResting(key:keyof RestingEntrySettings,value:string){setForm({...form,restingEntry:{...form.restingEntry,[key]:Number(value)}});}
  function reset(){setEditingId(null);setForm(blank);}
  async function submit(event:React.FormEvent){event.preventDefault();if(form.restingEntry.entryBandAtrMin>=form.restingEntry.entryBandAtrMax){setMessage("入场带近端必须小于远端，否则不会有任何候选入场位");return;}const response=await fetch(`${publicApi}/api/strategies${editingId?`/${editingId}`:""}`,{method:editingId?"PATCH":"POST",headers:{"content-type":"application/json"},body:JSON.stringify(form)});const body=await response.json();if(!response.ok){setMessage(`保存失败：${body.message??body.error}`);return;}setItems(editingId?items.map((item)=>item.id===editingId?body:form.enabled?{...item,enabled:false}:item):form.enabled?[...items.map((item)=>({...item,enabled:false})),body]:[...items,body]);setMessage("策略已保存");reset();}
  async function enable(id:string){await fetch(`${publicApi}/api/strategies/${id}/enable`,{method:"POST"});setItems(items.map((item)=>({...item,enabled:item.id===id})));}
  async function remove(strategy:Strategy){if(!window.confirm(`确认删除策略 ${strategy.name}？`))return;const response=await fetch(`${publicApi}/api/strategies/${strategy.id}`,{method:"DELETE"});if(response.ok){setItems(items.filter((item)=>item.id!==strategy.id));setMessage("策略已删除");}else{const body=await response.json();setMessage(body.message??"删除失败");}}
  return <div className="pageGrid">
    <section className="panel"><div className="panelHead"><div><h2>{editingId?"编辑确定性策略":"创建确定性策略"}</h2><small>每类条件最多一次；做空方向由系统镜像</small></div>{editingId&&<button className="btn" onClick={reset}>取消编辑</button>}</div>
      <form className="formGrid" onSubmit={submit}><div className="field"><label>策略名称</label><input required value={form.name} onChange={(event)=>setForm({...form,name:event.target.value})} placeholder="Core Four-Factor"/></div><div className="field"><label>组合逻辑</label><select value={form.logic} onChange={(event)=>setForm({...form,logic:event.target.value as "AND"|"N_OF_M"})}><option value="AND">全部满足 · AND</option><option value="N_OF_M">至少 N 个满足</option></select></div><div className="field"><label>Heatmap 周期</label><select value={form.heatmapRange} onChange={(event)=>setForm({...form,heatmapRange:event.target.value as Strategy["heatmapRange"]})}>{["12h","24h","3d","7d","30d"].map((value)=><option key={value}>{value}</option>)}</select></div><div className="field"><label>同币同方向综合上限</label><input type="number" min="1" max="20" value={form.maxOrdersPerSide} onChange={(event)=>setForm({...form,maxOrdersPerSide:Number(event.target.value)})}/></div><div className="field"><label>条件 · 选择 2–4 项</label><div className="checkboxes">{all.map((condition)=><label key={condition}><input type="checkbox" checked={form.conditions.includes(condition)} onChange={()=>toggleCondition(condition)}/>{condition}</label>)}</div></div>{form.logic==="N_OF_M"&&<div className="field"><label>N</label><input type="number" min="2" max={form.conditions.length} value={form.requiredCount} onChange={(event)=>setForm({...form,requiredCount:Number(event.target.value)})}/></div>}<div className="field"><label>入场模型</label><select value={form.entryKind} onChange={(event)=>setForm({...form,entryKind:event.target.value as Strategy["entryKind"]})}><option value="MARKET_ON_SIGNAL">信号即市价入场 · 现行</option><option value="RESTING_LIMIT">驻留限价入场</option></select><small className="subtle">切回市价入场即为回退；影子账本两种模型下都会记录</small></div><div className="field" style={{gridColumn:"1 / -1"}}><label>驻留限价入场参数</label><small className="subtle">距离一律以 1h ATR 为单位，所以在每个币上含义一致。每币最多 1 个工作挂单是规格红线，不可配置。</small><div className="formGrid">{restingFields.map((field)=><div className="field" key={field.key}><label>{field.label}</label><input type="number" step={field.step} min={field.min} max={field.max} value={form.restingEntry[field.key]} onChange={(event)=>setResting(field.key,event.target.value)}/><small className="subtle">{field.hint}</small></div>)}</div></div><div className="checkboxes"><label><input type="checkbox" checked={form.enabled} onChange={(event)=>setForm({...form,enabled:event.target.checked})}/> 保存后立即成为唯一运行策略</label></div><div className="toolbar"><button className="btn primary">{editingId?"更新策略":"保存策略"}</button><span className="subtle">{message}</span></div></form>
    </section>
    <section className="panel"><div className="panelHead"><h2>策略库</h2><small>同时只运行一套</small></div><table><thead><tr><th>策略</th><th>逻辑</th><th>条件</th><th>Heatmap</th><th>入场模型</th><th>订单上限</th><th>武装上限</th><th>入场带 · ATR</th><th>状态</th><th>操作</th></tr></thead><tbody>{items.map((strategy)=><tr key={strategy.id}><td><b>{strategy.name}</b></td><td>{strategy.logic==="AND"?"AND":`${strategy.requiredCount} / ${strategy.conditions.length}`}</td><td className="mono">{strategy.conditions.join(" · ")}</td><td><span className={`tag ${strategy.entryKind==="RESTING_LIMIT"?"":"muted"}`}>{strategy.entryKind==="RESTING_LIMIT"?"驻留限价":"市价"}</span></td><td>{strategy.maxOrdersPerSide}</td><td>{strategy.restingEntry?.maxArmedAssets??restingDefaults.maxArmedAssets}</td><td className="mono">{strategy.restingEntry?.entryBandAtrMin??restingDefaults.entryBandAtrMin} – {strategy.restingEntry?.entryBandAtrMax??restingDefaults.entryBandAtrMax}</td><td><span className={`tag ${strategy.enabled?"":"orange"}`}>{strategy.enabled?"RUNNING":"STOPPED"}</span></td><td><div className="toolbar"><button className="btn" onClick={()=>edit(strategy)}>编辑</button>{!strategy.enabled&&<button className="btn primary" onClick={()=>enable(strategy.id)}>启用</button>}<button className="btn danger" disabled={strategy.enabled} onClick={()=>remove(strategy)}>删除</button></div></td></tr>)}{!items.length&&<tr><td colSpan={10} className="empty">尚未创建策略</td></tr>}</tbody></table></section>
  </div>;
}
