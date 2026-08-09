import { randomUUID } from "node:crypto";
import { appendFile, chmod, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getConfig } from "@huxtrade/config";
import type { OrderPlan } from "@huxtrade/shared-types";
import { BrowserFetchTransport } from "./browser-fetch-transport.js";
import { redactDiscoveryValue } from "./discovery-utils.js";
import { OmniBrowserAdapter } from "./omni-adapter.js";

// Phase 0 of the resting limit entry model: prove the platform actually
// supports a limit order that SITS there. Operator-run only — like
// test-order.ts it ignores LIVE_TRADING_ENABLED, never runs unattended, and
// takes every number as an explicit argument.
//
// The whole point is that these answers cannot be derived from the read-only
// discovery capture: they are behaviours over time (does the order survive an
// hour? does it lock margin? do its TP/SL exist before it fills?), so they
// have to be observed against one real, minimum-size order.
//
//   pnpm --filter @huxtrade/variational-agent test-resting -- place BTCUSDT LONG 95000 10
//   pnpm --filter @huxtrade/variational-agent test-resting -- watch <rfqId> 150 300
//   pnpm --filter @huxtrade/variational-agent test-resting -- protections <underlying>
//   pnpm --filter @huxtrade/variational-agent test-resting -- cancel <rfqId>
//   pnpm --filter @huxtrade/variational-agent test-resting -- pages
//
// Covers: P0-1 resting/TTL (place + watch), P0-2 margin lock (place),
// P0-3 pre-activation TP/SL (place + protections + cancel), P0-4 cancel
// round-trip (cancel), P0-5 restart takeover (restart the agent mid-watch),
// P0-6 fill price semantics (watch records the fill trade), P0-7 paging.

type JsonRecord=Record<string,unknown>;
const isRecord=(value:unknown):value is JsonRecord=>Boolean(value)&&typeof value==="object"&&!Array.isArray(value);
const rows=(value:unknown):JsonRecord[]=>{
  const page=isRecord(value)?value.result:undefined;
  return Array.isArray(page)?page.filter(isRecord):[];
};
const typeOf=(order:JsonRecord)=>String(order.order_type??"").toLowerCase();
const underlyingOf=(order:JsonRecord)=>String((isRecord(order.instrument)?order.instrument.underlying:undefined)??"");
const protectionTypes=["take_profit","stop_loss"];

const [command,...args]=process.argv.slice(2).filter((arg)=>arg!=="--");
const commands=["place","watch","protections","cancel","pages"];
if(!command||!commands.includes(command)){
  console.error(`Usage: test-resting <${commands.join("|")}> [...]`);
  process.exit(1);
}

const config=getConfig();
const output=resolve(config.VARIATIONAL_DISCOVERY_OUTPUT);
await mkdir(output,{recursive:true});
const logPath=join(output,`resting-phase0-${new Date().toISOString().replace(/[:.]/g,"-")}.jsonl`);
await appendFile(logPath,"",{encoding:"utf8",mode:0o600});
try{await chmod(logPath,0o600);}catch{}
async function record(check:string,event:string,detail:unknown){
  await appendFile(logPath,`${JSON.stringify({at:new Date().toISOString(),check,event,detail:redactDiscoveryValue(detail)})}\n`,"utf8");
}

const transport=new BrowserFetchTransport(config);
const adapter=new OmniBrowserAdapter(transport,config);

/** P0-2: initial_margin is the number that answers "does a resting order lock margin?". */
async function marginSnapshot(label:string){
  const portfolio=await transport.request("/api/portfolio?compute_margin=true");
  const usage=isRecord(portfolio)&&isRecord(portfolio.margin_usage)?portfolio.margin_usage:{};
  const snapshot={label,balance:isRecord(portfolio)?portfolio.balance:null,initialMargin:usage.initial_margin??null,maintenanceMargin:usage.maintenance_margin??null};
  await record("P0-2",`portfolio:${label}`,{snapshot,portfolio});
  return snapshot;
}

const pending=async()=>rows(await transport.request("/api/orders/v2?status=pending&limit=100&offset=0&order_by=created_at&order=desc"));
const trades=async()=>rows(await transport.request("/api/trades?limit=100&offset=0&order_by=created_at&order=desc"));

async function place(){
  const [symbol,directionArg,entryPriceArg,marginArg]=args;
  if(!symbol||!directionArg||!entryPriceArg||!marginArg){
    console.error("Usage: test-resting place <symbol e.g. BTCUSDT> <LONG|SHORT> <entryPrice> <marginUsdc>");
    process.exit(1);
  }
  const direction=directionArg.toUpperCase();
  if(direction!=="LONG"&&direction!=="SHORT"){console.error("direction must be LONG or SHORT");process.exit(1);}
  const entryPrice=Number(entryPriceArg),marginUsdc=Number(marginArg);
  if(!Number.isFinite(entryPrice)||entryPrice<=0){console.error("entryPrice must be a positive number");process.exit(1);}
  if(!Number.isFinite(marginUsdc)||marginUsdc<=0||marginUsdc>20){console.error("marginUsdc must be between 0 and 20 (spec 8.2 ceiling)");process.exit(1);}

  const long=direction==="LONG",leverage=5;
  const plan:OrderPlan={
    idempotencyKey:randomUUID(),symbol:symbol.toUpperCase(),direction,entryPrice,
    stopLoss:long?entryPrice*0.98:entryPrice*1.02,takeProfit:long?entryPrice*1.03:entryPrice*0.97,
    expectedRiskReward:1.5,marginUsdc,leverage,notionalUsdc:marginUsdc*leverage
  };
  console.log("About to submit a REAL resting limit order to Variational:");
  console.log(JSON.stringify(plan,null,2));
  console.log("The entry price must be FAR from the market (~2x 1h ATR) or this fills instantly and proves nothing.");
  console.log("Waiting 10 seconds — Ctrl+C now to abort.");
  await new Promise((done)=>setTimeout(done,10_000));

  const before=await marginSnapshot("before-place");
  const entry=await adapter.submitEntry(plan as unknown as Record<string,unknown>);
  await record("P0-1","entry-submitted",{rfqId:entry.id,submittedPrices:entry.submittedPrices,quantity:entry.quantity,raw:entry.raw});
  const after=await marginSnapshot("after-place");

  const open=await pending();
  const mine=open.find((order)=>order.rfq_id===entry.id);
  await record("P0-1","pending-after-place",{found:Boolean(mine),order:mine??null,pendingCount:open.length});

  // P0-3: the TP/SL rfq ids come back on the entry response, but they must not
  // yet be live reduce-only orders — if they are, the platform is holding
  // protection against a position that does not exist.
  const underlying=symbol.toUpperCase().replace(/USDT$/i,"");
  const protections=open.filter((order)=>protectionTypes.includes(typeOf(order))&&underlyingOf(order)===underlying);
  await record("P0-3","protections-before-fill",{underlying,activeProtectionCount:protections.length,protections});

  console.log("");
  console.log(`RFQ id:            ${entry.id}`);
  console.log(`Appears in pending: ${Boolean(mine)}`);
  console.log(`P0-2 initial_margin ${before.initialMargin} -> ${after.initialMargin}  (a rise means resting orders LOCK margin)`);
  console.log(`P0-3 active TP/SL on ${underlying} before fill: ${protections.length} (expected 0)`);
  console.log("");
  console.log(`Next: test-resting watch ${entry.id} 150 300      # >=2h residency, P0-1`);
  console.log(`Then: test-resting cancel ${entry.id}             # P0-3 teardown + P0-4`);
  console.log(`Log:  ${logPath}`);
}

async function watch(){
  const [rfqId,minutesArg,intervalArg]=args;
  if(!rfqId){console.error("Usage: test-resting watch <rfqId> [minutes=150] [intervalSeconds=300]");process.exit(1);}
  const minutes=Number(minutesArg??150),intervalSeconds=Number(intervalArg??300);
  if(!Number.isFinite(minutes)||minutes<=0||!Number.isFinite(intervalSeconds)||intervalSeconds<30){
    console.error("minutes must be positive and intervalSeconds at least 30");process.exit(1);
  }
  const deadline=Date.now()+minutes*60_000;
  console.log(`Watching ${rfqId} every ${intervalSeconds}s for ${minutes} minutes. Restart variational-agent during this window to also cover P0-5.`);
  let disappearedAt:string|null=null;
  while(Date.now()<deadline){
    const open=await pending();
    const mine=open.find((order)=>order.rfq_id===rfqId);
    const fill=(await trades()).find((trade)=>trade.source_rfq===rfqId);
    await record("P0-1","residency-sample",{rfqId,stillPending:Boolean(mine),order:mine??null,fill:fill??null});
    console.log(`${new Date().toISOString()}  pending=${Boolean(mine)}  filled=${Boolean(fill)}`);
    if(fill){
      // P0-6: did it fill at the limit price, or at whatever the quote was?
      await record("P0-6","fill-price",{rfqId,fillPrice:fill.price,markPrice:fill.mark_price,quantity:fill.qty,trade:fill});
      console.log(`Filled at ${String(fill.price)} (mark ${String(fill.mark_price)}) — compare against the submitted limit price for P0-6.`);
      break;
    }
    if(!mine&&!disappearedAt){
      disappearedAt=new Date().toISOString();
      await record("P0-1","disappeared-unfilled",{rfqId,at:disappearedAt});
      console.log("Order left the pending list without a fill — the platform expired or cancelled it. Recorded for P0-1.");
      break;
    }
    await new Promise((done)=>setTimeout(done,intervalSeconds*1_000));
  }
  console.log(`Log: ${logPath}`);
}

async function protections(){
  const [underlying]=args;
  if(!underlying){console.error("Usage: test-resting protections <underlying e.g. BTC>");process.exit(1);}
  const open=await pending();
  const matching=open.filter((order)=>protectionTypes.includes(typeOf(order))&&underlyingOf(order)===underlying.toUpperCase());
  await record("P0-3","protections-snapshot",{underlying,count:matching.length,protections:matching});
  console.log(`${matching.length} active TP/SL order(s) on ${underlying.toUpperCase()}`);
  for(const order of matching)console.log(`  ${typeOf(order)}  rfq=${String(order.rfq_id)}  trigger=${String(order.trigger_price)}  status=${String(order.status)}`);
  console.log(`Log: ${logPath}`);
}

async function cancel(){
  const [rfqId,underlyingArg]=args;
  if(!rfqId){console.error("Usage: test-resting cancel <rfqId> [underlying e.g. BTC]");process.exit(1);}
  const before=await marginSnapshot("before-cancel");
  const result=await adapter.cancelEntry(rfqId);
  await record("P0-4","cancel-result",{rfqId,...result});
  const after=await marginSnapshot("after-cancel");
  const open=await pending();
  const stillThere=open.some((order)=>order.rfq_id===rfqId);
  const orphans=underlyingArg
    ?open.filter((order)=>protectionTypes.includes(typeOf(order))&&underlyingOf(order)===underlyingArg.toUpperCase())
    :[];
  await record("P0-3","protections-after-cancel",{underlying:underlyingArg??null,orphanCount:orphans.length,orphans});
  console.log(`cancelled=${result.cancelled}  state=${result.state}  stillPending=${stillThere}`);
  console.log(`P0-2 initial_margin ${before.initialMargin} -> ${after.initialMargin}`);
  if(underlyingArg)console.log(`P0-3 orphaned TP/SL on ${underlyingArg.toUpperCase()} after cancel: ${orphans.length} (expected 0)`);
  console.log(`Log: ${logPath}`);
}

/** P0-7: 15 assets x 1 order never approaches 100, but reconciliation reads history, which does. */
async function pages(){
  const seen=new Map<string,number>();
  let duplicates=0;
  for(const offset of [0,100,200]){
    const page=rows(await transport.request(`/api/orders/v2?limit=100&offset=${offset}&order_by=created_at&order=desc`));
    await record("P0-7","history-page",{offset,count:page.length,firstCreatedAt:page[0]?.created_at??null,lastCreatedAt:page.at(-1)?.created_at??null});
    for(const order of page){
      const id=String(order.rfq_id??"");
      if(seen.has(id))duplicates+=1;else seen.set(id,offset);
    }
    console.log(`offset=${offset}  rows=${page.length}`);
    if(page.length<100)break;
  }
  await record("P0-7","history-summary",{uniqueOrders:seen.size,duplicatesAcrossPages:duplicates});
  console.log(`unique rfq ids=${seen.size}  duplicated across pages=${duplicates} (expected 0)`);
  console.log(`Log: ${logPath}`);
}

try{
  if(command==="place")await place();
  else if(command==="watch")await watch();
  else if(command==="protections")await protections();
  else if(command==="cancel")await cancel();
  else await pages();
}finally{
  await transport.close();
  process.exit(0);
}
