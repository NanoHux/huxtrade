import { Header } from "../../components/Header";
import { api } from "../../lib/api";
import type { DailyPnl } from "@huxtrade/shared-types";

export const dynamic="force-dynamic";

type Payload={
  days:DailyPnl[];
  stats:{tradingDays:number;winDays:number;lossDays:number;realizedPnl:number;grossPnl:number;commission:number;
    funding:number;fundingDays:number;
    best:{date:string;realizedPnl:number}|null;worst:{date:string;realizedPnl:number}|null};
};
const fallback:Payload={days:[],stats:{tradingDays:0,winDays:0,lossDays:0,realizedPnl:0,grossPnl:0,commission:0,funding:0,fundingDays:0,best:null,worst:null}};

const money=(v:number)=>`${v>0?"+":v<0?"−":""}${Math.abs(v).toLocaleString("zh-CN",{minimumFractionDigits:2,maximumFractionDigits:2})}`;
const compact=(v:number)=>{
  const a=Math.abs(v),s=v>0?"+":v<0?"−":"";
  return a>=1000?`${s}${(a/1000).toFixed(1)}K`:`${s}${a.toFixed(a>=100?0:1)}`;
};
/** Today in Asia/Shanghai — the server may sit in any zone, the desk does not. */
const todayBeijing=()=>new Date().toLocaleDateString("en-CA",{timeZone:"Asia/Shanghai"});
const monthLabel=(ym:string)=>`${ym.slice(0,4)} 年 ${Number(ym.slice(5,7))} 月`;
const shift=(ym:string,by:number)=>{
  const [y,m]=ym.split("-").map(Number);
  const d=new Date(Date.UTC(y!,m!-1+by,1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}`;
};

export default async function Calendar({searchParams}:{searchParams:Promise<{m?:string}>}){
  const {m}=await searchParams;
  const data=await api<Payload>("/api/pnl/daily",fallback);
  const today=todayBeijing();

  const byDate=new Map(data.days.map((d)=>[d.date,d]));
  const months=[...new Set(data.days.map((d)=>d.date.slice(0,7)))].sort();
  const latest=months[months.length-1]??today.slice(0,7);
  const month=m&&/^\d{4}-\d{2}$/.test(m)?m:latest;

  // Monday-first grid: JS getUTCDay() is Sunday-0, and the desk reads 一 first.
  const [year,mon]=month.split("-").map(Number);
  const first=new Date(Date.UTC(year!,mon!-1,1));
  const daysInMonth=new Date(Date.UTC(year!,mon!,0)).getUTCDate();
  const lead=(first.getUTCDay()+6)%7;
  const cells:Array<string|null>=[
    ...Array<null>(lead).fill(null),
    ...Array.from({length:daysInMonth},(_,i)=>`${month}-${String(i+1).padStart(2,"0")}`)
  ];
  while(cells.length%7)cells.push(null);

  const inMonth=data.days.filter((d)=>d.date.startsWith(month));
  const priced=inMonth.filter((d)=>d.realizedPnl!=null) as Array<DailyPnl&{realizedPnl:number}>;
  // Both cards count the same thing — days that actually carry a P&L figure —
  // so the month total and the running total are never read against different
  // denominators.
  const pricedAll=data.days.filter((d)=>d.realizedPnl!=null).length;
  const monthPnl=priced.reduce((s,d)=>s+d.realizedPnl,0);
  const monthWins=priced.filter((d)=>d.realizedPnl>0).length;
  const monthSplit=priced.filter((d)=>d.grossPnl!=null&&d.commission!=null);
  const monthGross=monthSplit.reduce((s,d)=>s+d.grossPnl!,0);
  const monthFees=monthSplit.reduce((s,d)=>s+d.commission!,0);
  const monthFunded=priced.filter((d)=>d.funding!=null);
  const monthFunding=monthFunded.reduce((s,d)=>s+d.funding!,0);
  const allSplit=data.days.filter((d)=>d.grossPnl!=null&&d.commission!=null).length;
  // Binance only serves about a week of fill history, so the earlier days have
  // a net figure and no breakdown. Saying how many days the split covers stops
  // the two numbers being read as if they subtract to the net beside them.
  const coverage=(split:number,of:number)=>split===0?"暂无拆分数据":split<of?`（${split}/${of} 天有拆分）`:"";
  // Shade against the month's own extreme, so a quiet month still reads.
  const peak=Math.max(1,...priced.map((d)=>Math.abs(d.realizedPnl)));

  const idx=months.indexOf(month);
  const prev=idx>0?months[idx-1]:months.filter((x)=>x<month).pop();
  const next=idx>=0&&idx<months.length-1?months[idx+1]:months.find((x)=>x>month);

  return <>
    <Header eyebrow="Trading Operations" title="收益日历"/>

    <section className="grid4">
      <div className="metric"><label>本月净盈亏</label><b className={monthPnl>=0?"up":"down"}>{money(monthPnl)}</b>
        <small>{monthSplit.length
          ?<><span className={monthGross>=0?"up":"down"}>涨跌 {money(monthGross)}</span> · <span className="dim">费 −{monthFees.toFixed(2)}</span> {coverage(monthSplit.length,priced.length)}</>
          :"暂无拆分数据"}</small></div>
      <div className="metric"><label>本月资金费</label><b className={monthFunding>=0?"up":"down"}>{monthFunded.length?money(monthFunding):"—"}</b>
        <small>{monthFunded.length?<>USDC · 收到为正 {coverage(monthFunded.length,priced.length)}</>:"暂无资金费记录"}</small></div>
      <div className="metric"><label>累计净盈亏</label><b className={data.stats.realizedPnl>=0?"up":"down"}>{money(data.stats.realizedPnl)}</b>
        <small>{allSplit
          ?<><span className={data.stats.grossPnl>=0?"up":"down"}>涨跌 {money(data.stats.grossPnl)}</span> · <span className="dim">费 −{data.stats.commission.toFixed(2)}</span> {coverage(allSplit,pricedAll)}</>
          :"暂无拆分数据"}</small></div>
      <div className="metric"><label>累计资金费</label><b className={data.stats.funding>=0?"up":"down"}>{data.stats.fundingDays?money(data.stats.funding):"—"}</b>
        <small>{data.stats.fundingDays?`USDC · ${data.stats.fundingDays} 天有记录`:"暂无资金费记录"}</small></div>
    </section>

    <section className="panel calPanel">
      <div className="panelHead">
        <div><h2>{monthLabel(month)}</h2><small>按平仓日归属 · 每晚 23:55 建仓的篮子结算在次日 07:55
          {data.stats.best&&data.stats.worst?` · 最佳 ${money(data.stats.best.realizedPnl)}（${data.stats.best.date.slice(5)}）· 最差 ${money(data.stats.worst.realizedPnl)}（${data.stats.worst.date.slice(5)}）`:""}</small></div>
        <div className="toolbar">
          {prev?<a className="btn" href={`/calendar?m=${prev}`}>← {monthLabel(prev).replace(/^\d+ 年 /,"")}</a>:<span className="btn" aria-disabled="true" style={{opacity:.35}}>←</span>}
          {next?<a className="btn" href={`/calendar?m=${next}`}>{monthLabel(next).replace(/^\d+ 年 /,"")} →</a>:<span className="btn" aria-disabled="true" style={{opacity:.35}}>→</span>}
        </div>
      </div>

      <div className="calGrid">
        {["一","二","三","四","五","六","日"].map((d)=><div className="calHead" key={d}>{d}</div>)}
        {cells.map((date,i)=>{
          if(!date)return <div className="calCell blank" key={`b${i}`}/>;
          const day=byDate.get(date);
          const pnl=day?.realizedPnl??null;
          const tone=pnl==null?"":pnl>0?"win":pnl<0?"loss":"flat";
          const shade=pnl==null?0:Math.min(1,Math.abs(pnl)/peak);
          return <div className={`calCell ${tone} ${date===today?"today":""}`} key={date}
                      style={pnl==null?undefined:{["--shade" as string]:shade.toFixed(3)}}>
            <span className="calDay">{Number(date.slice(8))}</span>
            {pnl!=null
              ?<>
                <span className="calPnl">{compact(pnl)}</span>
                {day!.funding!=null||day!.grossPnl!=null
                  ?<span className="calSplit">
                     <span className={(day!.grossPnl??0)>=0?"up":"down"}>{day!.grossPnl!=null?compact(day!.grossPnl):"—"}</span>
                     <span className={day!.funding==null?"calFee":day!.funding>=0?"up":"down"} title="资金费">
                       {day!.funding!=null?`⇄${compact(day!.funding)}`:""}
                     </span>
                   </span>
                  :<span className="calMeta">{day!.legs} 腿</span>}
               </>
              // A scheduled basket closed but predates per-leg P&L; a day with
              // only a test basket never had a scheduled result to miss.
              :day&&day.baskets>0
                ?<span className="calMeta">无盈亏数据</span>
                :<span className="calMeta dashy">—</span>}
            {day&&day.testLegs>0&&<span className="calTest" title={`测试篮子 ${day.testPnl==null?"":money(day.testPnl)}`}>测</span>}
          </div>;
        })}
      </div>

      <div className="calLegend">
        <span><i className="calSw loss"/>亏损</span>
        <span><i className="calSw win"/>盈利</span>
        <span><i className="calSw"/>未交易</span>
        <span className="subtle">格内：上为净额，下为「涨跌 ⇄资金费」</span>
        <span className="subtle">色深表示金额相对本月最大幅度({peak.toFixed(2)} USDC)</span>
      </div>
    </section>

    <section className="panel">
      <div className="panelHead"><div><h2>逐月汇总</h2><small>仅正式篮子</small></div><span className="subtle">{months.length} 个月</span></div>
      <table>
        <thead><tr><th>月份</th><th>交易日</th><th>盈利日</th><th>亏损日</th><th>胜率</th><th>涨跌盈亏</th><th>资金费</th><th>手续费</th><th>明细覆盖</th><th>净盈亏</th></tr></thead>
        <tbody>{months.slice().reverse().map((ym)=>{
          const rows=data.days.filter((d)=>d.date.startsWith(ym)&&d.realizedPnl!=null) as Array<DailyPnl&{realizedPnl:number}>;
          const sum=rows.reduce((s,d)=>s+d.realizedPnl,0);
          const withSplit=rows.filter((d)=>d.grossPnl!=null&&d.commission!=null);
          const g=withSplit.reduce((s,d)=>s+d.grossPnl!,0);
          const f=withSplit.reduce((s,d)=>s+d.commission!,0);
          const funded=rows.filter((d)=>d.funding!=null);
          const fund=funded.reduce((s,d)=>s+d.funding!,0);
          const w=rows.filter((d)=>d.realizedPnl>0).length;
          return <tr key={ym}>
            <td><a href={`/calendar?m=${ym}`} style={{textDecoration:ym===month?"underline":"none"}}>{monthLabel(ym)}</a></td>
            <td className="mono">{rows.length}</td><td className="mono up">{w}</td><td className="mono down">{rows.length-w}</td>
            <td className="mono">{rows.length?Math.round(100*w/rows.length):0}%</td>
            <td className={withSplit.length?(g>=0?"up":"down"):"subtle"}>{withSplit.length?money(g):"—"}</td>
            <td className={funded.length?(fund>=0?"up":"down"):"subtle"}>{funded.length?money(fund):"—"}</td>
            <td className={withSplit.length?"dim":"subtle"}>{withSplit.length?`−${f.toFixed(2)}`:"—"}</td>
            <td className="subtle">{withSplit.length?`${withSplit.length}/${rows.length}`:"—"}</td>
            <td className={sum>=0?"up":"down"}>{money(sum)}</td>
          </tr>;
        })}
        {!months.length&&<tr><td colSpan={10} className="empty">尚无已平仓的篮子</td></tr>}
        </tbody>
      </table>
      <p className="subtle" style={{marginTop:12}}>
        「明细覆盖」是当月有拆分明细的天数。平台只提供约一周的成交与资金费记录，更早的日子只留下净额，
        所以覆盖不足时，涨跌、资金费、手续费三列加不出净盈亏那一列。资金费收到为正、付出为负。
      </p>
    </section>
  </>;
}
