"use client";
import { useState } from "react";
import type { EntryPlanRow, RestingOrderRow, RestingStats } from "../app/resting/page";

const num=(value:number|string|null|undefined,digits=4)=>value==null||value===""?"—":Number(value).toFixed(digits);
const age=(minutes:number)=>minutes<60?`${Math.round(minutes)} 分钟`:`${(minutes/60).toFixed(1)} 小时`;
const clock=(value:string|null)=>value?new Date(value).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai",hour12:false}):"—";
// KEEP is the load-bearing decision, so it gets a neutral tag rather than
// disappearing into the same grey as NONE.
const decisionTag:Record<string,string>={PLACE:"",REPLACE:"orange",CANCEL:"orange",CLOSE_OPPOSITE:"danger",KEEP:"",NONE:"muted"};

export function RestingBoard({orders,plans,total,stats}:{orders:RestingOrderRow[];plans:EntryPlanRow[];total:number;stats:RestingStats}){
  const [decision,setDecision]=useState("");
  const [mode,setMode]=useState("");
  const visible=plans.filter((plan)=>(!decision||plan.decision===decision)&&(!mode||plan.mode===mode));
  const shadowRows=stats.ledger.filter((row)=>row.mode==="shadow").reduce((sum,row)=>sum+row.count,0);
  const liveRows=stats.ledger.filter((row)=>row.mode==="live").reduce((sum,row)=>sum+row.count,0);

  return <div className="pageGrid">
    <section className="panel">
      <div className="panelHead">
        <div><h2>工作挂单</h2><small>虚拟单只存在本地，价格到位并经两根 5 分钟收线确认后才发到平台；每 15 分钟重新校验</small></div>
        <div className="toolbar">
          <span className="tag orange">{orders.filter((order)=>order.awaitingTrigger).length} 虚拟</span>
          <span className="tag">{orders.filter((order)=>!order.awaitingTrigger).length} 已挂平台</span>
        </div>
      </div>
      <table><thead><tr><th>币种</th><th>状态</th><th>方向</th><th>入场价</th><th>市价</th><th>距市价</th><th>RR</th><th>来源</th><th>挂龄</th><th>最近校验</th><th>止损 / 止盈</th></tr></thead>
      <tbody>{orders.map((order)=><tr key={order.id}>
        <td><a href={order.variationalUrl} target="_blank" rel="noreferrer"><b>{order.code}</b></a></td>
        <td>{order.awaitingTrigger
          ? <span className="tag orange" title={order.triggerTouchedAt?`价格已于 ${clock(order.triggerTouchedAt)} 触及，等待两根 5 分钟收线确认`:"等待价格到达入场价"}>
              {order.triggerTouchedAt?"确认中":"等待到价"}
            </span>
          : <span className="tag">平台挂单</span>}</td>
        <td><span className={`tag ${order.direction==="LONG"?"":"orange"}`}>{order.direction}</span></td>
        <td className="mono">{num(order.level)}</td>
        <td className="mono">{num(order.marketPrice)}</td>
        <td className="mono">{order.distanceAtr==null?"—":`${order.distanceAtr.toFixed(2)} ATR`}{order.distancePercent==null?"":` · ${order.distancePercent.toFixed(2)}%`}</td>
        <td className="mono">{order.expectedRiskReward==null?"—":order.expectedRiskReward.toFixed(2)}</td>
        <td className="mono">{order.sources.length?order.sources.join("+"):"—"}</td>
        <td>{age(order.ageMinutes)}</td>
        <td title={order.lastDecisionReason??""}>{clock(order.revalidatedAt)}</td>
        <td className="mono">{num(order.stopLoss)} / {num(order.takeProfit)}</td>
      </tr>)}
      {!orders.length&&<tr><td colSpan={11} className="empty">当前没有工作挂单</td></tr>}</tbody></table>
    </section>

    <section className="panel">
      <div className="panelHead"><div><h2>影子对照</h2><small>影子 {shadowRows} 行 · 实盘 {liveRows} 行</small></div></div>
      <div className="statGrid">
        <div className="stat"><small>挂出次数</small><b>{stats.placed}</b></div>
        <div className="stat"><small>成交单数</small><b>{stats.filled}</b></div>
        <div className="stat"><small>成交率</small><b>{(stats.fillRate*100).toFixed(1)}%</b></div>
      </div>
      <table><thead><tr><th>退出原因</th><th>笔数</th><th>平均实现 RR</th><th>平均入场距离 · ATR</th></tr></thead>
      <tbody>{stats.byExit.map((row)=><tr key={row.state}>
        <td><span className={`tag ${row.state==="CLOSED_TP"?"":"orange"}`}>{row.state}</span></td>
        <td className="mono">{row.count}</td>
        <td className="mono">{row.averageRealizedRiskReward==null?"—":row.averageRealizedRiskReward.toFixed(2)}</td>
        <td className="mono">{row.averageEntryDistanceAtr==null?"—":row.averageEntryDistanceAtr.toFixed(2)}</td>
      </tr>)}
      {!stats.byExit.length&&<tr><td colSpan={4} className="empty">还没有已平仓的驻留单</td></tr>}</tbody></table>
    </section>

    <section className="panel">
      <div className="panelHead"><div><h2>决策账本</h2><small>每币每次扫描一行，含 KEEP 与 NONE——「刻意没动」也是观测</small></div><span className="tag">共 {total} 行</span></div>
      <div className="toolbar">
        <select value={decision} onChange={(event)=>setDecision(event.target.value)}><option value="">全部决策</option>{["PLACE","KEEP","REPLACE","CANCEL","CLOSE_OPPOSITE","NONE"].map((value)=><option key={value}>{value}</option>)}</select>
        <select value={mode} onChange={(event)=>setMode(event.target.value)}><option value="">全部模式</option><option value="shadow">shadow</option><option value="live">live</option></select>
      </div>
      <table><thead><tr><th>收盘</th><th>币种</th><th>决策</th><th>模式</th><th>方向</th><th>挂单价</th><th>RR</th><th>理由</th></tr></thead>
      <tbody>{visible.map((plan)=><tr key={plan.id}>
        <td className="mono">{clock(plan.closed_at)}</td>
        <td><b>{plan.code}</b></td>
        <td><span className={`tag ${decisionTag[plan.decision]??""}`}>{plan.decision}</span></td>
        <td>{plan.mode}</td>
        <td>{plan.direction??"—"}</td>
        <td className="mono">{num(plan.level)}</td>
        <td className="mono">{num(plan.expected_rr,2)}</td>
        <td className="subtle">{plan.decision_reason}</td>
      </tr>)}
      {!visible.length&&<tr><td colSpan={8} className="empty">没有匹配的决策记录</td></tr>}</tbody></table>
    </section>
  </div>;
}
