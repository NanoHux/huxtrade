import { describe,expect,it } from "vitest";
import type { OrderPlan } from "@huxtrade/shared-types";
import { OmniBrowserAdapter,priceDecimalsFromQuote,quantizePlanPrices,type OmniTransport } from "./omni-adapter.js";

// risk 800, reward 1200 => exactly the 1.5 floor from spec 8.3.
const plan:OrderPlan={idempotencyKey:"btc-short-1",symbol:"BTCUSDT",direction:"SHORT",entryPrice:64_000,stopLoss:64_800,takeProfit:62_800,expectedRiskReward:1.5,marginUsdc:10,leverage:5,notionalUsdc:50};
const config={VARIATIONAL_ENTRY_SLIPPAGE:0.005,VARIATIONAL_PROTECTION_SLIPPAGE:0.03,VARIATIONAL_CLOSE_SLIPPAGE:0.01};
const page=(result:unknown[])=>({pagination:{last_page:{limit:"100",offset:"0"},next_page:null,object_count:result.length},result});
const instrument={instrument_type:"perpetual_future",underlying:"BTC",funding_interval_s:3600,settlement_asset:"USDC"};

class FakeTransport implements OmniTransport{
  calls:Array<{path:string;init:{method?:"GET"|"POST";body?:unknown}}> = [];
  constructor(private readonly handler:(path:string,init:{method?:"GET"|"POST";body?:unknown})=>unknown|Promise<unknown>){}
  async request(path:string,init:{method?:"GET"|"POST";body?:unknown}={}){this.calls.push({path,init});return this.handler(path,init);}
}

const quote={quote_id:"quote-1",bid:"64000",ask:"64001",qty_limits:{bid:{min_qty_tick:"0.000001",min_qty:"0.000002",max_qty:"10"},ask:{min_qty_tick:"0.000001",min_qty:"0.000002",max_qty:"10"}}};

describe("Variational Omni browser-context adapter",()=>{
  it("counts only this instrument's active TP/SL when waiting for the protection slot",async()=>{
    // Variational arms an entry's pair at acceptance and reaps a cancelled
    // entry's pair asynchronously, so a submission that follows a cancel too
    // closely is rejected; the agent polls this to wait the window out.
    const protections=[
      {order_type:"take_profit",status:"pending",instrument},
      {order_type:"stop_loss",status:"pending",instrument},
      {order_type:"take_profit",status:"pending",instrument:{...instrument,underlying:"ETH"}},
      {order_type:"limit",status:"pending",instrument}
    ];
    const adapter=new OmniBrowserAdapter(new FakeTransport(()=>page(protections)),config);
    await expect(adapter.activeProtectionCount("BTCUSDT")).resolves.toBe(2);
    await expect(adapter.activeProtectionCount("ETHUSDT")).resolves.toBe(1);
    await expect(new OmniBrowserAdapter(new FakeTransport(()=>page([])),config).activeProtectionCount("BTCUSDT")).resolves.toBe(0);
  });

  it("attributes a self-initiated close by its own rfq, not by instrument",async()=>{
    // The trap: another position is open on the same instrument, so any
    // instrument-level match would hand back the WRONG order's state. Only the
    // rfq we submitted identifies this close.
    const transport=new FakeTransport((path)=>{
      if(path.startsWith("/api/trades"))return page([
        {id:"t-1",source_rfq:"other-rfq",side:"sell",price:"65000",qty:"0.01",created_at:"2026-08-07T11:00:00Z",instrument},
        {id:"t-2",source_rfq:"close-rfq",side:"buy",price:"64900",qty:"0.0077",mark_price:"64910",created_at:"2026-08-07T11:33:00Z",instrument}
      ]);
      if(path.startsWith("/api/transfers"))return page([
        {rfq_id:"other-rfq",transfer_type:"realized_pnl",qty:"-9.99"},
        {rfq_id:"close-rfq",transfer_type:"realized_pnl",qty:"1.15"}
      ]);
      throw new Error(`unexpected ${path}`);
    });
    const adapter=new OmniBrowserAdapter(transport,config);
    const settled=await adapter.closeSettlement("close-rfq");
    expect(settled.realizedPnl).toBeCloseTo(1.15,9);
    expect(settled.fill).toMatchObject({id:"t-2",side:"buy",price:64900,quantity:0.0077,realizedPnl:1.15});
  });

  it("returns nothing rather than guessing when the close has not settled yet",async()=>{
    const adapter=new OmniBrowserAdapter(new FakeTransport(()=>page([])),config);
    await expect(adapter.closeSettlement("close-rfq")).resolves.toEqual({realizedPnl:undefined,fill:undefined});
  });

  it("reads live protection from the pending list, not the truncated history page",async()=>{
    // The regression: order history returns only the 100 most recent orders,
    // so a position open longer than that many orders had its still-active
    // TP/SL scroll out of view and was reported unprotected — pausing a
    // healthy asset and demanding manual intervention.
    const protections=[
      {rfq_id:"tp-1",order_type:"take_profit",status:"pending",trigger_price:"484.129",instrument},
      {rfq_id:"sl-1",order_type:"stop_loss",status:"pending",trigger_price:"515.632",instrument}
    ];
    const transport=new FakeTransport((path)=>{
      if(path.includes("status=pending"))return page(protections);
      if(path.startsWith("/api/orders/v2"))return page([]);            // history has scrolled past them
      if(path.startsWith("/api/positions"))return [{position_info:{instrument,qty:"-0.9762",avg_entry_price:"512.271",opened_at:"2026-08-07T11:11:55Z"},price_info:{price:"509"},upnl:"3.3"}];
      if(path.startsWith("/api/trades"))return page([{id:"t-1",source_rfq:"entry-1",side:"sell",price:"512.271",qty:"0.9762",created_at:"2026-08-07T11:11:55Z",instrument}]);
      if(path.startsWith("/api/transfers"))return page([]);
      throw new Error(`unexpected ${path}`);
    });
    const tracked=await new OmniBrowserAdapter(transport,config).listTracked([{id:"entry-1"}]);
    expect(tracked[0]).toMatchObject({state:"FILLED_OPEN",takeProfitPresent:true,stopLossPresent:true});
    expect(tracked[0]!.position).toMatchObject({takeProfit:484.129,stopLoss:515.632});
  });

  it("classifies a long-resting cancelled entry that history can no longer show",async()=>{
    // The regression: order history is the 100 most recently CREATED orders,
    // so a 6-hour-old entry is off the end of it. Not being findable there
    // stranded the order in UNKNOWN — and the UNKNOWN release counter only
    // frees orders that never got an rfq id, so it would poll forever.
    const transport=new FakeTransport((path)=>{
      if(path.includes("status=pending"))return page([]);
      if(path.startsWith("/api/orders/v2"))return page([{rfq_id:"someone-else",status:"pending",instrument}]);
      if(path.startsWith("/api/positions"))return [];
      if(path.startsWith("/api/trades"))return page([{id:"t-9",source_rfq:"another-order",side:"buy",price:"1",qty:"1",created_at:"2026-08-07T19:00:00Z",instrument}]);
      if(path.startsWith("/api/transfers"))return page([]);
      throw new Error(`unexpected ${path}`);
    });
    const adapter=new OmniBrowserAdapter(transport,config);
    await expect(adapter.orderState("aged-entry")).resolves.toBe("CANCELLED_EXTERNALLY");
    expect((await adapter.listTracked([{id:"aged-entry"}]))[0]).toMatchObject({state:"CANCELLED_EXTERNALLY"});
  });

  it("still refuses to guess when history says the order is live",async()=>{
    // Present in history with a non-terminal status is genuinely ambiguous —
    // absence is what licenses the inference, not a contradicting record.
    const transport=new FakeTransport((path)=>{
      if(path.includes("status=pending"))return page([]);
      if(path.startsWith("/api/orders/v2"))return page([{rfq_id:"aged-entry",status:"open",instrument}]);
      if(path.startsWith("/api/positions"))return [];
      if(path.startsWith("/api/trades"))return page([]);
      if(path.startsWith("/api/transfers"))return page([]);
      throw new Error(`unexpected ${path}`);
    });
    expect((await new OmniBrowserAdapter(transport,config).listTracked([{id:"aged-entry"}]))[0]).toMatchObject({state:"UNKNOWN"});
  });

  it("settles a hand-closed position instead of stranding it in UNKNOWN",async()=>{
    // An operator flattening on the platform produces an exit we can see but
    // cannot attribute to a TP or SL. UNKNOWN is only auto-released for orders
    // that never got an rfq id, so this one would have been polled for ever.
    const transport=new FakeTransport((path)=>{
      if(path.includes("status=pending"))return page([]);
      if(path.startsWith("/api/orders/v2"))return page([{rfq_id:"manual-close",order_type:"market",status:"filled",instrument}]);
      if(path.startsWith("/api/positions"))return [];
      if(path.startsWith("/api/trades"))return page([
        {id:"t-exit",source_rfq:"manual-close",side:"buy",price:"74.8015",qty:"6.748",created_at:"2026-08-08T08:32:57Z",instrument},
        {id:"t-entry",source_rfq:"entry-1",side:"sell",price:"74.0932",qty:"6.748",created_at:"2026-08-07T13:39:11Z",instrument}
      ]);
      if(path.startsWith("/api/transfers"))return page([{rfq_id:"manual-close",transfer_type:"realized_pnl",qty:"-4.78"}]);
      throw new Error(`unexpected ${path}`);
    });
    const tracked=await new OmniBrowserAdapter(transport,config).listTracked([{id:"entry-1"}]);
    expect(tracked[0]).toMatchObject({state:"CLOSED_REVERSED"});
    expect(tracked[0]!.fills?.at(-1)).toMatchObject({side:"buy",realizedPnl:-4.78});
  });

  it("still refuses to settle when no exit is visible at all",async()=>{
    const transport=new FakeTransport((path)=>{
      if(path.includes("status=pending"))return page([]);
      if(path.startsWith("/api/orders/v2"))return page([{rfq_id:"entry-1",status:"filled",instrument}]);
      if(path.startsWith("/api/positions"))return [];
      if(path.startsWith("/api/trades"))return page([{id:"t-entry",source_rfq:"entry-1",side:"sell",price:"74.09",qty:"6.748",created_at:"2026-08-07T13:39:11Z",instrument}]);
      if(path.startsWith("/api/transfers"))return page([]);
      throw new Error(`unexpected ${path}`);
    });
    expect((await new OmniBrowserAdapter(transport,config).listTracked([{id:"entry-1"}]))[0]).toMatchObject({state:"UNKNOWN"});
  });

  it("derives account margin usage from authoritative portfolio amounts",async()=>{
    const adapter=new OmniBrowserAdapter(new FakeTransport(()=>({balance:"200",upnl:"-10",margin_usage:{initial_margin:"19",maintenance_margin:"9.5"}})),config);
    await expect(adapter.account()).resolves.toEqual({balanceUsdc:200,marginUsagePercent:10});
  });

  it("verifies leverage, quantizes quantity and submits an atomic limit entry with TP/SL",async()=>{
    const transport=new FakeTransport((path)=>{
      if(path.includes("/settlement_pools/leverage"))return {BTC:{current:"5",limits:[]}};
      if(path.includes("/quotes/indicative"))return quote;
      if(path.includes("/orders/new/limit"))return {rfq_id:"entry-1",take_profit_rfq_id:"tp-1",stop_loss_rfq_id:"sl-1"};
      throw new Error(`unexpected ${path}`);
    });
    const adapter=new OmniBrowserAdapter(transport,config);
    expect(await adapter.minimumMargin(plan)).toBeCloseTo(0.0256);
    const entry=await adapter.submitEntry(plan as unknown as Record<string,unknown>);
    await expect(adapter.placeTakeProfit(entry,plan)).resolves.toMatchObject({id:"tp-1"});
    await expect(adapter.placeStopLoss(entry,plan)).resolves.toMatchObject({id:"sl-1"});
    const submission=transport.calls.find((call)=>call.path==="/api/orders/new/limit")?.init.body;
    expect(submission).toMatchObject({
      order_type:"limit",limit_price:"64000",side:"sell",instrument,qty:"0.000781",slippage_limit:"0.005",
      take_profit:"62800",tp_is_auto_resize:true,tp_use_mark_price:true,tp_slippage_limit:"0.03",
      stop_loss:"64800",sl_is_auto_resize:true,sl_use_mark_price:true,sl_slippage_limit:"0.03",is_reduce_only:false
    });
    expect(entry.submittedPrices).toMatchObject({entryPrice:"64000",takeProfit:"62800",stopLoss:"64800",decimals:0});
  });

  it("omits take_profit/stop_loss from the request body entirely when skipping protection — not just skipping the read-back",async()=>{
    // Regression test for the real XPL failures: passing skipProtection but
    // still sending tp_*/sl_* fields made Variational reject every stacked
    // same-direction order with HTTP 400 (a second TP/SL on one instrument).
    const transport=new FakeTransport((path)=>{
      if(path.includes("/settlement_pools/leverage"))return {BTC:{current:"5",limits:[]}};
      if(path.includes("/quotes/indicative"))return quote;
      if(path.includes("/orders/new/limit"))return {rfq_id:"entry-2"};
      throw new Error(`unexpected ${path}`);
    });
    const adapter=new OmniBrowserAdapter(transport,config);
    await adapter.submitEntry(plan as unknown as Record<string,unknown>,{skipProtection:true});
    const submission=transport.calls.find((call)=>call.path==="/api/orders/new/limit")?.init.body as Record<string,unknown>;
    expect(submission).toMatchObject({order_type:"limit",side:"sell",instrument,is_reduce_only:false});
    for(const key of ["take_profit","tp_is_auto_resize","tp_use_mark_price","tp_slippage_limit","stop_loss","sl_is_auto_resize","sl_use_mark_price","sl_slippage_limit"]){
      expect(submission).not.toHaveProperty(key);
    }
  });

  it("auto-corrects a leverage mismatch by setting it, then re-verifying against the read path",async()=>{
    let leverage="10";
    const transport=new FakeTransport((path,init)=>{
      if(path==="/api/settlement_pools/set_leverage"){leverage=String((init.body as {leverage:number}).leverage);return {ok:true};}
      if(path.includes("/settlement_pools/leverage"))return {BTC:{current:leverage,limits:[]}};
      if(path.includes("/quotes/indicative"))return quote;
      if(path.includes("/orders/new/limit"))return {rfq_id:"entry-1",take_profit_rfq_id:"tp-1",stop_loss_rfq_id:"sl-1"};
      throw new Error(`unexpected ${path}`);
    });
    const adapter=new OmniBrowserAdapter(transport,config);
    await adapter.submitEntry(plan as unknown as Record<string,unknown>);
    expect(transport.calls.find((call)=>call.path==="/api/settlement_pools/set_leverage")?.init.body).toEqual({asset:"BTC",leverage:5});
  });

  it("still fails closed when the platform doesn't actually apply the requested leverage",async()=>{
    const transport=new FakeTransport((path)=>{
      if(path==="/api/settlement_pools/set_leverage")return {ok:true};
      if(path.includes("/settlement_pools/leverage"))return {BTC:{current:"10",limits:[]}};
      throw new Error(`unexpected ${path}`);
    });
    const adapter=new OmniBrowserAdapter(transport,config);
    await expect(adapter.submitEntry(plan as unknown as Record<string,unknown>)).rejects.toThrow(/10x after attempting to set 5x/);
  });

  it("forgetPreparation drops the cached quote so a retried submitEntry fetches fresh market data",async()=>{
    let indicativeCalls=0;
    const transport=new FakeTransport((path)=>{
      if(path.includes("/settlement_pools/leverage"))return {BTC:{current:"5",limits:[]}};
      if(path.includes("/quotes/indicative")){indicativeCalls+=1;return quote;}
      if(path.includes("/orders/new/limit"))return {rfq_id:"entry-1",take_profit_rfq_id:"tp-1",stop_loss_rfq_id:"sl-1"};
      throw new Error(`unexpected ${path}`);
    });
    const adapter=new OmniBrowserAdapter(transport,config);
    await adapter.submitEntry(plan as unknown as Record<string,unknown>);
    const afterFirst=indicativeCalls;
    await adapter.submitEntry(plan as unknown as Record<string,unknown>);
    expect(indicativeCalls).toBe(afterFirst); // second call reuses the cached preparation — no new quote fetch
    adapter.forgetPreparation(plan.idempotencyKey);
    await adapter.submitEntry(plan as unknown as Record<string,unknown>);
    expect(indicativeCalls).toBeGreaterThan(afterFirst); // forgetting forces a fresh quote on the next attempt
  });

  it("takes the price scale from the tradeable bid/ask, not from mark or index prices",()=>{
    expect(priceDecimalsFromQuote({bid:"64254.76",ask:"64259.43",mark_price:"64257.0956748461",index_price:"64286.4239584057"})).toBe(2);
    expect(priceDecimalsFromQuote({bid:"64254",ask:"64259.4"})).toBe(1);
    expect(()=>priceDecimalsFromQuote({mark_price:"1.23"})).toThrow(/tradeable price scale/);
  });

  it("rejects a plan whose ratio rounding drags under the floor, with no headroom left to absorb it",()=>{
    // A tight stop (~2% of entry) quantized to 4 decimals loses enough of its
    // margin that a plan built at exactly the floor lands under it. The
    // margin-fraction fallback used to aim past the floor precisely to absorb
    // this; without it, boundary plans legitimately die here rather than
    // reaching the platform under-specified.
    const entryPrice=0.3107,risk=entryPrice*0.02,stopLoss=entryPrice-risk;
    const exactFloor={...plan,direction:"LONG" as const,entryPrice,stopLoss,takeProfit:entryPrice+risk*1.4};
    expect(()=>quantizePlanPrices(exactFloor,4)).toThrow(/below 1.4/);
    const withRoom={...plan,direction:"LONG" as const,entryPrice,stopLoss,takeProfit:entryPrice+risk*1.5};
    expect(quantizePlanPrices(withRoom,4).expectedRiskReward).toBeGreaterThanOrEqual(1.4);
  });

  it("quantizes prices conservatively and re-checks the ratio floor afterwards",()=>{
    const long={...plan,direction:"LONG" as const,entryPrice:100.005,stopLoss:90.004,takeProfit:115.009};
    // Long: entry and stop round down, so the stop stays outside the structure
    // and the target never overstates itself.
    expect(quantizePlanPrices(long,2)).toMatchObject({entryPrice:"100.00",stopLoss:"90.00",takeProfit:"115.00",expectedRiskReward:1.5});
    const short={...plan,direction:"SHORT" as const,entryPrice:100.001,stopLoss:110.001,takeProfit:85.001};
    expect(quantizePlanPrices(short,2)).toMatchObject({entryPrice:"100.01",stopLoss:"110.01",takeProfit:"85.01"});
    // Rounding that drags the ratio under the floor must fail closed, not submit.
    expect(()=>quantizePlanPrices({...plan,direction:"LONG" as const,entryPrice:100,stopLoss:90,takeProfit:113.9},0)).toThrow(/below 1.4/);
  });

  it("refuses to treat an entry as protected when the platform omits either protection id",async()=>{
    const transport=new FakeTransport((path)=>path.includes("leverage")?{BTC:{current:"5"}}:path.includes("indicative")?quote:{rfq_id:"entry-1",take_profit_rfq_id:"tp-1"});
    const adapter=new OmniBrowserAdapter(transport,config),entry=await adapter.submitEntry(plan as unknown as Record<string,unknown>);
    await expect(adapter.placeStopLoss(entry,plan)).rejects.toThrow("stop-loss RFQ ID");
  });

  it("cancels entry limits during global pause but leaves reduce-only protection orders alone",async()=>{
    const pending=[
      {rfq_id:"entry-1",order_type:"limit",is_reduce_only:false},
      {rfq_id:"tp-1",order_type:"take_profit",is_reduce_only:true}
    ];
    const transport=new FakeTransport((path)=>path.includes("orders/v2")?page(pending):null);
    const adapter=new OmniBrowserAdapter(transport,config);
    await expect(adapter.cancelPending()).resolves.toEqual([{id:"entry-1",cancelled:true}]);
    expect(transport.calls.filter((call)=>call.path==="/api/orders/cancel").map((call)=>call.init.body)).toEqual([{rfq_id:"entry-1"}]);
  });

  it("reconciles a filled position and both pending protections from captured response shapes",async()=>{
    const entryTrade={id:"fill-1",source_rfq:"entry-1",instrument,qty:"0.00077",price:"64253.64",side:"sell",created_at:"2026-08-05T01:57:05.345Z",trade_type:"trade"};
    const protections=[
      {rfq_id:"tp-1",instrument,order_type:"take_profit",status:"pending",created_at:"2026-08-05T01:57:05.237Z",trigger_price:"63500"},
      {rfq_id:"sl-1",instrument,order_type:"stop_loss",status:"pending",created_at:"2026-08-05T01:57:05.237Z",trigger_price:"64800"}
    ];
    const position={position_info:{company:"company",pool_location:"pool",instrument,qty:"-0.00077",avg_entry_price:"64253.64",opened_at:"2026-08-05T01:57:05.345Z"},price_info:{price:"64243.49"},upnl:"0.007",rpnl:"0"};
    const transport=new FakeTransport((path)=>{
      if(path.includes("status=pending"))return page(protections);
      if(path.includes("/orders/v2"))return page(protections);
      if(path==="/api/positions")return [position];
      if(path.includes("/trades"))return page([entryTrade]);
      if(path.includes("/transfers"))return page([]);
      throw new Error(`unexpected ${path}`);
    });
    const tracked=await new OmniBrowserAdapter(transport,config).listTracked([{id:"entry-1"}]);
    expect(tracked[0]).toMatchObject({id:"entry-1",state:"FILLED_OPEN",takeProfitPresent:true,stopLossPresent:true,position:{entryPrice:64253.64,takeProfit:63500,stopLoss:64800}});
  });

  it("reports a same-direction stacked order as protected by the instrument's existing TP/SL, even though they weren't created near its own entry",async()=>{
    // Variational allows only one auto-resizing TP/SL per instrument. A
    // second same-direction order (see the asset-conflict resolution in
    // variational-agent) intentionally never gets its own — it relies on the
    // first order's protection, created minutes earlier, to keep covering
    // the now-larger position. Anchoring "protected" to a 5s window around
    // *this* order's own entry would wrongly report it as unprotected.
    const firstEntry={id:"fill-1",source_rfq:"entry-1",instrument,qty:"0.0005",price:"64000",side:"sell",created_at:"2026-08-05T01:00:00.000Z",trade_type:"trade"};
    const secondEntry={id:"fill-2",source_rfq:"entry-2",instrument,qty:"0.00027",price:"64100",side:"sell",created_at:"2026-08-05T01:10:00.000Z",trade_type:"trade"};
    const protections=[
      {rfq_id:"tp-1",instrument,order_type:"take_profit",status:"pending",created_at:"2026-08-05T01:00:00.100Z",trigger_price:"63500"},
      {rfq_id:"sl-1",instrument,order_type:"stop_loss",status:"pending",created_at:"2026-08-05T01:00:00.100Z",trigger_price:"64800"}
    ];
    const position={position_info:{company:"company",pool_location:"pool",instrument,qty:"-0.00077",avg_entry_price:"64036.36",opened_at:"2026-08-05T01:00:00.000Z"},price_info:{price:"64050"},upnl:"0.007",rpnl:"0"};
    const transport=new FakeTransport((path)=>{
      if(path.includes("status=pending"))return page(protections);
      if(path.includes("/orders/v2"))return page(protections);
      if(path==="/api/positions")return [position];
      if(path.includes("/trades"))return page([firstEntry,secondEntry]);
      if(path.includes("/transfers"))return page([]);
      throw new Error(`unexpected ${path}`);
    });
    const tracked=await new OmniBrowserAdapter(transport,config).listTracked([{id:"entry-2"}]);
    expect(tracked[0]).toMatchObject({id:"entry-2",state:"FILLED_OPEN",takeProfitPresent:true,stopLossPresent:true});
  });

  it("apportions the aggregate position across stacked orders so their rows sum back to the platform totals",async()=>{
    // Regression test for the multiply-counted dashboard: Variational nets
    // both entries into ONE aggregate position (qty -0.00077, upnl 0.007).
    // Persisting that aggregate onto each order doubled exposure and PnL;
    // apportionment gives each order its own quantity, its own fill price,
    // and a proportional PnL share that still sums to the aggregate.
    const firstEntry={id:"fill-1",source_rfq:"entry-1",instrument,qty:"0.0005",price:"64000",side:"sell",created_at:"2026-08-05T01:00:00.000Z",trade_type:"trade"};
    const secondEntry={id:"fill-2",source_rfq:"entry-2",instrument,qty:"0.00027",price:"64100",side:"sell",created_at:"2026-08-05T01:10:00.000Z",trade_type:"trade"};
    const protections=[
      {rfq_id:"tp-1",instrument,order_type:"take_profit",status:"pending",created_at:"2026-08-05T01:00:00.100Z",trigger_price:"63500"},
      {rfq_id:"sl-1",instrument,order_type:"stop_loss",status:"pending",created_at:"2026-08-05T01:00:00.100Z",trigger_price:"64800"}
    ];
    const position={position_info:{company:"company",pool_location:"pool",instrument,qty:"-0.00077",avg_entry_price:"64035.06",opened_at:"2026-08-05T01:00:00.000Z"},price_info:{price:"64050"},upnl:"0.007",rpnl:"-0.014"};
    const transport=new FakeTransport((path)=>{
      if(path.includes("status=pending"))return page(protections);
      if(path.includes("/orders/v2"))return page(protections);
      if(path==="/api/positions")return [position];
      if(path.includes("/trades"))return page([firstEntry,secondEntry]);
      if(path.includes("/transfers"))return page([]);
      throw new Error(`unexpected ${path}`);
    });
    const tracked=await new OmniBrowserAdapter(transport,config).listTracked([{id:"entry-1"},{id:"entry-2"}]);
    const [first,second]=[tracked[0]!.position!,tracked[1]!.position!];
    expect(first.quantity).toBeCloseTo(0.0005,9);
    expect(first.entryPrice).toBe(64000);
    expect(second.quantity).toBeCloseTo(0.00027,9);
    expect(second.entryPrice).toBe(64100);
    expect(first.unrealizedPnl!+second.unrealizedPnl!).toBeCloseTo(0.007,9);
    expect(first.realizedPnl!+second.realizedPnl!).toBeCloseTo(-0.014,9);
  });

  it("classifies a stacked order closed by the instrument's shared stop-loss as CLOSED_SL via the exit trade's source rfq",async()=>{
    // The shared SL was created alongside the FIRST order, an hour before
    // this stacked one — far outside any per-order time window. When it
    // fires it closes the whole aggregate; every covered order must resolve
    // to CLOSED_SL (with its share of the exit) instead of stranding in
    // UNKNOWN and occupying the per-side cap forever.
    const stackedEntry={id:"fill-2",source_rfq:"entry-2",instrument,qty:"0.00027",price:"64100",side:"sell",created_at:"2026-08-05T02:00:00.000Z",trade_type:"trade"};
    const exitTrade={id:"fill-3",source_rfq:"sl-1",instrument,qty:"0.00077",price:"64800",side:"buy",created_at:"2026-08-05T03:00:00.000Z",trade_type:"trade"};
    const history=[
      {rfq_id:"sl-1",instrument,order_type:"stop_loss",status:"cleared",created_at:"2026-08-05T01:00:00.100Z",trigger_price:"64800"},
      {rfq_id:"entry-2",instrument,order_type:"limit",status:"completed",created_at:"2026-08-05T02:00:00.000Z"}
    ];
    const transport=new FakeTransport((path)=>{
      if(path.includes("status=pending"))return page([]);
      if(path.includes("/orders/v2"))return page(history);
      if(path==="/api/positions")return [];
      if(path.includes("/trades"))return page([stackedEntry,exitTrade]);
      if(path.includes("/transfers"))return page([{rfq_id:"sl-1",transfer_type:"realized_pnl",qty:"-0.6"}]);
      throw new Error(`unexpected ${path}`);
    });
    const tracked=await new OmniBrowserAdapter(transport,config).listTracked([{id:"entry-2"}]);
    expect(tracked[0]).toMatchObject({id:"entry-2",state:"CLOSED_SL"});
    expect(tracked[0]!.fills).toHaveLength(2);
    expect(tracked[0]!.fills![1]!.realizedPnl).toBeCloseTo(-0.6,9);
  });

  it("records the spread paid against the mark price as the fill's effective fee",async()=>{
    // Variational's RFQ model has no explicit taker fee; the execution cost
    // is the spread vs mark at fill time. Buy at 502.57 with mark 502.427:
    // fee = (502.57 - 502.427) * 0.0994. A trade without mark_price stays
    // fee-less rather than guessing.
    const entryTrade={id:"fill-1",source_rfq:"entry-1",instrument,qty:"0.0994",price:"502.57",mark_price:"502.427",side:"buy",created_at:"2026-08-07T00:31:29.424Z",trade_type:"trade"};
    const position={position_info:{company:"company",pool_location:"pool",instrument,qty:"0.0994",avg_entry_price:"502.57",opened_at:"2026-08-07T00:31:29.424Z"},price_info:{price:"502.43"},upnl:"-0.014",rpnl:"0"};
    const transport=new FakeTransport((path)=>{
      if(path.includes("status=pending"))return page([]);
      if(path.includes("/orders/v2"))return page([]);
      if(path==="/api/positions")return [position];
      if(path.includes("/trades"))return page([entryTrade]);
      if(path.includes("/transfers"))return page([]);
      throw new Error(`unexpected ${path}`);
    });
    const tracked=await new OmniBrowserAdapter(transport,config).listTracked([{id:"entry-1"}]);
    expect(tracked[0]!.fills![0]!.fee).toBeCloseTo((502.57-502.427)*0.0994,9);
  });
});

describe("attributing an exit when the venue's rfq trail is gone",()=>{
  // ZRO as it happened. The stop filled at 0.846 against a 0.845253 trigger,
  // but the protection had been reissued by auto-resize, so the sourcing rfq
  // was not on the order-history page and the exit was booked as a manual
  // reversal — a real stop-out that never reached the loss column.
  const instrument={instrument_type:"perpetual_future",underlying:"ZRO",funding_interval_s:3600,settlement_asset:"USDC"};
  const entryTrade={id:"t-entry",source_rfq:"entry-zro",instrument,side:"sell",qty:"1789.3",price:"0.8383",created_at:"2026-08-08T03:55:30.000Z",mark_price:"0.8383"};
  const exitTrade={id:"t-exit",source_rfq:"reissued-sl-rfq",instrument,side:"buy",qty:"1789.3",price:"0.846",created_at:"2026-08-09T01:09:43.044Z",mark_price:"0.84531"};
  const levels={id:"entry-zro",direction:"SHORT" as const,entryPrice:0.8383,stopLoss:0.8453,takeProfit:0.8079};
  const transport=()=>new FakeTransport((path)=>{
    if(path.includes("status=pending"))return page([]);
    if(path.includes("/orders/v2"))return page([]);          // the rfq has scrolled off
    if(path==="/api/positions")return [];
    if(path.includes("/trades"))return page([exitTrade,entryTrade]);
    if(path.includes("/transfers"))return page([]);
    throw new Error(`unexpected ${path}`);
  });

  it("books it as a stop-out from the fill price alone",async()=>{
    const tracked=await new OmniBrowserAdapter(transport(),config).listTracked([levels]);
    expect(tracked[0]).toMatchObject({id:"entry-zro",state:"CLOSED_SL"});
  });

  it("still reports a manual close as unattributed when no level explains it",async()=>{
    // Same missing rfq, but the exit printed mid-trade, which is what an
    // operator flattening by hand actually looks like.
    const midTrade={...exitTrade,price:"0.8410"};
    const mid=new FakeTransport((path)=>{
      if(path.includes("status=pending"))return page([]);
      if(path.includes("/orders/v2"))return page([]);
      if(path==="/api/positions")return [];
      if(path.includes("/trades"))return page([midTrade,entryTrade]);
      if(path.includes("/transfers"))return page([]);
      throw new Error(`unexpected ${path}`);
    });
    const tracked=await new OmniBrowserAdapter(mid,config).listTracked([levels]);
    expect(tracked[0]).toMatchObject({state:"CLOSED_REVERSED"});
  });

  it("falls back to the rfq trail when no local levels were supplied",async()=>{
    const tracked=await new OmniBrowserAdapter(transport(),config).listTracked([{id:"entry-zro"}]);
    expect(tracked[0]).toMatchObject({state:"CLOSED_REVERSED"});
  });
});
