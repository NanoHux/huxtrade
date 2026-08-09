import { Header } from "../../components/Header";
import { AssetResumeButton } from "../../components/AssetResumeButton";
import { ErrorLog } from "../../components/ErrorLog";
import { LiveTradingToggle } from "../../components/LiveTradingToggle";
import { MarginSettings } from "../../components/MarginSettings";
import { SystemSettings } from "../../components/SystemSettings";
import { api } from "../../lib/api";

export const dynamic="force-dynamic";
type Restart={service?:string;status?:string;requestedAt?:string;deadlineAt?:string;updatedAt?:string};
type Health={services:Array<Record<string,unknown>>;assets:Array<Record<string,unknown>>;errors:Array<Record<string,unknown>>;lastScan:Record<string,unknown>|null;restarts:Restart[]};
const time=(value:unknown)=>value?new Date(String(value)).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai"}):"—";

export default async function Page(){
  const [status,preferences,health]=await Promise.all([
    api<Record<string,unknown>>("/api/settings/status",{coinglassMode:"disabled",coinglassReady:false,telegramConfigured:false,variationalMode:"disabled",liveTradingEnabled:false,defaultMarginUsdc:10,maxMarginUsdc:20}),
    api<Array<{event_type:string;enabled:boolean}>>("/api/settings/notifications",[]),
    api<Health>("/api/health/details",{services:[],assets:[],errors:[],lastScan:null,restarts:[]})
  ]);
  const restarts=health.restarts??[];
  return <><Header eyebrow="Operations & Safety" title="系统设置与健康"/><div className="pageGrid">
    <section className="panel"><div className="panelHead"><h2>执行安全门</h2><span className={`tag ${status.liveTradingEnabled?"":"orange"}`}>{status.liveTradingEnabled?"LIVE":"LOCKED"}</span></div><div className="split"><div><div className="bigStatus">{String(status.variationalMode).toUpperCase()}</div><p className="subtle">Variational 适配器模式 · 完成协议发现前保持 disabled</p></div><div><span className="subtle">CoinGlass Free Web</span><p className={status.coinglassReady?"up":"warn"}>{status.coinglassReady?"数据正常":"等待首轮采集"}</p></div></div><div className="divider"/><p className="subtle">真实资金执行需要：会话有效、启动对账完成、30 天数据预热完成、币种交易开关开启，并显式设置 LIVE_TRADING_ENABLED=true。任一项失败均拒绝提交。</p><LiveTradingToggle enabled={Boolean(status.liveTradingEnabled)}/><MarginSettings defaultMarginUsdc={Number(status.defaultMarginUsdc)} maxMarginUsdc={Number(status.maxMarginUsdc)}/></section>

    <section className="panel"><div className="panelHead"><div><h2>服务健康</h2><small>失败次数、最后成功时间与交易阻断状态</small></div><span className={`tag ${health.lastScan?.status==="COMPLETED"?"":"orange"}`}>SCAN {String(health.lastScan?.status??"NO DATA")}</span></div><table><thead><tr><th>服务</th><th>状态</th><th>连续失败</th><th>最后成功</th><th>错误</th><th>交易</th></tr></thead><tbody>{health.services.map((service)=><tr key={String(service.service)}><td><b>{String(service.service)}</b></td><td><span className={`tag ${service.state==="healthy"?"":"orange"}`}>{String(service.state).toUpperCase()}</span></td><td>{String(service.consecutive_failures)}</td><td>{time(service.last_success_at)}</td><td className="subtle">{String(service.error??"—")}</td><td className={service.blocks_trading?"down":"up"}>{service.blocks_trading?"阻断":"允许"}</td></tr>)}{!health.services.length&&<tr><td colSpan={6} className="empty">等待服务上报健康状态</td></tr>}</tbody></table></section>

    <section className="panel"><div className="panelHead"><div><h2>密钥更新与服务重启</h2><small>重启失败不回滚新密钥，只标记服务异常并尝试通知</small></div><span className={`tag ${restarts.some((item)=>item.status==="FAILED")?"red":restarts.some((item)=>item.status==="PENDING")?"orange":""}`}>{restarts.some((item)=>item.status==="FAILED")?"RESTART FAILED":restarts.some((item)=>item.status==="PENDING")?"PENDING":"OK"}</span></div><table><thead><tr><th>服务</th><th>结果</th><th>请求时间</th><th>判定截止</th><th>最后更新</th></tr></thead><tbody>{restarts.map((item)=><tr key={`${item.service}-${item.requestedAt}`}><td><b>{item.service??"—"}</b></td><td><span className={`tag ${item.status==="FAILED"?"red":item.status==="PENDING"?"orange":""}`}>{item.status??"—"}</span></td><td>{time(item.requestedAt)}</td><td>{time(item.deadlineAt)}</td><td className="subtle">{time(item.updatedAt)}</td></tr>)}{!restarts.length&&<tr><td colSpan={5} className="empty">尚未通过后台更新过密钥</td></tr>}</tbody></table></section>

    <section className="panel"><div className="panelHead"><h2>单币数据新鲜度</h2><small>Binance 超过 5 分钟或 Heatmap 超过 30 分钟会触发单币暂停；只能手动恢复</small></div><table><thead><tr><th>币种</th><th>最近收盘</th><th>快照年龄</th><th>Heatmap 年龄</th><th>30D 预热</th><th>暂停</th><th>原因</th><th>操作</th></tr></thead><tbody>{health.assets.map((asset)=><tr key={String(asset.code)}><td><b>{String(asset.code)}</b></td><td>{time(asset.closed_at)}</td><td>{asset.age_seconds==null?"—":`${Math.round(Number(asset.age_seconds)/60)} 分钟`}</td><td>{asset.heatmap_age_seconds==null?"—":`${Math.round(Number(asset.heatmap_age_seconds)/60)} 分钟`}</td><td><span className={`tag ${asset.warmup_ready?"":"orange"}`}>{asset.warmup_ready?"READY":"WARMING"}</span></td><td><span className={`tag ${asset.paused?"red":""}`}>{asset.paused?"PAUSED":"ACTIVE"}</span></td><td className="subtle">{String(asset.pause_reason??"—")}</td><td><AssetResumeButton assetId={String(asset.id)} code={String(asset.code)} paused={Boolean(asset.paused)}/></td></tr>)}{!health.assets.length&&<tr><td colSpan={8} className="empty">尚未配置币种</td></tr>}</tbody></table></section>

    <ErrorLog errors={health.errors}/>
    <SystemSettings status={status} initialPreferences={preferences}/>
  </div></>;
}
