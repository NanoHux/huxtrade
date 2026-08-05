import { Header } from "../../components/Header";
import { OrderFilters } from "../../components/OrderFilters";
import { api } from "../../lib/api";
import { orderStates } from "@huxtrade/shared-types";

export const dynamic="force-dynamic";
const time=(value:unknown)=>value?new Date(String(value)).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai"}):"—";
const number=(value:unknown)=>value==null?"—":String(value);

export default async function Page({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){
  const params=await searchParams;
  const rawState=Array.isArray(params.state)?params.state[0]:params.state;
  const state=(orderStates as readonly string[]).includes(rawState??"")?rawState!:"";
  const rawCode=Array.isArray(params.code)?params.code[0]:params.code;
  const code=(rawCode??"").toUpperCase().replace(/[^A-Z0-9]/g,"").slice(0,15);

  const [orders,positions,fills]=await Promise.all([
    api<Array<Record<string,unknown>>>(`/api/orders${state?`?state=${encodeURIComponent(state)}`:""}`,[]),
    api<Array<Record<string,unknown>>>("/api/positions",[]),
    api<Array<Record<string,unknown>>>("/api/fills?limit=100",[])
  ]);
  const codes=[...new Set(orders.map((row)=>String(row.code)))].sort();
  const visibleOrders=code?orders.filter((row)=>String(row.code)===code):orders;
  const visiblePositions=code?positions.filter((row)=>String(row.code)===code):positions;
  const visibleFills=code?fills.filter((row)=>String(row.code)===code):fills;

  return <>
    <Header eyebrow="Reconciliation" title="订单与持仓"/>
    <section className="alertStrip"><div><strong>只读视图</strong> <span>· 撤单、平仓和修改 TP/SL 请在 Variational 页面完成，本地每 30 秒按平台权威状态同步。</span></div></section>
    <div className="pageGrid">
      <section className="panel"><div className="panelHead"><div><h2>订单</h2><small>UNKNOWN / RECONCILIATION_REQUIRED 继续占用并发上限</small></div><OrderFilters state={state} code={code} codes={codes}/></div><table><thead><tr><th>创建时间</th><th>币种</th><th>策略</th><th>方向</th><th>状态</th><th>入场</th><th>TP</th><th>SL</th><th>保证金</th><th>PnL</th><th>处理</th></tr></thead><tbody>{visibleOrders.map(row=><tr key={String(row.id)}><td>{time(row.created_at)}</td><td><b>{String(row.code)}</b></td><td>{String(row.strategy_name)}</td><td className={row.direction==="LONG"?"up":"down"}>{String(row.direction)}</td><td><span className={`tag ${["UNKNOWN","RECONCILIATION_REQUIRED"].includes(String(row.state))?"orange":""}`}>{String(row.state)}</span></td><td className="mono">{number(row.entry_price)}</td><td className="mono up">{number(row.take_profit)}</td><td className="mono down">{number(row.stop_loss)}</td><td>{number(row.margin_usdc)} USDC</td><td>{number(row.realized_pnl)}</td><td><a href={String(row.variational_url)} target="_blank" rel="noreferrer">打开 Variational ↗</a></td></tr>)}{!visibleOrders.length&&<tr><td colSpan={11} className="empty">{state||code?"当前筛选条件下没有订单。":"尚无订单记录；安全门关闭时不会产生真实订单。"}</td></tr>}</tbody></table></section>
      <section className="panel"><div className="panelHead"><h2>平台持仓</h2><small>TP/SL 与 PnL 均来自 Variational 对账{code?` · 已筛选 ${code}`:""}</small></div><table><thead><tr><th>开仓时间</th><th>币种</th><th>方向</th><th>数量</th><th>入场价</th><th>TP</th><th>SL</th><th>未实现 PnL</th><th>已实现 PnL</th><th>状态 / 更新时间</th><th>处理</th></tr></thead><tbody>{visiblePositions.map(row=><tr key={String(row.id)}><td>{time(row.opened_at)}</td><td><b>{String(row.code)}</b></td><td className={row.direction==="LONG"?"up":"down"}>{String(row.direction)}</td><td className="mono">{number(row.quantity)}</td><td className="mono">{number(row.entry_price)}</td><td className="mono up">{number(row.take_profit)}</td><td className="mono down">{number(row.stop_loss)}</td><td className={Number(row.unrealized_pnl??0)>=0?"up":"down"}>{number(row.unrealized_pnl)}</td><td className={Number(row.realized_pnl??0)>=0?"up":"down"}>{number(row.realized_pnl)}</td><td><span className="tag">{row.closed_at?"CLOSED":String(row.order_state)}</span><div className="subtle">{time(row.updated_at)}</div></td><td><a href={String(row.variational_url)} target="_blank" rel="noreferrer">人工处理 ↗</a></td></tr>)}{!visiblePositions.length&&<tr><td colSpan={11} className="empty">尚无平台持仓快照。</td></tr>}</tbody></table></section>
      <section className="panel"><div className="panelHead"><h2>最近成交</h2><small>永久保存 · 最近 100 条{code?` · 已筛选 ${code}`:""}</small></div><table><thead><tr><th>成交时间</th><th>币种</th><th>方向</th><th>成交侧</th><th>价格</th><th>数量</th><th>手续费</th><th>已实现 PnL</th><th>平台 Fill ID</th></tr></thead><tbody>{visibleFills.map(row=><tr key={String(row.id)}><td>{time(row.filled_at)}</td><td><b>{String(row.code)}</b></td><td>{String(row.direction)}</td><td>{String(row.side)}</td><td className="mono">{number(row.price)}</td><td className="mono">{number(row.quantity)}</td><td>{number(row.fee)}</td><td className={Number(row.realized_pnl??0)>=0?"up":"down"}>{number(row.realized_pnl)}</td><td className="mono">{String(row.platform_fill_id)}</td></tr>)}{!visibleFills.length&&<tr><td colSpan={9} className="empty">尚无成交记录。</td></tr>}</tbody></table></section>
    </div>
  </>;
}
