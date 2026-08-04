import { Header } from "../components/Header";
import { MarketChart } from "../components/MarketChart";
import { ControlButton } from "../components/ControlButton";
import { api } from "../lib/api";
import type { DashboardSnapshot } from "@huxtrade/shared-types";

export const dynamic="force-dynamic";
const fallback:DashboardSnapshot={generatedAt:new Date().toISOString(),liveTradingEnabled:false,globalPaused:false,btcRegime:"TRANSITION",marginUsagePercent:0,balanceUsdc:0,variationalLoggedIn:false,assets:[],services:[],orders:[],stats:{signals:0,orders:0,fills:0,fillRate:0,winRate:0,realizedPnl:0}};
const fmt=(value:number|null|undefined,digits=1)=>value==null?"—":Number(value).toLocaleString("zh-CN",{maximumFractionDigits:digits});

export default async function Dashboard(){
  const data=await api("/api/dashboard",fallback);
  return <>
    <Header eyebrow="Trading Operations" title="市场与执行总览"/>
    {!data.liveTradingEnabled&&<div className="alertStrip"><div><strong>真实下单安全门已关闭</strong> <span>· 完成 Variational 协议发现与对账验证前，信号只记录、不提交。</span></div><ControlButton paused={data.globalPaused}/></div>}
    <section className="grid4">
      <div className="metric"><label>BTC 市场状态</label><b className="warn">{data.btcRegime}</b><small>日线 + 4H + ADX</small></div>
      <div className="metric"><label>账户余额</label><b>{fmt(data.balanceUsdc,2)}</b><small>USDC · Variational 权威值</small></div>
      <div className="metric"><label>保证金占用</label><b className={data.marginUsagePercent>=80?"down":"up"}>{fmt(data.marginUsagePercent)}%</b><small>暂停 80% · 恢复 75%</small></div>
      <div className="metric"><label>已实现盈亏</label><b className={data.stats.realizedPnl>=0?"up":"down"}>{fmt(data.stats.realizedPnl,2)}</b><small>USDC · 全部策略</small></div>
    </section>
    <section className="contentGrid">
      <div className="panel"><div className="panelHead"><div><h2>BTCUSDT · 15分钟</h2><small>Binance 实时 K 线、信号与 Heatmap 目标区</small></div><span className="tag">BINANCE PERP</span></div><MarketChart/></div>
      <div className="panel"><div className="panelHead"><h2>系统健康</h2><small>{data.services.filter((service)=>service.state==="healthy").length}/{data.services.length} 正常</small></div><div className="healthList">{data.services.length?data.services.map((service)=><div className="healthRow" key={service.service}><span className={`dot ${service.state}`}/><div>{service.service}<small>{service.error?` · ${service.error.slice(0,34)}`:" · 最近运行正常"}</small></div><span className={service.blocksTrading?"warn":"up"}>{service.blocksTrading?"阻断":"正常"}</span></div>):<div className="empty">等待 Worker 上报状态</div>}</div></div>
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
