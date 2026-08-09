import { describe,expect,it } from "vitest";
import {
  formatAssetResumed,formatBreakevenStopFailed,formatDirectionHalted,formatClosed,formatEntryFilled,formatGeneric,formatMarginPauseResume,
  formatOrderCreated,formatOrderFailed,formatScaledOut,formatServiceRecovered,formatSessionLost,formatSignal,formatSystemError
} from "./format.js";
import { formatAccount,formatPlans,formatPnl,formatPositions,formatStatus,formatWorkingOrders,parseCommand } from "./commands.js";

const order={code:"XPL",direction:"SHORT",entryPrice:"0.07267",stopLoss:"0.07132",takeProfit:"0.07976",leverage:5,marginUsdc:"10",realizedPnl:null};

describe("formatOrderCreated",()=>{
  it("renders the PROTECTED payload's prices/margin/leverage without any raw JSON",()=>{
    const text=formatOrderCreated(order);
    expect(text).toContain("XPL 空单");
    expect(text).toContain("入场 0.07267 / 止损 0.07132 / 止盈 0.07976");
    expect(text).toContain("5x 杠杆");
    expect(text).not.toMatch(/rfq_id|submittedPrices|\{"/);
  });

  it("computes the risk/reward ratio from entry/stop/target for a consistent LONG example",()=>{
    const long={code:"XPL",direction:"LONG",entryPrice:"0.07267",stopLoss:"0.07132",takeProfit:"0.07976",leverage:5,marginUsdc:"10",realizedPnl:null};
    expect(formatOrderCreated(long)).toContain("盈亏比 1:5.25");
  });
});

describe("formatOrderFailed",()=>{
  it("surfaces details.error over the generic reason, matching the real XPL leverage-mismatch message",()=>{
    const text=formatOrderFailed({reason:"pre-submit validation failed",details:{error:"Variational leverage for XPL is 10x; expected 5x"},toState:"SUBMISSION_FAILED"},order);
    expect(text).toBe("[HuxTrade] 下单失败 - XPL 空单\n原因：Variational leverage for XPL is 10x; expected 5x");
  });

  it("flags manual intervention and lists sub-errors when protection creation partially failed",()=>{
    const text=formatOrderFailed({reason:"initial protection compensation: MANUAL_INTERVENTION",details:{status:"MANUAL_INTERVENTION",errors:["TP creation: timeout","SL creation: timeout"]}},order);
    expect(text).toContain("原因：需要人工介入处理");
    expect(text).toContain("  · TP creation: timeout");
    expect(text).toContain("需要人工去 Variational 上核对处理");
  });

  it("still produces a readable message when no order context is available",()=>{
    expect(formatOrderFailed({reason:"AMBIGUOUS_SUBMISSION_AFTER_RESTART",manualIntervention:true})).toBe(
      "[HuxTrade] 下单失败\n原因：Agent 重启时这笔订单正在提交，状态不明确\n⚠️ 需要人工去 Variational 上核对处理"
    );
  });
});

describe("formatEntryFilled",()=>{
  it("uses the actual fill price/quantity when available",()=>{
    const text=formatEntryFilled(order,[{price:"0.07267",quantity:"688",side:"sell",filledAt:"2026-08-06T00:00:00Z"}]);
    expect(text).toBe("[HuxTrade] 已成交开仓 - XPL 空单\n成交价 0.07267，数量 688\n止盈 0.07976 / 止损 0.07132");
  });
});

describe("formatClosed",()=>{
  it("labels a stop-loss close and shows entry/exit prices with signed PnL",()=>{
    const fills=[{price:"0.07267",quantity:"688",side:"sell",filledAt:"t1"},{price:"0.07132",quantity:"688",side:"buy",filledAt:"t2"}];
    const text=formatClosed("CLOSED_SL",{...order,realizedPnl:"-9.29"},fills);
    expect(text).toBe("[HuxTrade] 止损平仓 - XPL 空单\n成交价 0.07267 → 平仓价 0.07132\n已实现盈亏：-9.29 USDC");
  });

  it("labels a liquidation distinctly from a normal stop-loss close",()=>{
    expect(formatClosed("LIQUIDATED",order,[])).toContain("强平 - XPL 空单");
  });

  it("labels a take-profit close with a positive sign on PnL",()=>{
    const text=formatClosed("CLOSED_TP",{...order,realizedPnl:"12.34"},[]);
    expect(text).toContain("止盈平仓 - XPL 空单");
    expect(text).toContain("已实现盈亏：+12.34 USDC");
  });

  it("labels a direction-reversal close distinctly from TP/SL/liquidation",()=>{
    expect(formatClosed("CLOSED_REVERSED",order,[])).toContain("反向信号平仓 - XPL 空单");
  });
});

describe("formatSignal",()=>{
  it("shows translated rejection reasons only when the signal wasn't executable",()=>{
    const text=formatSignal({symbol:"HYPE",direction:"SHORT",accepted:true,executable:false,rejectionReasons:["LIVE_TRADING_DISABLED"]});
    expect(text).toBe("[HuxTrade] 策略信号 - HYPE 空单\n条件通过但暂未执行\n原因：真实交易开关未开启");
  });

  it("omits the reason line for an executable signal",()=>{
    const text=formatSignal({symbol:"HYPE",direction:"SHORT",accepted:true,executable:true,rejectionReasons:[]});
    expect(text).toBe("[HuxTrade] 策略信号 - HYPE 空单\n条件全部满足，已提交下单");
  });
});

describe("formatSystemError",()=>{
  it("prefers the detailed message over the bare reason code",()=>{
    expect(formatSystemError({service:"variational-agent",reason:"SERVICE_RESTART_FAILED",message:"variational-agent did not report health within 90s"})).toBe(
      "[HuxTrade] 系统异常 - variational-agent\n原因：variational-agent did not report health within 90s"
    );
  });

  it("passes through a raw fetch error for an asset-level failure",()=>{
    expect(formatSystemError({asset:"BTC",reason:"fetch failed"})).toBe("[HuxTrade] 系统异常 - BTC\n原因：fetch failed");
  });
});

describe("other simple templates",()=>{
  it("formatAssetResumed",()=>{
    expect(formatAssetResumed({asset:"BTC",previousReason:"DATA_ERROR: fetch failed"})).toBe("[HuxTrade] 币种已自动恢复监控 - BTC\n之前的暂停原因已解除，重新纳入扫描");
  });
  it("formatSessionLost",()=>{
    expect(formatSessionLost()).toContain("Variational 登录已失效");
  });
  it("formatMarginPauseResume for a pause",()=>{
    expect(formatMarginPauseResume({transition:"PAUSE",marginUsagePercent:82.345})).toBe("[HuxTrade] 保证金占用过高，已自动暂停开新仓\n当前保证金占用：82.3%");
  });
  it("formatServiceRecovered",()=>{
    expect(formatServiceRecovered({service:"signal-engine"})).toBe("[HuxTrade] 服务已恢复 - signal-engine");
  });
});

describe("formatGeneric",()=>{
  it("never dumps nested objects/arrays, even for an unmapped topic",()=>{
    const text=formatGeneric("notification.something_new",{a:1,nested:{x:1},list:[1,2],reason:"ok"});
    expect(text).toBe("[HuxTrade] something_new\na: 1\nreason: ok");
  });
});

describe("chat commands",()=>{
  it("recognises a command with a bot suffix or trailing arguments",()=>{
    expect(parseCommand("/acc")).toBe("/acc");
    expect(parseCommand("  /status  ")).toBe("/status");
    expect(parseCommand("/pos@HuxTradeBot")).toBe("/pos");
    expect(parseCommand("/pnl today please")).toBe("/pnl");
    expect(parseCommand("/PNL")).toBe("/pnl");
  });

  it("treats anything else as ordinary chat, not a command",()=>{
    expect(parseCommand("status")).toBeNull();
    expect(parseCommand("/unknown")).toBeNull();
    expect(parseCommand("买点 BTC 吧")).toBeNull();
    expect(parseCommand(undefined)).toBeNull();
    expect(parseCommand("")).toBeNull();
  });

  it("reports an unhealthy service and a paused asset rather than a bare OK",()=>{
    const text=formatStatus({
      services:[{service:"api",state:"healthy"},{service:"variational-agent",state:"degraded",error:"session invalid"}],
      globalPaused:false,liveTrading:true,executionMode:"live",strategyName:"TwoSignal",entryKind:"RESTING_LIMIT",
      pausedAssets:[{code:"JUP",reason:"REPEATED_SUBMISSION_FAILURE"}],assetCount:17,lastScanAt:"2026-08-07T15:45:00Z"
    });
    expect(text).toContain("⚠️");
    expect(text).toContain("1/2 正常");
    expect(text).toContain("variational-agent：degraded");
    expect(text).toContain("驻留限价入场");
    expect(text).toContain("JUP：REPEATED_SUBMISSION_FAILURE");
  });

  it("flags an account that has auto-paused on margin",()=>{
    const text=formatAccount({balanceUsdc:271.64,marginUsagePercent:84.3,autoPaused:true,loggedIn:true,reconciled:true,openPositions:2,workingOrders:10});
    expect(text).toContain("84.3%");
    expect(text).toContain("自动暂停开新仓");
  });

  it("says plainly when there is nothing to show",()=>{
    expect(formatPositions([])).toBe("当前没有持仓。");
    expect(formatWorkingOrders([])).toBe("当前没有工作中的挂单。");
    expect(formatPlans([])).toBe("最近没有产生动作的决策。");
  });

  it("totals unrealized PnL across positions",()=>{
    const text=formatPositions([
      {code:"ZEC",direction:"SHORT",entryPrice:512.271,stopLoss:515.632,takeProfit:484.129,unrealizedPnl:3.34,openedMinutes:135},
      {code:"ETH",direction:"LONG",entryPrice:1925.63,stopLoss:1887.45,takeProfit:1987.6,unrealizedPnl:-0.9,openedMinutes:20}
    ]);
    expect(text).toContain("浮动合计 +2.44");
    expect(text).toContain("ZEC 空单");
    expect(text).toContain("已持有 2.3小时");
  });

  it("does not claim a win rate before anything has reached a protection order",()=>{
    // Every exit so far has been a reversal close, so a win rate would be
    // invented from trades that were never allowed to resolve.
    const text=formatPnl({todayRealized:3.136,totalRealized:3.136,filled:4,placed:14,
      byExit:[{state:"CLOSED_REVERSED",count:4,realized:3.136}]});
    expect(text).toContain("还没有走到止盈或止损的样本");
    expect(text).toContain("方向反转平仓　4 笔　+3.14");
    expect(text).toContain("+3.14 USDC");
  });

  it("computes the win rate once protections have resolved trades",()=>{
    const text=formatPnl({todayRealized:1,totalRealized:5,filled:10,placed:20,
      byExit:[{state:"CLOSED_TP",count:3,realized:9},{state:"CLOSED_SL",count:1,realized:-4}]});
    expect(text).toContain("胜率　75%");
  });
});

describe("formatScaledOut",()=>{
  it("states the trigger, what was banked, and where the survivor's stop now sits",()=>{
    const text=formatScaledOut({code:"ZRO",direction:"SHORT",profitR:0.53,fraction:0.5,
      quantity:894.6,price:"0.8341",realizedPnl:3.52,breakevenStop:0.8379});
    expect(text).toContain("分批止盈 - ZRO 空单");
    expect(text).toContain("浮盈达到 0.53R，已平掉 50% 仓位");
    expect(text).toContain("落袋 +3.52 USDC");
    expect(text).toContain("保本 0.8379");
    expect(text).not.toMatch(/rfq|\{"/);
  });
  it("still reads cleanly when the venue gave back no fill price",()=>{
    expect(formatScaledOut({code:"ZRO",direction:"SHORT",breakevenStop:0.8379})).toContain("已平掉部分仓位");
  });
});

describe("formatBreakevenStopFailed",()=>{
  it("says the remainder was closed when the fallback worked",()=>{
    const text=formatBreakevenStopFailed({code:"LIT",direction:"SHORT",error:"HTTP 400",remainderClosed:true});
    expect(text).toContain("保本止损挂单失败 - LIT 空单");
    expect(text).toContain("已自动平掉剩余仓位止血");
    expect(text).not.toContain("无止损运行");
  });
  it("escalates to manual intervention when even the fallback close failed",()=>{
    // Banked half, unprotected remainder: the one outcome that needs a human.
    const text=formatBreakevenStopFailed({code:"LIT",direction:"SHORT",error:"timeout",remainderClosed:false});
    expect(text).toContain("⚠️ 剩余仓位也没能平掉");
    expect(text).toContain("请立刻去 Variational 核对");
  });
});

describe("formatScaledOut when price retraced through breakeven",()=>{
  it("reads as a normal breakeven exit, not as a failure",()=>{
    const text=formatScaledOut({code:"BTC",direction:"LONG",profitR:0.51,fraction:0.5,
      price:"64723.71",realizedPnl:1.2,breakevenStop:64884.98,remainderClosedAtBreakeven:true});
    expect(text).toContain("剩余仓位按保本离场");
    expect(text).not.toContain("止损已移至保本");
    expect(text).not.toContain("⚠️");
  });
  it("escalates only when the remainder could not actually be closed",()=>{
    const text=formatScaledOut({code:"BTC",direction:"LONG",breakevenStop:64884.98,
      remainderClosedAtBreakeven:true,closeError:"timeout"});
    expect(text).toContain("⚠️");
    expect(text).toContain("剩余仓位平仓失败");
  });
});

describe("formatDirectionHalted",()=>{
  it("says which side stopped, why, and that positions are untouched",()=>{
    const text=formatDirectionHalted({direction:"SHORT",count:3,until:"2026-08-09T14:00:00Z"});
    expect(text).toContain("空单方向已熔断");
    expect(text).toContain("3 笔亏损止损");
    expect(text).toContain("已有持仓不受影响");
  });
});
