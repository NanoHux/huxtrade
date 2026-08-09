import { getConfig } from "@huxtrade/config";
import { breakevenStopPrice, resolveRestingEntry, scaleOutDecision } from "@huxtrade/strategy-engine";
import { BrowserFetchTransport } from "./browser-fetch-transport.js";
import { OmniBrowserAdapter } from "./omni-adapter.js";

// Phase 0 for the scale-out path. Everything else in the adapter creates TP/SL
// as fields on the entry submission, so `placeProtection` — arming a stop on a
// position that already exists — is the one call in this feature that has never
// run against the venue. This proves it on one real position before the
// 30-second loop is ever allowed to do it unattended.
//
// Operator-run only, like test-order.ts and test-resting.ts: it ignores
// LIVE_TRADING_ENABLED and takes every number as an explicit argument.
//
//   pnpm --filter @huxtrade/variational-agent test-scaleout -- inspect BTC
//   pnpm --filter @huxtrade/variational-agent test-scaleout -- simulate BTC <entry> <stop>
//   pnpm --filter @huxtrade/variational-agent test-scaleout -- reduce  BTC <entryRfqId> <fraction>
//   pnpm --filter @huxtrade/variational-agent test-scaleout -- movestop BTC <LONG|SHORT> <triggerPrice>

type JsonRecord=Record<string,unknown>;
const isRecord=(value:unknown):value is JsonRecord=>Boolean(value)&&typeof value==="object"&&!Array.isArray(value);
const rows=(value:unknown):JsonRecord[]=>{const page=isRecord(value)?value.result:undefined;return Array.isArray(page)?page.filter(isRecord):[];};
const typeOf=(order:JsonRecord)=>String(order.order_type??"").toLowerCase();
const underlyingOf=(value:unknown)=>String((isRecord(value)?value.underlying:undefined)??"");

const [command,...args]=process.argv.slice(2).filter((arg)=>arg!=="--");
const commands=["inspect","simulate","reduce","movestop"];
if(!command||!commands.includes(command)){
  console.error(`Usage: test-scaleout <${commands.join("|")}> [...]`);
  process.exit(1);
}

const config=getConfig();
const transport=new BrowserFetchTransport(config);
const adapter=new OmniBrowserAdapter(transport,config);
const settings=resolveRestingEntry(null);

const positions=async()=>{const value=await transport.request("/api/positions");return Array.isArray(value)?value.filter(isRecord):[];};
const pending=async()=>rows(await transport.request("/api/orders/v2?status=pending&limit=100&offset=0&order_by=created_at&order=desc"));
const trades=async()=>rows(await transport.request("/api/trades?limit=100&offset=0&order_by=created_at&order=desc"));

async function snapshot(underlying:string){
  const [pos,pend,tr]=await Promise.all([positions(),pending(),trades()]);
  const position=pos.find((item)=>underlyingOf(isRecord(item.position_info)?item.position_info.instrument:undefined)===underlying);
  const protections=pend.filter((order)=>["take_profit","stop_loss"].includes(typeOf(order))&&underlyingOf(order.instrument)===underlying);
  const fills=tr.filter((item)=>underlyingOf(item.instrument)===underlying);
  return {position,protections,fills};
}

function show(underlying:string,snap:Awaited<ReturnType<typeof snapshot>>){
  const info=isRecord(snap.position?.position_info)?snap.position!.position_info as JsonRecord:{};
  const price=isRecord(snap.position?.price_info)?snap.position!.price_info as JsonRecord:{};
  console.log(`\n=== ${underlying} position ===`);
  if(!snap.position){console.log("  (no open position)");}
  else console.log(`  qty ${info.qty}  avg entry ${info.avg_entry_price}  mark ${price.price}  upnl ${snap.position.upnl}  opened ${info.opened_at}`);
  console.log(`\n=== protections (${snap.protections.length}) ===`);
  for(const order of snap.protections)console.log(`  ${typeOf(order).padEnd(12)} trigger ${order.trigger_price}  side ${order.side}  auto_resize ${order.is_auto_resize}  reduce_only ${order.is_reduce_only}  rfq ${order.rfq_id}`);
  console.log(`\n=== recent ${underlying} trades ===`);
  for(const fill of snap.fills.slice(0,6))console.log(`  ${String(fill.created_at).slice(11,19)}  ${fill.side} ${fill.qty} @ ${fill.price}  source_rfq ${fill.source_rfq}`);
  return {info,price};
}

if(command==="inspect"){
  const underlying=(args[0]??"BTC").toUpperCase();
  show(underlying,await snapshot(underlying));
}

if(command==="simulate"){
  const [underlyingArg,entryArg,stopArg]=args;
  if(!underlyingArg||!entryArg||!stopArg){console.error("Usage: test-scaleout simulate <underlying> <entryPrice> <stopLoss>");process.exit(1);}
  const underlying=underlyingArg.toUpperCase();
  const snap=await snapshot(underlying);
  const {info,price}=show(underlying,snap);
  const entryPrice=Number(entryArg),stopLoss=Number(stopArg);
  const markPrice=Number(price.price);
  const direction=Number(info.qty)>0?"LONG":"SHORT";
  const risk=Math.abs(entryPrice-stopLoss);
  console.log(`\n=== scale-out decision ===`);
  console.log(`  direction ${direction}  entry ${entryPrice}  stop ${stopLoss}  risk(1R) ${risk.toFixed(2)}  stop width ${(risk/entryPrice*100).toFixed(2)}%`);
  console.log(`  live mark ${markPrice}  -> ${((direction==="LONG"?markPrice-entryPrice:entryPrice-markPrice)/risk).toFixed(3)}R`);
  const decision=scaleOutDecision({direction,entryPrice,stopLoss,markPrice,alreadyScaledOut:false},settings);
  console.log(`  decision ${decision.action}: ${decision.reason}`);
  // What the loop would do at exactly the trigger, whatever the mark is now.
  const atTrigger=direction==="LONG"?entryPrice+risk*settings.scaleOutTriggerR:entryPrice-risk*settings.scaleOutTriggerR;
  console.log(`\n  at exactly ${settings.scaleOutTriggerR}R the mark would be ${atTrigger.toFixed(2)}`);
  console.log(`  would close ${Math.round(settings.scaleOutFraction*100)}% of ${info.qty ?? "?"}`);
  console.log(`  would move the stop to ${breakevenStopPrice(direction,entryPrice,stopLoss,settings).toFixed(2)} (entry + ${settings.breakevenOffsetR}R)`);
}

if(command==="reduce"){
  const [underlyingArg,entryRfqId,fractionArg]=args;
  if(!underlyingArg||!entryRfqId||!fractionArg){console.error("Usage: test-scaleout reduce <underlying> <entryRfqId> <fraction>");process.exit(1);}
  const underlying=underlyingArg.toUpperCase();
  console.log("BEFORE");show(underlying,await snapshot(underlying));
  const result=await adapter.closeMarketPartial(entryRfqId,Number(fractionArg));
  console.log(`\n=== closeMarketPartial -> ${JSON.stringify({closed:result.closed,rfqId:result.rfqId,quantity:result.quantity,remaining:result.remaining,tooSmall:result.tooSmall})} ===`);
  if(result.rfqId)console.log(`settlement ${JSON.stringify(await adapter.closeSettlement(result.rfqId))}`);
  console.log("\nAFTER");show(underlying,await snapshot(underlying));
}

if(command==="movestop"){
  const [underlyingArg,directionArg,triggerArg]=args;
  if(!underlyingArg||!directionArg||!triggerArg){console.error("Usage: test-scaleout movestop <underlying> <LONG|SHORT> <triggerPrice>");process.exit(1);}
  const underlying=underlyingArg.toUpperCase();
  const direction=directionArg.toUpperCase()==="LONG"?"LONG":"SHORT";
  console.log("BEFORE");show(underlying,await snapshot(underlying));
  const cancelled=await adapter.cancelProtection(underlying,"stop_loss");
  console.log(`\n=== cancelProtection(stop_loss) -> cancelled ${cancelled.cancelled} ===`);
  console.log("AFTER CANCEL (does the take-profit survive?)");show(underlying,await snapshot(underlying));
  try{
    const armed=await adapter.placeProtection({symbol:underlying,kind:"stop_loss",direction,triggerPrice:Number(triggerArg)});
    console.log(`\n=== placeProtection -> ${JSON.stringify({id:armed.id,triggerPrice:armed.triggerPrice})} ===`);
  }catch(error){
    console.log(`\n=== placeProtection FAILED: ${error instanceof Error?error.message:String(error)} ===`);
  }
  console.log("AFTER ARM");show(underlying,await snapshot(underlying));
}

await transport.close?.();
