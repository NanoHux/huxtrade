import { Header } from "../../components/Header";
import { RestingBoard } from "../../components/RestingBoard";
import { api } from "../../lib/api";
export const dynamic="force-dynamic";

export interface RestingOrderRow{
  id:string;code:string;direction:"LONG"|"SHORT";level:number;stopLoss:number;takeProfit:number;
  marginUsdc:number|null;marketPrice:number|null;distanceAtr:number|null;distancePercent:number|null;
  expectedRiskReward:number|null;sources:string[];score:number|null;ageMinutes:number;
  revalidatedAt:string|null;createdAt:string;lastDecisionReason:string|null;variationalUrl:string;
}
export interface EntryPlanRow{
  id:string;code:string;closed_at:string;direction:string|null;level:string|null;stop_loss:string|null;
  take_profit:string|null;expected_rr:string|null;decision:string;decision_reason:string;mode:string;
  provenance:{biasReason?:string;strength?:number}|null;
}
export interface RestingStats{
  ledger:Array<{mode:string;decision:string;count:number}>;
  placed:number;filled:number;fillRate:number;
  byExit:Array<{state:string;count:number;averageRealizedRiskReward:number|null;averageEntryDistanceAtr:number|null}>;
}

export default async function Page(){
  const [orders,plans,stats]=await Promise.all([
    api<RestingOrderRow[]>("/api/resting-orders",[]),
    api<{rows:EntryPlanRow[];total:number}>("/api/entry-plans?limit=100",{rows:[],total:0}),
    api<RestingStats>("/api/resting-statistics",{ledger:[],placed:0,filled:0,fillRate:0,byExit:[]})
  ]);
  return <><Header eyebrow="Resting Limit Entry" title="挂单看板"/>
    <RestingBoard orders={orders} plans={plans.rows} total={plans.total} stats={stats}/></>;
}
