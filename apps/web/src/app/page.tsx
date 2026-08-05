import { Header } from "../components/Header";
import { MarketChart } from "../components/MarketChart";
import { QuickControls } from "../components/QuickControls";
import { api } from "../lib/api";
import type { DashboardSnapshot } from "@huxtrade/shared-types";

export const dynamic="force-dynamic";
const fallback:DashboardSnapshot={generatedAt:new Date().toISOString(),liveTradingEnabled:false,globalPaused:false,btcRegime:"TRANSITION",marginUsagePercent:0,balanceUsdc:0,variationalLoggedIn:false,variationalReconciled:false,assets:[],services:[],orders:[],openOrders:[],openPositions:[],stats:{signals:0,orders:0,fills:0,fillRate:0,winRate:0,realizedPnl:0}};
const fmt=(value:number|null|undefined,digits=1)=>value==null?"—":Number(value).toLocaleString("zh-CN",{maximumFractionDigits:digits});
const time=(value:string|null|undefined)=>value?new Date(value).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai"}):"—";

export default async function Dashboard(){
  const data=await api("/api/dashboard",fallback);
  const chartSymbols=data.assets.map((asset)=>asset.binanceSymbol).filter(Boolean);
  return <>
    <Header eyebrow="Trading Operations" title="市场与执行总览"/>
    {!data.liveTradingEnabled&&<div className="alertStrip"><div><strong>真实下单安全门已关闭</strong> <span>· 完成 Variational 协议发现与对账验证前，信号只记录、不提交。</span></div></div>}
    <QuickControls globalPaused={data.globalPaused} assets={data.assets}/>
    <section className="grid4">
      <div className="metric"><label>BTC 市场状态</label><b className="warn">{data.btcRegime}</b><small>日线 {data.btcContext?.dailyDirection??"—"} · 4H {data.btcContext?.fourHourConfirmation??"—"} · ADX {data.btcContext?.adxState??"—"} {data.btcContext?.adx==null?"":fmt(data.btcContext.adx,1)}</small></div>
      <div className="metric"><label>账户余额</label><b>{fmt(data.balanceUsdc,2)}</b><small>USDC · 会话 {data.variationalLoggedIn?"有效":"无效"} · 对账 {data.variationalReconciled?"完成":"未完成"}</small></div>
      <div className="metric"><label>保证金占用</label><b className={data.marginUsagePercent>=80?"down":"up"}>{fmt(data.marginUsagePercent)}%</b><small>暂停 80% · 恢复 75%</small></div>
      <div className="metric"><label>已实现盈亏</label><b className={data.stats.realizedPnl>=0?"up":"down"}>{fmt(data.stats.realizedPnl,2)}</b><small>USDC · 全部策略</small></div>
    </section>
    <section className="contentGrid">
      <div className="panel"><div className="panelHead"><div><h2>K 线 · 15分钟</h2><small>信号、限价入场、TP、SL 与 Heatmap 目标区域</small></div><span className="tag">BINANCE PERP</span></div><MarketChart symbols={chartSymbols}/></div>
      <div className="panel"><div className="panelHead"><h2>系统健康</h2><small>{data.services.filter((service)=>service.state==="healthy").length}/{data.services.length} 正常</small></div><div className="healthList">{data.services.length?data.services.map((service)=><div className="healthRow" key={service.service}><span className={`dot ${service.state}`}/><div>{service.service}<small>{service.error?` · ${service.error.slice(0,34)}`:" · 最近运行正常"}</small></div><span className={service.blocksTrading?"warn":"up"}>{service.blocksTrading?"阻断":"正常"}</span></div>):<div className="empty">等待 Worker 上报状态</div>}</div></div>
    </section>

    <section className="panel"><div className="panelHead"><div><h2>未成交订单</h2><small>UNKNOWN / 待对账订单继续占用同币同方向上限</small></div><span className="subtle">{data.openOrders.length} 笔占用中</span></div>
      <table><thead><tr><th>币种</th><th>方向</th><th>状态</th><th>入场</th><th>TP</th><th>SL</th><th>保证金</th><th>更新时间</th><th>处理</th></tr></thead>
        <tbody>{data.openOrders.map((order)=>
          <tr key={order.id}><td><b>{order.code}</b></td><td className={order.direction==="LONG"?"up":"down"}>{order.direction}</td>
            <td><span className={`tag ${["UNKNOWN","RECONCILIATION_REQUIRED"].includes(order.state)?"orange":""}`}>{order.state}</span></td>
            <td className="mono">{fmt(order.entryPrice,6)}</td><td className="mono up">{fmt(order.takeProfit,6)}</td><td className="mono down">{fmt(order.stopLoss,6)}</td>
            <td>{fmt(order.marginUsdc,2)} USDC</td><td className="subtle">{time(order.updatedAt)}</td>
            <td><a href={order.variationalUrl} target="_blank" rel="noreferrer">Variational ↗</a></td></tr>
        )}{!data.openOrders.length&&<tr><td colSpan={9} className="empty">当前没有占用并发上限的订单</td></tr>}</tbody>
      </table>
    </section>

    <section className="panel"><div className="panelHead"><div><h2>开放持仓</h2><small>数量、入场、TP/SL 与当前 PnL 均以 Variational 对账为准</small></div><span className="subtle">{data.openPositions.length} 个持仓</span></div>
      <table><thead><tr><th>币种</th><th>方向</th><th>数量</th><th>入场价</th><th>TP</th><th>SL</th><th>当前 PnL</th><th>状态</th><th>开仓 / 更新</th><th>处理</th></tr></thead>
        <tbody>{data.openPositions.map((position)=>
          <tr key={position.id}><td><b>{position.code}</b></td><td className={position.direction==="LONG"?"up":"down"}>{position.direction}</td>
            <td className="mono">{fmt(position.quantity,8)}</td><td className="mono">{fmt(position.entryPrice,6)}</td>
            <td className="mono up">{fmt(position.takeProfit,6)}</td><td className="mono down">{fmt(position.stopLoss,6)}</td>
            <td className={Number(position.unrealizedPnl??0)>=0?"up":"down"}>{fmt(position.unrealizedPnl,4)}</td>
            <td><span className="tag">{position.orderState}</span></td>
            <td className="subtle">{time(position.openedAt)}<br/>{time(position.updatedAt)}</td>
            <td><a href={position.variationalUrl} target="_blank" rel="noreferrer">人工处理 ↗</a></td></tr>
        )}{!data.openPositions.length&&<tr><td colSpan={10} className="empty">当前没有开放持仓</td></tr>}</tbody>
      </table>
    </section>

    <section className="panel"><div className="panelHead"><div><h2>市场扫描</h2><small>每轮输入与条件均可审计 · 单币故障隔离</small></div><span className="subtle">{new Date(data.generatedAt).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai"})}</span></div>
      <table><thead><tr><th>币种 / 价格</th><th>OI · 1h</th><th>CVD · 15m</th><th>Funding</th><th>Heatmap</th><th>预热</th><th>状态</th><th>收盘时间</th></tr></thead>
        <tbody>{data.assets.map((asset)=>{
          const market=asset.market;
          return <tr key={asset.id}><td><b>{asset.code}</b><br/><span className="mono subtle">{fmt(market?.price,4)}</span></td><td className={market?.oiPassed?"up":""}>{fmt(market?.oiChange1h==null?null:market.oiChange1h*100,2)}%<br/><span className="subtle">Z {fmt(market?.oiZ,2)}</span></td><td className={market?.cvdPassed?"up":""}>{fmt(market?.cvd,0)}<br/><span className="subtle">Z {fmt(market?.cvdZ,2)}</span></td><td className={market?.fundingPassed?"up":""}>{fmt(market?.funding==null?null:market.funding*100,4)}%<br/><span className="subtle">Z {fmt(market?.fundingZ,2)}</span></td><td><span className={`tag ${market?.heatmapPassed?"":"orange"}`}>{market?.heatmapPassed?"READY":"WAIT"}</span></td><td><span className={`tag ${market?.warmupReady?"":"orange"}`}>{market?.warmupReady?"30D READY":"WARMING"}</span></td><td><span className={`tag ${asset.paused?"red":""}`}>{asset.paused?"PAUSED":"ACTIVE"}</span></td><td>{market?.closedAt?new Date(market.closedAt).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai"}):"—"}</td></tr>;
        })}{!data.assets.length&&<tr><td colSpan={8} className="empty">先运行数据库迁移并添加白名单币种</td></tr>}</tbody>
      </table>
    </section>
  </>;
}
