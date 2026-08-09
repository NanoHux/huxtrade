import { Header } from "../../components/Header";
import { SignalHistoryFilters } from "../../components/SignalHistoryFilters";
import { SignalHistoryPager } from "../../components/SignalHistoryPager";
import { api } from "../../lib/api";

export const dynamic="force-dynamic";
const time=(value:unknown)=>value?new Date(String(value)).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai"}):"—";
const pageSize=25;
type Condition={type:string;passed:boolean;value?:number;zScore?:number;reason?:string;direction?:string};

function ConditionBadge({condition,used}:{condition?:Condition;used:boolean}){
  if(!used)return <span className="subtle" title="该策略未选用此条件，不影响是否下单">—</span>;
  if(!condition)return <span className="subtle">—</span>;
  const detail=[condition.value!=null?`值 ${Number(condition.value).toFixed(4)}`:null,condition.zScore!=null?`Z ${Number(condition.zScore).toFixed(2)}`:null,condition.reason].filter(Boolean).join(" · ");
  return <span className={condition.passed?"up":"down"} title={detail}>{condition.passed?"✓":"✗"}</span>;
}

export default async function Page({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){
  const params=await searchParams;
  const one=(value:string|string[]|undefined)=>Array.isArray(value)?value[0]:value;
  const assetId=/^[0-9a-f-]{36}$/i.test(one(params.assetId)??"")?one(params.assetId)!:"";
  const strategyId=/^[0-9a-f-]{36}$/i.test(one(params.strategyId)??"")?one(params.strategyId)!:"";
  const page=Math.max(0,(Number(one(params.page))||1)-1);

  const rows=await api<Array<Record<string,unknown>>>("/api/statistics",[]);
  const query=new URLSearchParams({limit:String(pageSize),offset:String(page*pageSize)});
  if(assetId)query.set("assetId",assetId);
  if(strategyId)query.set("strategyId",strategyId);
  const [signals,assets,strategies]=await Promise.all([
    api<{rows:Array<Record<string,unknown>>;total:number}>(`/api/signals?${query.toString()}`,{rows:[],total:0}),
    api<Array<Record<string,unknown>>>("/api/assets",[]),
    api<Array<Record<string,unknown>>>("/api/strategies",[])
  ]);
  const pageCount=Math.max(1,Math.ceil(signals.total/pageSize));
  const assetOptions=assets.map((a)=>({id:String(a.id),label:String(a.code)}));
  const strategyOptions=strategies.map((s)=>({id:String(s.id),label:String(s.name)}));

  return <>
    <Header eyebrow="Performance" title="策略统计"/>
    <section className="grid4">
      <div className="metric"><label>策略数量</label><b>{rows.length}</b><small>第一版仅按策略汇总</small></div>
      <div className="metric"><label>累计信号</label><b>{rows.reduce((a,r)=>a+Number(r.signals),0)}</b><small>满足策略并形成记录</small></div>
      <div className="metric"><label>累计成交</label><b>{rows.reduce((a,r)=>a+Number(r.fills),0)}</b><small>平台对账口径</small></div>
      <div className="metric"><label>已实现 PnL</label><b className="up">{rows.reduce((a,r)=>a+Number(r.realized_pnl),0).toFixed(2)}</b><small>USDC · Variational 权威值</small></div>
    </section>
    <section className="panel"><div className="panelHead"><h2>策略汇总</h2><small>登录失效等不可执行信号单独列出</small></div><table><thead><tr><th>策略</th><th>信号</th><th>不可执行</th><th>订单</th><th>成交</th><th>成交率</th><th>胜率</th><th>连胜 / 连亏</th><th>已实现 PnL</th></tr></thead><tbody>{rows.map(r=>{const o=Number(r.orders),f=Number(r.fills),closed=Number(r.closed),w=Number(r.wins);return <tr key={String(r.id)}><td><b>{String(r.name)}</b></td><td>{String(r.signals)}</td><td className="warn">{String(r.non_executable_signals)}</td><td>{o}</td><td>{f}</td><td>{o?(f/o*100).toFixed(1):"0.0"}%</td><td>{closed?(w/closed*100).toFixed(1):"0.0"}%</td><td><span className="up">{String(r.max_consecutive_wins)}</span> / <span className="down">{String(r.max_consecutive_losses)}</span></td><td className={Number(r.realized_pnl)>=0?"up":"down"}>{Number(r.realized_pnl).toFixed(2)}</td></tr>})}{!rows.length&&<tr><td colSpan={9} className="empty">暂无策略统计</td></tr>}</tbody></table></section>
    <section className="panel">
      <div className="panelHead"><div><h2>信号历史</h2><small>每次收盘评估的逐笔记录 · 共 {signals.total} 条</small></div><SignalHistoryFilters assetId={assetId} strategyId={strategyId} assets={assetOptions} strategies={strategyOptions}/></div>
      <table><thead><tr><th>收盘时间</th><th>币种</th><th>策略</th><th>方向</th><th>OI</th><th>CVD</th><th>Funding</th><th>Heatmap</th><th>可执行</th><th>结果</th></tr></thead>
        <tbody>{signals.rows.map((row)=>{
          const conditions=(Array.isArray(row.conditions)?row.conditions:[]) as Condition[];
          const byType=(type:string)=>conditions.find((c)=>c.type===type);
          const usedTypes=new Set(Array.isArray(row.strategy_conditions)?row.strategy_conditions as string[]:[]);
          const reasons=(Array.isArray(row.rejection_reasons)?row.rejection_reasons as string[]:[]).join(", ");
          const result=row.order_id?`下单 · ${String(row.order_state)}`:row.accepted?"条件通过但未下单":"未通过";
          return <tr key={String(row.id)}>
            <td>{time(row.closed_at)}</td>
            <td><b>{String(row.asset_code)}</b></td>
            <td>{String(row.strategy_name)}</td>
            <td className={row.direction==="LONG"?"up":"down"}>{String(row.direction)}</td>
            <td><ConditionBadge condition={byType("OI")} used={usedTypes.has("OI")}/></td>
            <td><ConditionBadge condition={byType("CVD")} used={usedTypes.has("CVD")}/></td>
            <td><ConditionBadge condition={byType("FUNDING")} used={usedTypes.has("FUNDING")}/></td>
            <td><ConditionBadge condition={byType("HEATMAP")} used={usedTypes.has("HEATMAP")}/></td>
            <td>{row.executable?<span className="up">是</span>:<span className="subtle">否</span>}</td>
            <td className={row.order_id?"up":"subtle"} title={reasons}>{result}</td>
          </tr>;
        })}
        {!signals.rows.length&&<tr><td colSpan={10} className="empty">暂无信号记录</td></tr>}
        </tbody>
      </table>
      <SignalHistoryPager page={page} pageCount={pageCount} assetId={assetId} strategyId={strategyId}/>
    </section>
  </>;
}
