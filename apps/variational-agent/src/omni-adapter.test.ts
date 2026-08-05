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

  it("takes the price scale from the tradeable bid/ask, not from mark or index prices",()=>{
    expect(priceDecimalsFromQuote({bid:"64254.76",ask:"64259.43",mark_price:"64257.0956748461",index_price:"64286.4239584057"})).toBe(2);
    expect(priceDecimalsFromQuote({bid:"64254",ask:"64259.4"})).toBe(1);
    expect(()=>priceDecimalsFromQuote({mark_price:"1.23"})).toThrow(/tradeable price scale/);
  });

  it("quantizes prices conservatively and re-checks the 1.5R floor afterwards",()=>{
    const long={...plan,direction:"LONG" as const,entryPrice:100.005,stopLoss:90.004,takeProfit:115.009};
    // Long: entry and stop round down, so the stop stays outside the structure
    // and the target never overstates itself.
    expect(quantizePlanPrices(long,2)).toMatchObject({entryPrice:"100.00",stopLoss:"90.00",takeProfit:"115.00",expectedRiskReward:1.5});
    const short={...plan,direction:"SHORT" as const,entryPrice:100.001,stopLoss:110.001,takeProfit:85.001};
    expect(quantizePlanPrices(short,2)).toMatchObject({entryPrice:"100.01",stopLoss:"110.01",takeProfit:"85.01"});
    // Rounding that drags the ratio under 1.5 must fail closed, not submit.
    expect(()=>quantizePlanPrices({...plan,direction:"LONG" as const,entryPrice:100,stopLoss:90,takeProfit:114.9},0)).toThrow(/below 1.5/);
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
    const tracked=await new OmniBrowserAdapter(transport,config).listTracked(["entry-1"]);
    expect(tracked[0]).toMatchObject({id:"entry-1",state:"FILLED_OPEN",takeProfitPresent:true,stopLossPresent:true,position:{entryPrice:64253.64,takeProfit:63500,stopLoss:64800}});
  });
});
