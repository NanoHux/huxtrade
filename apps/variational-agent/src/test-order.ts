import { randomUUID } from "node:crypto";
import { getConfig } from "@huxtrade/config";
import type { OrderPlan } from "@huxtrade/shared-types";
import { BrowserFetchTransport } from "./browser-fetch-transport.js";
import { OmniBrowserAdapter } from "./omni-adapter.js";

// Manual, operator-run tool for Stage 0 protocol discovery (DISCOVERY.md item
// 3: limit-entry lifecycle). Deliberately outside the automated pipeline —
// it does not read LIVE_TRADING_ENABLED and never runs unattended. Every
// number is a required CLI argument so nothing about what gets submitted is
// implicit or defaulted.
//
// Usage:
//   pnpm --filter @huxtrade/variational-agent test-order -- BTCUSDT LONG 50000 10
//   args: <symbol> <LONG|SHORT> <entryPrice> <marginUsdc>
//   stopLoss/takeProfit are auto-derived at a fixed 1.5R (2%/3% offset) so
//   the only judgment call you make is the entry price and size.

const [symbol,directionArg,entryPriceArg,marginArg]=process.argv.slice(2).filter((arg)=>arg!=="--");
if(!symbol||!directionArg||!entryPriceArg||!marginArg){
  console.error("Usage: test-order <symbol e.g. BTCUSDT> <LONG|SHORT> <entryPrice> <marginUsdc>");
  process.exit(1);
}
const direction=directionArg.toUpperCase();
if(direction!=="LONG"&&direction!=="SHORT"){console.error("direction must be LONG or SHORT");process.exit(1);}
const entryPrice=Number(entryPriceArg);
const marginUsdc=Number(marginArg);
if(!Number.isFinite(entryPrice)||entryPrice<=0){console.error("entryPrice must be a positive number");process.exit(1);}
if(!Number.isFinite(marginUsdc)||marginUsdc<=0||marginUsdc>20){console.error("marginUsdc must be between 0 and 20 (spec 8.2 ceiling)");process.exit(1);}

const long=direction==="LONG";
const stopLoss=long?entryPrice*0.98:entryPrice*1.02;
const takeProfit=long?entryPrice*1.03:entryPrice*0.97;
const leverage=5;
const plan:OrderPlan={
  idempotencyKey:randomUUID(),symbol:symbol.toUpperCase(),direction,
  entryPrice,stopLoss,takeProfit,expectedRiskReward:1.5,
  marginUsdc,leverage,notionalUsdc:marginUsdc*leverage
};

console.log("About to submit a REAL limit order to Variational:");
console.log(JSON.stringify(plan,null,2));
console.log("Waiting 5 seconds — Ctrl+C now to abort.");
await new Promise((resolve)=>setTimeout(resolve,5_000));

const config=getConfig();
const transport=new BrowserFetchTransport(config);
const adapter=new OmniBrowserAdapter(transport,config);
try{
  const entry=await adapter.submitEntry(plan as unknown as Record<string,unknown>);
  console.log("Entry submitted:",JSON.stringify(entry,null,2));
  const tp=await adapter.placeTakeProfit(entry,plan);
  const sl=await adapter.placeStopLoss(entry,plan);
  console.log("Take-profit RFQ:",tp.id);
  console.log("Stop-loss RFQ:",sl.id);
  console.log("");
  console.log(`To cancel: pnpm --filter @huxtrade/variational-agent test-cancel -- ${entry.id}`);
}finally{
  await transport.close();
  process.exit(0);
}
