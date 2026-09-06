import { directionLabel } from "./format.js";

/**
 * Read-only chat commands. Every formatter here is pure so the wording can be
 * tested without a database or a Telegram token; index.ts owns the queries and
 * the polling.
 *
 * Nothing in this file changes trading state. A chat message is the weakest
 * authentication in the system — it proves only that something reached the
 * bot — so the command surface is deliberately observation-only, and index.ts
 * additionally refuses any chat id other than the configured operator's.
 */
export const commandList=[
  ["/openshort","把空单补齐到 5 条（跌幅榜前五，会真实下单）"],
  ["/status","系统与服务状态"],
  ["/acc","账户余额与保证金"],
  ["/pos","当前持仓"],
  ["/orders","工作中的驻留挂单"],
  ["/pnl","已实现盈亏与胜率"],
  ["/plans","最近的入场决策"],
  ["/help","显示本列表"]
] as const;

export type CommandName=(typeof commandList)[number][0];

/** Accepts "/acc", "/acc@MyBot", and trailing arguments; everything else is not a command. */
export function parseCommand(text:string|undefined):CommandName|null{
  const word=(text??"").trim().split(/\s+/)[0]??"";
  const bare=word.split("@")[0]?.toLowerCase()??"";
  return commandList.some(([name])=>name===bare)?bare as CommandName:null;
}

const num=(value:unknown,digits=2)=>value===null||value===undefined||value===""?"—":Number(value).toFixed(digits);
const signed=(value:unknown,digits=2)=>{const parsed=Number(value);return Number.isFinite(parsed)?`${parsed>=0?"+":""}${parsed.toFixed(digits)}`:"—";};
const age=(minutes:number)=>minutes<60?`${Math.round(minutes)}分`:`${(minutes/60).toFixed(1)}小时`;
const clock=(value:string|null|undefined)=>value?new Date(value).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai",hour12:false}):"—";

export function formatHelp(){
  return ["可用指令",...commandList.map(([name,description])=>`${name} — ${description}`),
    "/cc <问题> — 用自然语言提问，由助手查数据后回答",
    "","只读指令，不会改变任何交易状态。",
    "/cc 只在助手会话在线时有人应答；离线时消息会存下但不会被回复。"].join("\n");
}

export interface StatusInput{
  services:Array<{service:string;state:string;error?:string|null}>;
  globalPaused:boolean;
  liveTrading:boolean;
  executionMode:string;
  strategyName:string|null;
  entryKind:string|null;
  pausedAssets:Array<{code:string;reason:string|null}>;
  assetCount:number;
  lastScanAt:string|null;
}
export function formatStatus(input:StatusInput){
  const unhealthy=input.services.filter((service)=>service.state!=="healthy");
  const lines=[
    unhealthy.length?"⚠️ 系统状态":"✅ 系统状态",
    `服务　　${input.services.length-unhealthy.length}/${input.services.length} 正常`,
    ...unhealthy.map((service)=>`　　└ ${service.service}：${service.state}${service.error?` — ${service.error.slice(0,80)}`:""}`),
    `策略　　${input.strategyName??"未启用"}${input.entryKind==="RESTING_LIMIT"?"（驻留限价入场）":input.entryKind?"（信号即市价入场）":""}`,
    `模式　　${input.executionMode==="live"?"实盘":"影子（只记账不下单）"}　真实交易开关${input.liveTrading?"已开":"已关"}`,
    `全局　　${input.globalPaused?"⛔ 已暂停":"运行中"}`,
    `币种　　${input.assetCount} 个，暂停 ${input.pausedAssets.length} 个`,
    ...input.pausedAssets.map((asset)=>`　　└ ${asset.code}：${asset.reason??"未注明原因"}`),
    `最近扫描　${clock(input.lastScanAt)}`
  ];
  return lines.join("\n");
}

export interface AccountInput{
  balanceUsdc:number;marginUsagePercent:number;autoPaused:boolean;
  /** Venue link. On Binance this is the agent's own health, not a browser session. */
  connected:boolean;connectionNote?:string;
  openPositions:number;workingOrders:number;
  /** When the running basket exits, so "0 positions" can be read correctly. */
  closeAt?:string|null;
}
export function formatAccount(input:AccountInput){
  const held=input.openPositions>0
    ? `持仓　　${input.openPositions} 个${input.closeAt?`　${new Date(input.closeAt).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai",hour12:false,month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"})} 平仓`:""}`
    : "持仓　　无";
  return [
    input.autoPaused?"⚠️ 账户":"💰 账户",
    `余额　　${num(input.balanceUsdc)} USDC`,
    `保证金占用　${num(input.marginUsagePercent,1)}%${input.autoPaused?"　⛔ 已超阈值自动暂停开新仓":""}`,
    held,
    `连接　　${input.connected?"正常":"⚠️ 异常"}${input.connectionNote?`　${input.connectionNote}`:""}`
  ].join("\n");
}

export interface PositionRow{
  code:string;direction:string;entryPrice:number;stopLoss:number;takeProfit:number;
  unrealizedPnl:number|null;openedMinutes:number;
}
export function formatPositions(rows:PositionRow[]){
  if(!rows.length)return "当前没有持仓。";
  const total=rows.reduce((sum,row)=>sum+(row.unrealizedPnl??0),0);
  return [`📊 持仓 ${rows.length} 个　浮动合计 ${signed(total)}`,...rows.map((row)=>
    [`${row.code} ${directionLabel(row.direction)}　${signed(row.unrealizedPnl)}`,
     `　入场 ${num(row.entryPrice,4)}　止损 ${num(row.stopLoss,4)}　止盈 ${num(row.takeProfit,4)}`,
     `　已持有 ${age(row.openedMinutes)}`].join("\n"))].join("\n");
}

export interface WorkingOrderRow{
  code:string;direction:string;level:number;marketPrice:number|null;
  distanceAtr:number|null;expectedRiskReward:number|null;sources:string[];ageMinutes:number;
  /** True while the level is held locally and nothing has reached the venue. */
  awaitingTrigger:boolean;
  /** True once price has touched the level and the two confirming closes are pending. */
  touched:boolean;
}
export function formatWorkingOrders(rows:WorkingOrderRow[]){
  if(!rows.length)return "当前没有工作中的挂单。";
  const virtual=rows.filter((row)=>row.awaitingTrigger).length;
  return [`⏳ 挂单 ${rows.length} 张（虚拟 ${virtual} / 平台 ${rows.length-virtual}）`,...rows.map((row)=>
    [`${row.code} ${directionLabel(row.direction)}　${row.awaitingTrigger?(row.touched?"确认中":"等待到价"):"平台挂单"} ${num(row.level,4)}`,
     `　距市价 ${row.distanceAtr===null?"—":`${row.distanceAtr.toFixed(2)} ATR`}　盈亏比 ${row.expectedRiskReward===null?"—":row.expectedRiskReward.toFixed(2)}`,
     `　来源 ${row.sources.length?row.sources.join("+"):"—"}　挂龄 ${age(row.ageMinutes)}`].join("\n"))].join("\n");
}

export interface PnlInput{
  todayRealized:number;totalRealized:number;
  byExit:Array<{state:string;count:number;realized:number}>;
  filled:number;placed:number;
}
const exitLabels:Record<string,string>={CLOSED_TP:"止盈",CLOSED_SL:"止损",LIQUIDATED:"强平",CLOSED_REVERSED:"方向反转平仓"};
export function formatPnl(input:PnlInput){
  const wins=input.byExit.find((row)=>row.state==="CLOSED_TP")?.count??0;
  const losses=(input.byExit.find((row)=>row.state==="CLOSED_SL")?.count??0)+(input.byExit.find((row)=>row.state==="LIQUIDATED")?.count??0);
  const decided=wins+losses;
  return [
    `📈 盈亏（驻留限价入场）`,
    `今日　${signed(input.todayRealized)} USDC　累计 ${signed(input.totalRealized)} USDC`,
    `成交　${input.filled} 笔 / 挂出 ${input.placed} 次`,
    decided?`胜率　${((wins/decided)*100).toFixed(0)}%（止盈 ${wins} / 止损强平 ${losses}）`:"胜率　还没有走到止盈或止损的样本",
    "按退出方式：",
    ...(input.byExit.length?input.byExit.map((row)=>`　${exitLabels[row.state]??row.state}　${row.count} 笔　${signed(row.realized)}`):["　还没有已平仓的交易"])
  ].join("\n");
}

export interface PlanRow{code:string;closedAt:string;decision:string;direction:string|null;level:number|null;reason:string}
const decisionLabels:Record<string,string>={PLACE:"新挂单",REPLACE:"重挂",CANCEL:"撤单",CLOSE_OPPOSITE:"反向平仓",KEEP:"保持",NONE:"无动作"};
export function formatPlans(rows:PlanRow[]){
  if(!rows.length)return "最近没有产生动作的决策。";
  return [`🧭 最近决策 ${rows.length} 条（不含保持/无动作）`,...rows.map((row)=>
    `${clock(row.closedAt).slice(-8)}　${row.code} ${decisionLabels[row.decision]??row.decision}${row.direction?` ${directionLabel(row.direction)}`:""}${row.level===null?"":`　${num(row.level,4)}`}\n　${row.reason.slice(0,90)}`)].join("\n");
}
