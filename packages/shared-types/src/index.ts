export const orderStates = [
  "CREATED_LOCAL", "SUBMITTING", "PENDING_ENTRY", "FILLED_OPEN", "CLOSED_TP",
  "CLOSED_SL", "LIQUIDATED", "CLOSED_REVERSED", "SUBMISSION_FAILED", "CANCELLED_EXTERNALLY",
  "CANCELLED_REPLACED", "UNKNOWN", "RECONCILIATION_REQUIRED"
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
  coinglassUrl: string;
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

/**
 * Per-strategy overrides for the resting limit entry model. Distances are in
 * 1h ATR so they mean the same thing on every asset. Anything omitted falls
 * back to fixedRules.restingEntry — see resolveRestingEntry in strategy-engine.
 */
export interface RestingEntrySettings {
  /** Entry band, nearest and farthest, in 1h ATR behind the reference price. */
  entryBandAtrMin: number;
  entryBandAtrMax: number;
  /** How far in front of the structure the order sits. */
  entryOffsetAtr: number;
  /** Candidates closer than this are one structure and their scores add. */
  confluenceMergeAtr: number;
  /** Hysteresis: the level must move more than this before the order is replaced. */
  replaceThresholdAtr: number;
  /** How many 15m scans an armed direction bias survives without a refresh. */
  biasPersistenceScans: number;
  /** How many counter-direction passes must accumulate before an armed bias actually flips. */
  flipConfirmationScans: number;
  /** Cap on simultaneously armed assets, ranked by signal strength. */
  maxArmedAssets: number;
  /** Fixed scores for the non-heatmap candidates; heatmap scores on its region percentile. */
  swingScore: number;
  emaScore: number;
  /** Score bonus for the structure a working order already sits on, so a marginal rival cannot displace it. */
  incumbentScoreBonus: number;
  /** Refuse signals that trade WITH a 24h move of at least this size — shorts into a pump, longs into a dump. 0 disables. */
  extremeMoveBlockPercent: number;
  /** Losing stop-outs in one direction that halt further arming of it. 0 disables the circuit breaker. */
  lossStreakCount: number;
  /** How far back the losing stop-outs are counted, in hours. */
  lossStreakWindowHours: number;
  /** How long that direction stays halted after the streak, in hours. */
  lossStreakHaltHours: number;
  /** Unrealised profit, in stop-widths, at which part of the position is taken off. 0 disables scaling out. */
  scaleOutTriggerR: number;
  /** Share of the position closed when the trigger is reached; the remainder runs to the unchanged target. */
  scaleOutFraction: number;
  /** Skip the scale-out when the stop is narrower than this share of price, where the spread would eat the gain. */
  scaleOutMinStopPercent: number;
  /** How far beyond entry, in stop-widths, the surviving half's breakeven stop sits. */
  breakevenOffsetR: number;
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
  /** Which entry model this strategy executes. The shadow ledger is written either way. */
  entryKind: EntryKind;
  restingEntry: RestingEntrySettings;
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

/**
 * `MARKET_ON_SIGNAL` is the original path: the signal fires and the entry is
 * submitted at the current price. `RESTING_LIMIT` decouples direction from
 * execution — the signal only arms a bias, and the entry waits at a
 * structural level chosen by chooseEntryLevel.
 */
export type EntryKind = "MARKET_ON_SIGNAL" | "RESTING_LIMIT";

export type EntryCandidateSource = "HEATMAP" | "SWING" | "EMA";

/** Why a resting entry sits where it does — persisted for the shadow-mode audit ledger. */
export interface RestingEntryProvenance {
  sources: EntryCandidateSource[];
  score: number;
  level: number;
  /** Scan reference price the entry band was measured from. */
  referencePrice: number;
  atr1h: number;
  bandNear: number;
  bandFar: number;
  region?: HeatmapRegion;
  swing?: number;
  ema?: number;
}

export interface OrderPlan {
  idempotencyKey: string;
  /** Binance symbol — the identity used for indicators, keys and display. */
  symbol: string;
  /** Variational's own ticker when it differs from the Binance base (LIT trades as LIGHTER). */
  venueSymbol?: string;
  direction: Direction;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  expectedRiskReward: number;
  marginUsdc: number;
  leverage: number;
  notionalUsdc: number;
  heatmapTarget?: HeatmapRegion;
  entryKind?: EntryKind;
  entryProvenance?: RestingEntryProvenance;
}

/** Active order states hold a symbol/side slot per spec 6.3. */
export const openOrderStates = [
  "CREATED_LOCAL", "SUBMITTING", "PENDING_ENTRY", "FILLED_OPEN", "UNKNOWN", "RECONCILIATION_REQUIRED"
] as const satisfies readonly OrderState[];

export interface DashboardOrder {
  id: string;
  code: string;
  direction: Direction;
  state: OrderState;
  entryPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  marginUsdc: number | null;
  realizedPnl: number | null;
  variationalUrl: string;
  updatedAt: string | null;
}

export interface DashboardPosition {
  id: string;
  code: string;
  direction: Direction;
  quantity: number | null;
  entryPrice: number | null;
  takeProfit: number | null;
  stopLoss: number | null;
  unrealizedPnl: number | null;
  realizedPnl: number | null;
  orderState: OrderState;
  variationalUrl: string;
  openedAt: string | null;
  updatedAt: string | null;
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
  btcContext?: {
    dailyDirection: "BULL" | "BEAR" | "MIXED";
    fourHourConfirmation: "BULL" | "BEAR" | "MIXED";
    adxState: "TREND" | "RANGE" | "TRANSITION";
    adx: number | null;
  };
  marginUsagePercent: number;
  balanceUsdc: number;
  variationalLoggedIn: boolean;
  variationalReconciled?: boolean;
  assets: Asset[];
  services: ServiceHealth[];
  orders: Array<Record<string, unknown>>;
  openOrders: DashboardOrder[];
  openPositions: DashboardPosition[];
  stats: { signals: number; orders: number; fills: number; fillRate: number; winRate: number; realizedPnl: number };
}

export const isTerminalOrderState = (state: OrderState) =>
  ["CLOSED_TP", "CLOSED_SL", "LIQUIDATED", "CLOSED_REVERSED", "SUBMISSION_FAILED", "CANCELLED_EXTERNALLY", "CANCELLED_REPLACED"].includes(state);
