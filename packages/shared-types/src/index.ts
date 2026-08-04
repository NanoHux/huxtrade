export const orderStates = [
  "CREATED_LOCAL", "SUBMITTING", "PENDING_ENTRY", "FILLED_OPEN", "CLOSED_TP",
  "CLOSED_SL", "LIQUIDATED", "SUBMISSION_FAILED", "CANCELLED_EXTERNALLY",
  "UNKNOWN", "RECONCILIATION_REQUIRED"
] as const;
export type OrderState = (typeof orderStates)[number];
export type Direction = "LONG" | "SHORT";
export type BtcRegime = "BULL" | "BEAR" | "RANGE" | "TRANSITION";
export type HealthState = "healthy" | "degraded" | "down";
export type ConditionType = "OI" | "CVD" | "FUNDING" | "HEATMAP";

export interface Asset {
  id: string;
  code: string;
  binanceSymbol: string;
  coinglassSymbol: string;
  variationalUrl: string;
  collectEnabled: boolean;
  signalEnabled: boolean;
  tradeEnabled: boolean;
  paused: boolean;
  pauseReason?: string | null;
  lastUpdatedAt?: string | null;
  connectionStatus?: "CONNECTED"|"STALE"|"ERROR"|"PENDING";
  market?: {
    price:number | null;
    oiChange1h:number | null;
    oiZ:number | null;
    oiPassed:boolean;
    cvd:number | null;
    cvdZ:number | null;
    cvdPassed:boolean;
    funding:number | null;
    fundingZ:number | null;
    fundingPassed:boolean;
    heatmapPassed:boolean;
    warmupReady:boolean;
    closedAt:string | null;
  };
}

export interface Strategy {
  id: string;
  name: string;
  enabled: boolean;
  logic: "AND" | "N_OF_M";
  requiredCount?: number | null;
  conditions: ConditionType[];
  heatmapRange: "12h" | "24h" | "3d" | "7d" | "30d";
  maxOrdersPerSide: number;
}

export interface ConditionResult {
  type: ConditionType;
  passed: boolean;
  value?: number | null;
  zScore?: number | null;
  direction?: Direction | null;
  reason: string;
}

export interface HeatmapRegion {
  price: number;
  lowPrice: number;
  highPrice: number;
  intensity: number;
  percentile: number;
  rank: number;
}

export interface SignalEvaluation {
  symbol: string;
  closedAt: string;
  btcRegime: BtcRegime;
  direction: Direction;
  executable: boolean;
  accepted: boolean;
  conditions: ConditionResult[];
  rejectionReasons: string[];
}

export interface OrderPlan {
  idempotencyKey: string;
  symbol: string;
  direction: Direction;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  expectedRiskReward: number;
  marginUsdc: number;
  leverage: number;
  notionalUsdc: number;
  heatmapTarget?: HeatmapRegion;
}

export interface ServiceHealth {
  service: string;
  state: HealthState;
  lastSuccessAt?: string | null;
  consecutiveFailures: number;
  error?: string | null;
  blocksTrading: boolean;
}

export interface DashboardSnapshot {
  generatedAt: string;
  liveTradingEnabled: boolean;
  globalPaused: boolean;
  btcRegime: BtcRegime;
  marginUsagePercent: number;
  balanceUsdc: number;
  variationalLoggedIn: boolean;
  assets: Asset[];
  services: ServiceHealth[];
  orders: Array<Record<string, unknown>>;
  stats: { signals: number; orders: number; fills: number; fillRate: number; winRate: number; realizedPnl: number };
}

export const isTerminalOrderState = (state: OrderState) =>
  ["CLOSED_TP", "CLOSED_SL", "LIQUIDATED", "SUBMISSION_FAILED", "CANCELLED_EXTERNALLY"].includes(state);
