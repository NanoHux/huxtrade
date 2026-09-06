import { Header } from "../../components/Header";
import { ErrorLog } from "../../components/ErrorLog";
import { GainersTestButton } from "../../components/GainersTestButton";
import { GainersToggle } from "../../components/GainersToggle";
import { LiveTradingToggle } from "../../components/LiveTradingToggle";
import { SystemSettings } from "../../components/SystemSettings";
import { api } from "../../lib/api";
import { gainersStrategy as s } from "@huxtrade/shared-types";

export const dynamic="force-dynamic";
type Health={services:Array<Record<string,unknown>>;errors:Array<Record<string,unknown>>};
const time=(value:unknown)=>value?new Date(String(value)).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai",hour12:false}):"—";
/** The schedule in the operator's timezone, derived rather than transcribed. */
const beijing=(hourUtc:number,minute:number)=>`${String((hourUtc+8)%24).padStart(2,"0")}:${String(minute).padStart(2,"0")}`;

export default async function Page(){
  const [status,preferences,health]=await Promise.all([
    api<Record<string,unknown>>("/api/settings/status",{telegramConfigured:false,binanceMode:false,liveTradingEnabled:false,gainersEnabled:false,gainersMarginUsdc:null,gainersCloseAt:null,gainersOpenLegs:0,gainersTestState:"IDLE",gainersTestLegs:0}),
    api<Array<{event_type:string;enabled:boolean}>>("/api/settings/notifications",[]),
    api<Health>("/api/health/details",{services:[],errors:[]})
  ]);
  const openAt=beijing(s.openHourUtc,s.openMinuteUtc);
  const closeAt=beijing(s.openHourUtc+s.holdHours,s.openMinuteUtc);

  return <><Header eyebrow="Operations" title="系统设置"/><div className="pageGrid">
    <section className="panel">
      <div className="panelHead"><h2>执行安全门</h2><span className={`tag ${status.liveTradingEnabled?"":"orange"}`}>{status.liveTradingEnabled?"LIVE":"LOCKED"}</span></div>
      <div className="split">
        <div><div className="bigStatus">{status.binanceMode?"BINANCE":"未配置"}</div><p className="subtle">{status.binanceMode?"Binance Futures 直连":"缺少 BINANCE_API_KEY，无法交易"}</p></div>
        <div><span className="subtle">Telegram</span><p className={status.telegramConfigured?"up":"warn"}>{status.telegramConfigured?"已配置":"未配置"}</p></div>
      </div>
      <div className="divider"/>
      <p className="subtle">真实资金执行需要显式设置 LIVE_TRADING_ENABLED=true。</p>
      <LiveTradingToggle enabled={Boolean(status.liveTradingEnabled)}/>
    </section>

    <section className="panel">
      <div className="panelHead"><div><h2>每日涨幅榜篮子</h2><small>系统当前唯一在交易的策略</small></div><span className={`tag ${status.gainersEnabled?"":"orange"}`}>{status.gainersEnabled?"ARMED":"OFF"}</span></div>
      <table>
        <tbody>
          <tr><td>选币</td><td>全市场 {s.lookbackHours}h 涨幅榜前 {s.basket}，{s.longWeight>=1?"只做多":"多空双向"}</td></tr>
          <tr><td>建仓 / 平仓</td><td>UTC+8 每天 {openAt} 建仓，持仓 {s.holdHours} 小时后 {closeAt} 全部平掉</td></tr>
          <tr><td>杠杆与仓位</td><td>{s.leverage}x，余额的 {s.deployFraction*100}% 均分到 {s.basket} 条腿</td></tr>
          <tr><td>止盈 / 止损</td><td>价格 +{s.takeProfitFraction*100}%（保证金 +{s.takeProfitFraction*s.leverage*100}%）/ 价格 −{s.stopFraction*100}%</td></tr>
        </tbody>
      </table>
      <GainersToggle enabled={Boolean(status.gainersEnabled)} marginUsdc={status.gainersMarginUsdc==null?null:Number(status.gainersMarginUsdc)} closeAt={status.gainersCloseAt==null?null:String(status.gainersCloseAt)} openLegs={Number(status.gainersOpenLegs??0)}/>
      <div className="divider"/>
      <GainersTestButton state={String(status.gainersTestState??"IDLE")} legs={Number(status.gainersTestLegs??0)} binanceMode={Boolean(status.binanceMode)}/>
    </section>

    <section className="panel">
      <div className="panelHead"><div><h2>服务健康</h2><small>失败次数、最后成功时间与交易阻断状态</small></div></div>
      <table><thead><tr><th>服务</th><th>状态</th><th>连续失败</th><th>最后成功</th><th>错误</th><th>交易</th></tr></thead>
        <tbody>{health.services.map((service)=>
          <tr key={String(service.service)}>
            <td><b>{String(service.service)}</b></td>
            <td><span className={`tag ${service.state==="healthy"?"":"orange"}`}>{String(service.state).toUpperCase()}</span></td>
            <td>{String(service.consecutive_failures)}</td>
            <td>{time(service.last_success_at)}</td>
            <td className="subtle">{String(service.error??"—")}</td>
            <td className={service.blocks_trading?"down":"up"}>{service.blocks_trading?"阻断":"允许"}</td>
          </tr>)}
        {!health.services.length&&<tr><td colSpan={6} className="empty">等待服务上报健康状态</td></tr>}
        </tbody>
      </table>
    </section>

    <ErrorLog errors={health.errors}/>
    <SystemSettings status={status} initialPreferences={preferences}/>
  </div></>;
}
