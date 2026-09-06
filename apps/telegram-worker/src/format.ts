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

/**
 * The evening's basket. The unmatched names are the point of this message:
 * they are the difference between the strategy that was measured and the one
 * that actually ran, and nothing else surfaces them.
 */
export function formatGainersBasket(payload:Record<string,unknown>){
  const mode=payload.mode?`${String(payload.mode)} · `:"";
  const matched=Array.isArray(payload.matched)?payload.matched as Array<Record<string,unknown>>:[];
  const unmatched=Array.isArray(payload.unmatched)?payload.unmatched as Array<Record<string,unknown>>:[];
  const lev=typeof payload.leverage==="number"?payload.leverage:2;
  const lbHours=typeof payload.lookbackHours==="number"?payload.lookbackHours:52;
  const longs=Number(payload.longs??0),shorts=Number(payload.shorts??0);
  const title=shorts===0?`纯多头 ${longs} 腿`:`多空组合 —— 多 ${longs} / 空 ${shorts}`;
  const lines=[`📊 ${mode}${title}，${lev}x 杠杆，${lbHours}h 榜单，跳过 ${unmatched.length}`];
  if(payload.skew)lines.push(String(payload.skew));
  if(matched.length){
    lines.push("","已下单：");
    for(const m of matched)lines.push(`  ${String(m.direction)==="SHORT"?"空":"多"} ${m.base} ${Number(m.changePercent)>=0?"+":""}${Number(m.changePercent).toFixed(1)}%${m.entryId?"":`  ⚠ ${m.error?String(m.error).slice(0,40):"提交失败"}`}`);
  }
  if(unmatched.length){
    lines.push("","排名更高但跳过的：");
    for(const u of unmatched){
      const similar=Array.isArray(u.similar)?u.similar as string[]:[];
      const why=u.reason?`（${String(u.reason)}）`:"";
      lines.push(`  ${String(u.direction)==="SHORT"?"空":"多"} ${u.base} ${Number(u.changePercent)>=0?"+":""}${Number(u.changePercent).toFixed(1)}%${why}${similar.length?`   相似名：${similar.join(" ")}`:""}`);
    }
  }
  // Say whether the night is lost or the agent is still trying, so a first
  // failure is not read as the final word on the basket.
  if(payload.error)lines.push("",`⚠ ${String(payload.error)}`,
    payload.willRetry===true?"仍在补开，2 小时窗口内每 30 秒重试一次；成功或放弃都会再发一条。"
    :payload.willRetry===false?"已有订单发出，不会重试，请去 Binance 核对持仓。":"");
  return lines.join("\n");
}

/** The morning exit, reported whether or not every leg came off cleanly. */
/**
 * A fill price at readable precision. Raw venue floats arrive as
 * 0.00457501985085415, which is fifteen digits of noise around six that matter.
 */
const price=(value:unknown)=>{
  if(value==null)return "";
  const n=Number(value);
  if(!Number.isFinite(n)||n===0)return "";
  return String(Number(n.toPrecision(6)));
};

/** Amounts always carry their sign, so a fee line never reads as income. */
const signed=(n:number)=>`${n>=0?"+":"-"}${Math.abs(n).toFixed(2)}`;

export function formatGainersClosed(payload:Record<string,unknown>){
  const closed=Array.isArray(payload.closed)?payload.closed as Array<Record<string,unknown>>:[];
  const failed=closed.filter((c)=>!c.ok);
  const scope=payload.scope?`（${String(payload.scope)}）`:"";
  const day=payload.tradingDay==null?"":` · 第 ${Number(payload.tradingDay)} 天`;
  const lines=[`📉 ${payload.mode?`${String(payload.mode)} · `:""}平仓${scope}${day} —— ${closed.length-failed.length}/${closed.length} 成功`];
  if(!closed.length)lines.push("账户本来就是空仓。");
  let total=0,gross=0,fees=0,funding=0,known=0,split=0,fundingKnown=0;
  for(const c of closed){
    const side=c.qty===undefined?"":` ${Number(c.qty)>0?"多":"空"}`;
    if(!c.ok){lines.push(`  ${c.symbol}${side} 平仓失败：${c.error??"未知"}`);continue;}
    const pnl=c.realizedPnl==null?null:Number(c.realizedPnl);
    if(pnl!==null){total+=pnl;known+=1;}
    // Older records carry only the net figure, so the breakdown is shown for
    // the legs that have it rather than faked as zero fees for the ones that don't.
    const hasSplit=c.grossPnl!=null&&c.commission!=null;
    if(hasSplit){gross+=Number(c.grossPnl);fees+=Number(c.commission);split+=1;}
    if(c.funding!=null){funding+=Number(c.funding);fundingKnown+=1;}
    // == null, not === undefined: a missing exit price used to arrive as JSON
    // null (NaN serialised) and printed the word "null" as the fill price.
    const entry=price(c.entryPrice),exit=price(c.exitPrice);
    const prices=entry&&exit?`  ${entry} → ${exit}`:entry?`  ${entry} → ?`:"";
    // Legs that took themselves off before the clock ran out.
    const reason=c.exitReason?` [${String(c.exitReason)}]`:"";
    lines.push(`  ${c.symbol}${side} ${Math.abs(Number(c.qty))}${prices}${reason}  ${pnl===null?"盈亏未知":`${signed(pnl)} USDC`}`);
    // Funding first among the costs — over an eight-hour hold it dwarfs the
    // commission, and it is the one the operator steers by.
    if(hasSplit)lines.push(`      涨跌 ${signed(Number(c.grossPnl))}`
      +(c.funding!=null?`   资金费 ${signed(Number(c.funding))}`:"")
      +`   手续费 ${signed(-Math.abs(Number(c.commission)))}`);
  }
  // Only sum what actually came back with a settlement: a total that silently
  // treats an unknown leg as zero reads as a smaller loss than the real one.
  if(known){
    const missing=closed.filter((c)=>c.ok).length-known;
    lines.push("",`已实现合计 ${signed(total)} USDC${missing?`（${missing} 笔盈亏未取到，未计入）`:""}`);
    if(split)lines.push(`  涨跌 ${signed(gross)}`
      +(fundingKnown?`   资金费 ${signed(funding)}`:"")
      +`   手续费 ${signed(-Math.abs(fees))}${split<known?`（${known-split} 笔无拆分数据）`:""}`);
  }
  if(payload.balanceUsdc!=null)lines.push(`账户余额 ${Number(payload.balanceUsdc).toFixed(2)} USDC`);
  if(failed.length){
    const platform=String(payload.platform??"variational")==="binance"?"Binance":"Variational";
    lines.push("",`⚠ 有仓位没平掉，去 ${platform} 界面确认。`);
  }
  return lines.join("\n");
}

/** One coin of the basket, sent as it is placed. */
export function formatGainersLeg(payload:Record<string,unknown>){
  const mode=String(payload.mode??"");
  const base=String(payload.base??"?"),change=Number(payload.changePercent);
  const lbHours=typeof payload.lookbackHours==="number"?payload.lookbackHours:52;
  const lev=typeof payload.leverage==="number"?payload.leverage:2;
  if(payload.error)return [`❌ ${mode} 开仓失败 ${base}`,`${lbHours}h 涨跌 ${change>=0?"+":""}${change.toFixed(1)}%`,String(payload.error)].join("\n");
  const dir=String(payload.direction??"LONG")==="SHORT"?"空单":"多单";
  const lines=[`✅ ${mode} 已开 ${base} ${lev}x${dir}`,`${lbHours}h 涨跌 ${change>=0?"+":""}${change.toFixed(1)}%`];
  if(payload.margin!==undefined)lines.push(`保证金 ${Number(payload.margin).toFixed(2)} USDC`);
  if(payload.entryPrice!==undefined)lines.push(`入场 ${payload.entryPrice}`);
  if(payload.takeProfit!==undefined)lines.push(`止盈 ${Number(payload.takeProfit).toPrecision(6)}（+15%）`);
  if(payload.stopLoss!==undefined)lines.push(`止损 ${Number(payload.stopLoss).toPrecision(6)}（-80%）`);
  if(payload.quantity!==undefined)lines.push(`数量 ${payload.quantity}`);
  return lines.join("\n");
}
