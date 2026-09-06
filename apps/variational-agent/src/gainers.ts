import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { getConfig } from "@huxtrade/config";
import { query } from "@huxtrade/database";
import { BrowserFetchTransport } from "./browser-fetch-transport.js";
import { OmniBrowserAdapter } from "./omni-adapter.js";
import { aliasesFrom,BASKET,binanceGainers,buildPlans,DEPLOY_FRACTION,LEVERAGE,LONG_WEIGHT,parseVenueAssets,selectPair,TAKE_PROFIT_FRACTION } from "./gainers-core.js";

/**
 * Binance 52h gainers, pure long on Variational.
 *
 * Ranking happens on Binance because that is where the backtest ranked; the
 * fills happen on Variational, which lists 534 assets against Binance's ~500,
 * so roughly a third of any evening's top five has nowhere to go. The rule is
 * to fill whatever matched and split the balance across those, not to shrink
 * the book to the ones that did — a two-name evening still deploys everything.
 *
 * `plan` reads and prints; it touches nothing. `open` submits real orders and
 * `close` flattens. Both write commands wait, print what they are about to do,
 * and require the operator to be watching — this is not wired to a scheduler.
 *
 *   pnpm --filter @huxtrade/variational-agent gainers -- plan
 *   pnpm --filter @huxtrade/variational-agent gainers -- plan --margin 10
 *   pnpm --filter @huxtrade/variational-agent gainers -- open --margin 10
 *   pnpm --filter @huxtrade/variational-agent gainers -- close
 */

const args=process.argv.slice(2).filter((a)=>a!=="--");
const command=args[0]??"plan";
if(!["plan","open","close"].includes(command)){console.error("Usage: gainers <plan|open|close> [--margin N]");process.exit(1);}
// --only lets a half-filled basket be completed without doubling the side that
// already went in: on 2026-08-12 every short was rejected and the longs were
// already open, so re-running the whole basket was not an option.
const onlyFlag=args.indexOf("--only");
const only=onlyFlag>=0?String(args[onlyFlag+1]??"").toUpperCase():null;
if(only&&only!=="LONG"&&only!=="SHORT"){console.error("--only must be LONG or SHORT");process.exit(1);}
const marginFlag=args.indexOf("--margin");
const fixedMargin=marginFlag>=0?Number(args[marginFlag+1]):undefined;
if(marginFlag>=0&&(!Number.isFinite(fixedMargin!)||fixedMargin!<=0)){console.error("--margin must be a positive number");process.exit(1);}
// The evening's entry ids, so the morning's close is deterministic in a fresh
// process. closeMarket resolves an entry from its own in-memory cache first,
// which is empty nine hours later.
const STATE="/tmp/huxtrade-gainers-open.json";

const config=getConfig();
const transport=new BrowserFetchTransport(config);
const adapter=new OmniBrowserAdapter(transport,config);

if(command==="close"){
  const saved=existsSync(STATE)?JSON.parse(readFileSync(STATE,"utf8")) as Array<{symbol:string;entryId:string}>:[];
  if(!saved.length){
    console.log(`没有找到 ${STATE}，无法确定要平哪些仓。`);
    console.log("用 test-scaleout inspect <ASSET> 查看持仓，或在 Variational 界面手动平仓。");
    await transport.close?.();process.exit(1);
  }
  console.log(`准备平掉 ${saved.length} 个仓位。10 秒内 Ctrl+C 可中止。`);
  await new Promise((r)=>setTimeout(r,10_000));
  let failed=0;
  for(const {symbol,entryId} of saved){
    try{
      const result=await adapter.closeMarket(entryId);
      console.log(`  ${symbol.padEnd(12)} closed=${result.closed}`);
      if(!result.closed)failed+=1;
    }catch(error){
      failed+=1;
      console.log(`  ${symbol.padEnd(12)} 失败: ${error instanceof Error?error.message:String(error)}`);
    }
  }
  // The file is only cleared when every leg is actually flat; a partial close
  // that forgot its ids would leave positions open with nothing pointing at them.
  if(!failed){writeFileSync(STATE,"[]");console.log("全部平仓完成。");}
  else console.log(`${failed} 个未能平掉 —— ${STATE} 保留，去界面确认后再重跑。`);
  await transport.close?.();process.exit(failed?1:0);
}

// Falls back only when the database is unreachable — this tool runs on the
// host, where the container hostname does not resolve. The fallback is
// announced rather than assumed: a silently stale alias map buys the wrong
// coin, which is the one failure mode that costs real money.
const FALLBACK=new Map([["LIT","LIGHTER"],["PUMP","PUMPFUN"]]);
let aliases=new Map<string,string>();
try{
  aliases=aliasesFrom((await query<{binance_symbol:string;variational_url:string}>("SELECT binance_symbol,variational_url FROM assets")).rows);
  console.log(`别名表：从数据库读到 ${aliases.size} 条`);
}catch(error){
  aliases=new Map(FALLBACK);
  console.log(`⚠ 数据库读不到（${error instanceof Error?error.message:String(error)}），别名退回内置的 ${aliases.size} 条`);
}

const [venueRaw,ranked]=await Promise.all([adapter.supportedAssets!(),binanceGainers()]);
const venue=parseVenueAssets(venueRaw);
const {longs,shorts,matched,unmatched}=selectPair(ranked,venue,aliases);
const account=await adapter.account();
const budget=fixedMargin?fixedMargin*matched.length:account.balanceUsdc*DEPLOY_FRACTION;
const margins=fixedMargin
  ?{long:fixedMargin,short:fixedMargin}
  :{long:longs.length?budget*LONG_WEIGHT/longs.length:0,short:shorts.length?budget*(1-LONG_WEIGHT)/shorts.length:0};

console.log(`\n入选（Binance 合约全市场 52h 涨幅榜前 ${BASKET}，且 Variational 可开仓）：`);
for(const p of longs)console.log(`  做多 ${p.base.padEnd(12)}${p.changePercent.toFixed(2).padStart(8)}%   价 ${p.venuePrice}`);
if(unmatched.length){
  console.log(`\n排名更高但跳过：`);
  for(const u of unmatched){
    console.log(`  ${u.base.padEnd(12)}${u.changePercent.toFixed(2).padStart(8)}%   ${u.reason}${u.similar.length?`   相似名：${u.similar.join(" ")}（需人工确认）`:""}`);
  }
}
console.log(`\n账户余额 ${account.balanceUsdc.toFixed(2)} USDC   多头每单 ${margins.long.toFixed(2)}（${(100*LONG_WEIGHT).toFixed(0)}%）  空头每单 ${margins.short.toFixed(2)}（${(100*(1-LONG_WEIGHT)).toFixed(0)}%）${fixedMargin?"  ⚠ 命令行指定，不分权重":""}   杠杆 ${LEVERAGE}x   止盈 ${(100*TAKE_PROFIT_FRACTION).toFixed(0)}%`);

const selected=only?matched.filter((p)=>(p.direction??"LONG")===only):matched;
if(only)console.log(`\n⚠ 只提交 ${only} 腿（${selected.length} 条），另一侧跳过`);
const plans=buildPlans(selected,margins);
console.log(`\n将要提交 ${plans.length} 单：`);
for(const p of plans)console.log(`  ${p.venueSymbol!.padEnd(12)} ${p.direction.padEnd(5)} 入场 ${p.entryPrice}  止损 ${p.stopLoss.toPrecision(6)} (-80%)  止盈 ${p.takeProfit.toPrecision(6)} (${p.direction==="LONG"?"+":"-"}${(100*TAKE_PROFIT_FRACTION).toFixed(0)}%)  保证金 ${p.marginUsdc.toFixed(2)}  名义 ${p.notionalUsdc.toFixed(2)}`);

// The venue enforces a minimum notional and silently re-quotes anything under
// it: ON was planned at 100 USDC of margin and filled at the 1500 USDC floor,
// fifteen times the intended size. A 10 USDC test order is far below any
// plausible floor, so ask the venue what it would actually fill BEFORE
// anything is submitted.
console.log("\n向平台询价，确认每单的最低名义（不提交任何订单）：");
let unsafe=0;
for(const plan of plans){
  try{
    const floor=await adapter.minimumMargin(plan);
    const ratio=floor/plan.marginUsdc;
    const flag=ratio>1.05?`  ⚠ 会被放大 ${ratio.toFixed(1)}x`:"  ok";
    if(ratio>1.05)unsafe+=1;
    console.log(`  ${plan.venueSymbol!.padEnd(12)}想要 ${plan.marginUsdc.toFixed(2)}  平台最低 ${floor.toFixed(2)}${flag}`);
  }catch(error){
    unsafe+=1;
    console.log(`  ${plan.venueSymbol!.padEnd(12)}询价失败: ${error instanceof Error?error.message:String(error)}`);
  }
}
if(unsafe){
  console.log(`\n${unsafe} 单的实际成交规模会超过你指定的保证金。`);
  if(command==="open"){console.log("已中止 —— 提高 --margin 到平台最低之上，或明确接受放大后再跑。");await transport.close?.();process.exit(1);}
}

if(command==="plan"){
  console.log("\n（plan 模式：什么都没提交）");
  await transport.close?.();process.exit(0);
}

console.log("\n即将向 Variational 提交真实订单。10 秒内 Ctrl+C 可中止。");
await new Promise((r)=>setTimeout(r,10_000));
const opened:Array<{symbol:string;entryId:string}>=[];
for(const plan of plans){
  try{
    const entry=await adapter.submitMarketEntry(plan as unknown as Record<string,unknown>,{skipProtection:false});
    console.log(`  ${plan.venueSymbol} -> ${JSON.stringify({id:entry.id,state:entry.state})}`);
    opened.push({symbol:plan.venueSymbol!,entryId:entry.id});
    // Persist after every fill, not at the end: a crash halfway through must
    // not lose the ids of the legs already open.
    writeFileSync(STATE,JSON.stringify(opened,null,2));
  }catch(error){
    console.log(`  ${plan.venueSymbol} 失败: ${error instanceof Error?error.message:String(error)}`);
  }
}
console.log(`\n已开 ${opened.length} 单，entry id 存在 ${STATE}`);
console.log("明早 07:00 平仓：pnpm --filter @huxtrade/variational-agent gainers -- close");
await transport.close?.();
process.exit(0);
