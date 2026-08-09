const isRecord=(value:unknown):value is Record<string,unknown>=>Boolean(value)&&typeof value==="object"&&!Array.isArray(value);

export function directionLabel(direction:string){return direction==="LONG"?"多单":direction==="SHORT"?"空单":direction;}

function riskReward(direction:string,entry:number,stop:number,target:number){
  const risk=direction==="LONG"?entry-stop:stop-entry;
  const reward=direction==="LONG"?target-entry:entry-target;
  return risk>0?reward/risk:undefined;
}

// Codes/messages produced by the strategy engine, execution adapter, and
// market-collector. Anything not in these maps is shown as-is rather than
// dropped, so a new/unmapped reason never silently disappears — it just
// won't be translated yet.
const conditionLabels:Record<string,string>={OI:"持仓量(OI)",CVD:"资金流向(CVD)",FUNDING:"资金费率",HEATMAP:"清算热力图"};
const rejectionLabels:Record<string,string>={
  INDICATOR_WARMUP:"指标数据还在预热中",
  BTC_DIRECTION_FILTER:"与大盘 BTC 方向过滤冲突",
  GLOBAL_PAUSED:"系统已全局暂停",
  ASSET_PAUSED:"该币种已被暂停",
  STALE_DATA:"行情数据不是最新的",
  VARIATIONAL_SESSION_INVALID:"Variational 未登录或会话失效",
  LIVE_TRADING_DISABLED:"真实交易开关未开启",
  MARGIN_USAGE_LIMIT:"保证金占用过高，已暂停开新仓",
  SYMBOL_SIDE_LIMIT:"该币种同方向挂单/持仓已达上限",
  HEATMAP_NOT_SELECTED:"策略未启用热力图条件",
  HEATMAP_INVALIDATED:"热力图目标区域已失效"
};
export function translateRejection(code:string){
  if(code in rejectionLabels)return rejectionLabels[code];
  const condition=code.match(/^CONDITION_([A-Z]+)_FAILED$/);
  if(condition)return `${conditionLabels[condition[1]!]??condition[1]}条件未达标`;
  if(code.startsWith("HEATMAP_"))return `热力图状态异常（${code.slice(8)}）`;
  if(code.startsWith("ORDER_PLAN_FAILED"))return `下单计算失败：${code.slice(code.indexOf(":")+1).trim()}`;
  return code;
}

const protectionStatusLabels:Record<string,string>={ENTRY_CANCELLED:"入场单已撤销",EMERGENCY_CLOSED:"已紧急市价平仓",MANUAL_INTERVENTION:"需要人工介入处理"};
const reasonLabels:Record<string,string>={
  PLATFORM_MINIMUM_EXCEEDS_MARGIN_CAP:"平台要求的最低保证金超过了系统设置的保证金上限",
  AMBIGUOUS_SUBMISSION_AFTER_RESTART:"Agent 重启时这笔订单正在提交，状态不明确",
  EXISTING_PROTECTION_MISSING:"发现该仓位缺少止盈或止损保护单",
  STALE_BINANCE_SNAPSHOT:"Binance 行情快照过期",
  "30-second reconciliation did not find active platform order":"在 Variational 上没有找到对应的挂单或仓位",
  "pre-submit validation failed":"下单前的安全检查未通过",
  "submit response not authoritative":"提交请求时网络异常，订单状态不确定"
};
export function translateReason(reason:string){
  if(reason in reasonLabels)return reasonLabels[reason];
  const compensation=reason.match(/^initial protection compensation: (.+)$/);
  if(compensation)return protectionStatusLabels[compensation[1]!]??compensation[1];
  return reason;
}

export type OrderContext={code:string;direction:string;entryPrice:string;stopLoss:string;takeProfit:string;leverage:number;marginUsdc:string;realizedPnl:string|null};
export type FillRow={price:string;quantity:string;side:string;filledAt:string};

export function formatSignal(payload:Record<string,unknown>){
  const symbol=String(payload.symbol??""),direction=directionLabel(String(payload.direction??""));
  const executable=Boolean(payload.executable);
  const reasons=Array.isArray(payload.rejectionReasons)?payload.rejectionReasons.map((r)=>translateRejection(String(r))):[];
  const lines=[`[HuxTrade] 策略信号 - ${symbol} ${direction}`,executable?"条件全部满足，已提交下单":"条件通过但暂未执行"];
  if(!executable&&reasons.length)lines.push(`原因：${reasons.join("、")}`);
  return lines.join("\n");
}

export function formatOrderCreated(order:OrderContext){
  const direction=directionLabel(order.direction);
  const rr=riskReward(order.direction,Number(order.entryPrice),Number(order.stopLoss),Number(order.takeProfit));
  return [
    `[HuxTrade] 新订单已提交 - ${order.code} ${direction}`,
    `入场 ${order.entryPrice} / 止损 ${order.stopLoss} / 止盈 ${order.takeProfit}`,
    `保证金 ${order.marginUsdc} USDC · ${order.leverage}x 杠杆${rr?` · 盈亏比 1:${rr.toFixed(2)}`:""}`,
    "止盈止损已同步挂好，等待成交"
  ].join("\n");
}

export function formatOrderFailed(payload:Record<string,unknown>,order?:OrderContext){
  const details=isRecord(payload.details)?payload.details:undefined;
  const errorMsg=details&&typeof details.error==="string"?details.error:undefined;
  const rawReason=errorMsg??String(payload.reason??"未知原因");
  const errors=details&&Array.isArray(details.errors)?details.errors.map(String):[];
  const isManual=payload.manualIntervention===true||details?.status==="MANUAL_INTERVENTION";
  const header=order?`[HuxTrade] 下单失败 - ${order.code} ${directionLabel(order.direction)}`:"[HuxTrade] 下单失败";
  const lines=[header,`原因：${translateReason(rawReason)}`,...errors.map((e)=>`  · ${e}`)];
  if(isManual)lines.push("⚠️ 需要人工去 Variational 上核对处理");
  return lines.join("\n");
}

export function formatEntryFilled(order:OrderContext,fills:FillRow[]){
  const entryFill=fills[0];
  return [
    `[HuxTrade] 已成交开仓 - ${order.code} ${directionLabel(order.direction)}`,
    entryFill?`成交价 ${entryFill.price}，数量 ${entryFill.quantity}`:`入场价 ${order.entryPrice}`,
    `止盈 ${order.takeProfit} / 止损 ${order.stopLoss}`
  ].join("\n");
}

export function formatClosed(toState:string,order:OrderContext,fills:FillRow[]){
  const label=toState==="LIQUIDATED"?"强平":toState==="CLOSED_SL"?"止损平仓":toState==="CLOSED_REVERSED"?"反向信号平仓":"止盈平仓";
  const entryFill=fills[0],exitFill=fills.length>1?fills[fills.length-1]:undefined;
  const lines=[`[HuxTrade] ${label} - ${order.code} ${directionLabel(order.direction)}`];
  if(entryFill&&exitFill)lines.push(`成交价 ${entryFill.price} → 平仓价 ${exitFill.price}`);
  const pnl=order.realizedPnl!==null?Number(order.realizedPnl):undefined;
  if(pnl!==undefined)lines.push(`已实现盈亏：${pnl>=0?"+":""}${pnl.toFixed(2)} USDC`);
  return lines.join("\n");
}

export function formatScaledOut(payload:Record<string,unknown>){
  const profitR=typeof payload.profitR==="number"?payload.profitR:undefined;
  const fraction=typeof payload.fraction==="number"?payload.fraction:undefined;
  const pnl=typeof payload.realizedPnl==="number"?payload.realizedPnl:undefined;
  return [
    `[HuxTrade] 分批止盈 - ${String(payload.code??"")} ${directionLabel(String(payload.direction??""))}`,
    `浮盈达到 ${profitR!==undefined?`${profitR.toFixed(2)}R`:"触发线"}，已平掉${fraction!==undefined?` ${Math.round(fraction*100)}% `:"部分"}仓位`,
    payload.price!==undefined&&payload.price!==null?`平仓价 ${payload.price}${pnl!==undefined?`　落袋 ${pnl>=0?"+":""}${pnl.toFixed(2)} USDC`:""}`:undefined,
    payload.remainderClosedAtBreakeven===true
      // Price came back through breakeven while the half was filling, so the
      // stop had nothing left to protect. Deliberately worded as a normal
      // outcome: it is the breakeven rule doing its job, not a fault.
      ?(payload.closeError?`⚠️ 价格已回落到保本位，但剩余仓位平仓失败：${translateReason(String(payload.closeError))}`
        :`价格已回落到保本位 ${payload.breakevenStop}，剩余仓位按保本离场`)
      :`剩余仓位止损已移至保本 ${payload.breakevenStop}，止盈不变`
  ].filter(Boolean).join("\n");
}

export function formatBreakevenStopFailed(payload:Record<string,unknown>){
  const closed=payload.remainderClosed===true;
  return [
    `[HuxTrade] ⚠️ 保本止损挂单失败 - ${String(payload.code??"")} ${directionLabel(String(payload.direction??""))}`,
    `已平掉的那一半已落袋，但剩余仓位的保本止损没能挂上`,
    `原因：${translateReason(String(payload.error??"未知错误"))}`,
    closed?"已自动平掉剩余仓位止血，无敞口":"⚠️ 剩余仓位也没能平掉，可能正在无止损运行——请立刻去 Variational 核对"
  ].join("\n");
}

export function formatOrderDesynced(payload:Record<string,unknown>,order?:OrderContext){
  const state=String(payload.toState??"");
  const label=state==="CANCELLED_EXTERNALLY"?"挂单已被平台取消":"订单状态与平台不一致";
  return [
    `[HuxTrade] ⚠️ ${label}${order?` - ${order.code} ${directionLabel(order.direction)}`:""}`,
    `原因：${translateReason(String(payload.reason??"未知"))}`,
    state==="CANCELLED_EXTERNALLY"?"平台侧已无此挂单，系统不再跟踪":"仓位与止盈止损仍由平台看管，需要人工核对账本"
  ].join("\n");
}

/** A free-text answer to a /cc question. Sent verbatim — it is prose, not a template. */
export function formatOperatorReply(payload:Record<string,unknown>){
  return String(payload.answer??"").trim()||"（没有内容）";
}

export function formatDirectionHalted(payload:Record<string,unknown>){
  const until=payload.until?new Date(String(payload.until)).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai",hour12:false}):"—";
  return [
    `[HuxTrade] ⛔ ${directionLabel(String(payload.direction??""))}方向已熔断`,
    `${payload.count} 笔亏损止损集中出现，暂停武装该方向`,
    `恢复时间：${until}`,
    "已有持仓不受影响，仍按各自的止盈止损运行"
  ].join("\n");
}

export function formatSystemError(payload:Record<string,unknown>){
  const subject=String(payload.asset??payload.service??"");
  const rawReason=typeof payload.message==="string"?payload.message:String(payload.reason??"未知错误");
  return [`[HuxTrade] 系统异常${subject?` - ${subject}`:""}`,`原因：${translateReason(rawReason)}`].join("\n");
}

export function formatAssetResumed(payload:Record<string,unknown>){
  return `[HuxTrade] 币种已自动恢复监控 - ${String(payload.asset??"")}\n之前的暂停原因已解除，重新纳入扫描`;
}

export function formatSessionLost(){
  return "[HuxTrade] Variational 登录已失效\n请重新登录浏览器会话，真实交易在恢复前会被阻止";
}

export function formatMarginPauseResume(payload:Record<string,unknown>){
  const transition=String(payload.transition??"");
  const marginUsage=typeof payload.marginUsagePercent==="number"?payload.marginUsagePercent.toFixed(1):undefined;
  const label=transition==="PAUSE"?"保证金占用过高，已自动暂停开新仓":"保证金已恢复，自动开仓已恢复";
  return [`[HuxTrade] ${label}`,marginUsage?`当前保证金占用：${marginUsage}%`:undefined].filter(Boolean).join("\n");
}

export function formatServiceRecovered(payload:Record<string,unknown>){
  return `[HuxTrade] 服务已恢复 - ${String(payload.service??"")}`;
}

/** Fallback for any topic without a dedicated template above — never dumps
 * nested objects/arrays, so an unmapped event degrades to "fewer fields
 * shown" instead of back to the unreadable raw-JSON dump this replaced. */
export function formatGeneric(topic:string,payload:Record<string,unknown>){
  const lines=[`[HuxTrade] ${topic.replace("notification.","")}`];
  for(const [k,v] of Object.entries(payload)){
    if(v===null||v===undefined||typeof v==="object")continue;
    lines.push(`${k}: ${v}`);
  }
  return lines.join("\n");
}
