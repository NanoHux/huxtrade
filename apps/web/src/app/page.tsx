import { Header } from "../components/Header";
import { api } from "../lib/api";
import { gainersStrategy as s } from "@huxtrade/shared-types";
import type { DashboardSnapshot } from "@huxtrade/shared-types";

export const dynamic="force-dynamic";
const fallback:DashboardSnapshot={generatedAt:new Date().toISOString(),liveTradingEnabled:false,marginUsagePercent:0,balanceUsdc:0,services:[],
  gainers:{enabled:false,marginUsdc:null,closeAt:null,openLegs:0,positions:[],positionsAt:null,history:[],stats:{baskets:0,winners:0,realizedPnl:0}}};

const fmt=(value:number|null|undefined,digits=1)=>value==null?"—":Number(value).toLocaleString("zh-CN",{maximumFractionDigits:digits});
const time=(value:string|null|undefined)=>value?new Date(value).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai",hour12:false}):"—";
const clock=(value:string|null|undefined)=>value?new Date(value).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai",hour12:false,month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"}):"—";
const signed=(value:number)=>`${value>0?"+":""}${fmt(value,2)}`;

/** Next UTC openHour:openMinute, as an instant — the basket's entry is clock-driven. */
function nextOpen(){
  const now=new Date();
  const next=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate(),s.openHourUtc,s.openMinuteUtc,0));
  if(next.getTime()<=now.getTime())next.setUTCDate(next.getUTCDate()+1);
  return next.toISOString();
}

export default async function Dashboard(){
  const data=await api("/api/dashboard",fallback);
  const g=data.gainers;
  const holding=Boolean(g.closeAt)&&g.positions.length>0;
  const winRate=g.stats.baskets?100*g.stats.winners/g.stats.baskets:0;
  const unrealized=g.positions.reduce((sum,p)=>sum+Number(p.unrealizedPnl??0),0);

  return <>
    <Header eyebrow="Trading Operations" title="总览"/>
    {!data.liveTradingEnabled&&<div className="alertStrip"><div><strong>安全门已关闭</strong> <span>· 策略不会提交真实订单。</span></div></div>}
    {data.liveTradingEnabled&&!g.enabled&&<div className="alertStrip"><div><strong>涨幅榜定时器未启动</strong> <span>· 今晚不会建仓，可在「系统」页开启。</span></div></div>}

    <section className="grid4">
      <div className="metric"><label>账户余额</label><b>{fmt(data.balanceUsdc,2)}</b><small>USDC</small></div>
      <div className="metric"><label>保证金占用</label><b className={data.marginUsagePercent>=90?"down":"up"}>{fmt(data.marginUsagePercent)}%</b><small>已用保证金 / 总余额</small></div>
      <div className="metric"><label>累计已实现盈亏</label><b className={g.stats.realizedPnl>=0?"up":"down"}>{signed(g.stats.realizedPnl)}</b><small>USDC · {g.stats.baskets} 个正式篮子</small></div>
      <div className="metric"><label>篮子胜率</label><b>{fmt(winRate)}%</b><small>{g.stats.winners} 盈 / {g.stats.baskets - g.stats.winners} 亏</small></div>
    </section>

    <section className="panel">
      <div className="panelHead">
        <div><h2>当前篮子</h2><small>做多 {s.lookbackHours}h 涨幅榜前 {s.basket} · {s.leverage}x · 止盈 {s.takeProfitFraction*100}% · 持仓 {s.holdHours}h</small></div>
        <span className={`tag ${holding?"":"orange"}`}>
          {holding?`持仓中 · ${clock(g.closeAt)} 平仓`:g.enabled?`已就绪 · ${clock(nextOpen())} 建仓`:"未启动"}
        </span>
      </div>
      <table>
        <thead><tr><th>币种</th><th>数量</th><th>入场价</th><th>现价</th><th>涨跌</th><th>止盈</th><th>止损</th><th>未实现盈亏</th></tr></thead>
        <tbody>{g.positions.map((p)=>{
          const move=p.markPrice==null?null:(p.markPrice-p.entryPrice)/p.entryPrice*100;
          return <tr key={p.symbol}>
            <td><b>{p.symbol}</b></td>
            <td className="mono">{fmt(p.quantity,8)}</td>
            <td className="mono">{fmt(p.entryPrice,6)}</td>
            <td className="mono">{fmt(p.markPrice,6)}</td>
            <td className={move==null?"subtle":move>=0?"up":"down"}>{move==null?"—":`${move>0?"+":""}${fmt(move,2)}%`}</td>
            <td className="mono up">{fmt(p.takeProfit,6)}</td>
            <td className="mono down">{fmt(p.stopLoss,6)}</td>
            <td className={Number(p.unrealizedPnl??0)>=0?"up":"down"}>{p.unrealizedPnl==null?"—":signed(p.unrealizedPnl)}</td>
          </tr>;
        })}
        {!g.positions.length&&<tr><td colSpan={8} className="empty">{g.enabled?"当前没有持仓，等待下一次建仓":"定时器未启动"}</td></tr>}
        </tbody>
        {g.positions.length>0&&<tfoot><tr>
          <td colSpan={7} className="subtle">合计未实现盈亏 · 快照 {time(g.positionsAt)}</td>
          <td className={unrealized>=0?"up":"down"}>{signed(unrealized)}</td>
        </tr></tfoot>}
      </table>
    </section>

    <section className="panel">
      <div className="panelHead"><div><h2>历史篮子</h2><small>每次平仓的已实现盈亏，按腿汇总</small></div><span className="subtle">{g.history.length} 次</span></div>
      <table>
        <thead><tr><th>平仓时间</th><th>模式</th><th>腿数</th><th>已实现盈亏</th></tr></thead>
        <tbody>{g.history.map((b)=>
          <tr key={b.closedAt}>
            <td>{time(b.closedAt)}</td>
            <td><span className="tag">{b.mode}</span></td>
            <td className="mono">{b.legs}</td>
            <td className={b.realizedPnl>=0?"up":"down"}>{signed(b.realizedPnl)}</td>
          </tr>
        )}
        {!g.history.length&&<tr><td colSpan={4} className="empty">尚无已平仓的篮子</td></tr>}
        </tbody>
      </table>
    </section>

    <section className="panel">
      <div className="panelHead"><h2>服务状态</h2><small>{data.services.filter((x)=>x.state==="healthy").length}/{data.services.length} 正常</small></div>
      <div className="healthList">{data.services.length?data.services.map((service)=>
        <div className="healthRow" key={service.service}>
          <span className={`dot ${service.state}`}/>
          <div>{service.service}<small>{service.error?` · ${service.error.slice(0,34)}`:" · 正常"}</small></div>
          <span className={service.blocksTrading?"warn":"up"}>{service.blocksTrading?"阻断":"正常"}</span>
        </div>):<div className="empty">等待服务上报</div>}
      </div>
    </section>
  </>;
}
