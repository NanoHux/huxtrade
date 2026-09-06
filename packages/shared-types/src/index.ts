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
  /** The stop must be at least this many times the quoted bid/ask spread. 0 disables the check. */
  minStopSpreadMultiple: number;
  /** Consecutive structural submission rejections before an asset is rested. 0 disables the backoff. */
  structuralRejectionLimit: number;
  /** How long a rested asset stays out, in hours. */
  structuralBackoffHours: number;
  /** Target as this multiple of the stop distance. 0 aims at the strongest liquidation cluster instead. */
  takeProfitRiskReward: number;
  /** Hard ceiling on one trade's loss, as a percentage of its margin. Divided by leverage it becomes the widest the stop may sit from entry. 0 disables the cap. */
  maxStopLossPercent: number;
  /** 1 to hold entries locally until price arrives and two 5m closes confirm; 0 to post the limit order immediately. */
  virtualEntryConfirmation: number;
  /** Candle length the confirmation runs on, in minutes. */
  virtualEntryIntervalMinutes: number;
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
  /**
   * The position is closed by a clock, not by its target. Suppresses the
   * minimum risk/reward floor, which measures whether a target pays for its
   * stop — a question that has no meaning when the target is never the exit.
   */
  timeExit?: boolean;
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

/** One leg of the gainers basket as it stands on the venue right now. */
export interface GainersPosition {
  symbol: string;
  quantity: number;
  entryPrice: number;
  markPrice: number | null;
  unrealizedPnl: number | null;
  /** Planned exits, carried from the leg notification the agent emitted at open. */
  takeProfit: number | null;
  stopLoss: number | null;
  marginUsdc: number | null;
  openedAt: string | null;
}

/** A basket the agent has already closed, summed from its per-leg exits. */
export interface GainersBasketResult {
  closedAt: string;
  mode: string;
  legs: number;
  realizedPnl: number;
}

/**
 * One calendar day's realised P&L, keyed by the Asia/Shanghai date the basket
 * was *closed* on — a basket opened 23:55 settles the next morning, and the
 * money lands on that morning's date.
 */
export interface DailyPnl {
  /** YYYY-MM-DD, Asia/Shanghai. */
  date: string;
  /** Scheduled baskets, net of fees. null when the close predates per-leg P&L being recorded. */
  realizedPnl: number | null;
  /** What the price did, before costs. null for records written before the split was captured. */
  grossPnl: number | null;
  /** Perpetual funding over the hold; positive means the position was paid. */
  funding: number | null;
  /** What the round trip cost, as a positive number. null likewise. */
  commission: number | null;
  legs: number;
  baskets: number;
  /** Manual test baskets, kept apart so they never move the headline number. */
  testPnl: number | null;
  testLegs: number;
}

export interface DashboardSnapshot {
  generatedAt: string;
  liveTradingEnabled: boolean;
  marginUsagePercent: number;
  balanceUsdc: number;
  services: ServiceHealth[];
  /**
   * The daily gainers basket — the only strategy that trades. Positions come
   * from the agent's own venue snapshot rather than the orders table, which
   * the basket never writes to.
   */
  gainers: {
    enabled: boolean;
    marginUsdc: number | null;
    /** Present only while a basket is live, which separates "armed" from "holding". */
    closeAt: string | null;
    openLegs: number;
    positions: GainersPosition[];
    positionsAt: string | null;
    history: GainersBasketResult[];
    stats: { baskets: number; winners: number; realizedPnl: number };
  };
}

export const isTerminalOrderState = (state: OrderState) =>
  ["CLOSED_TP", "CLOSED_SL", "LIQUIDATED", "CLOSED_REVERSED", "SUBMISSION_FAILED", "CANCELLED_EXTERNALLY", "CANCELLED_REPLACED"].includes(state);

/**
 * The gainers basket's parameters, in one place because three of them are also
 * prose on the settings page. When they lived only in the agent, the page went
 * on advertising a 15% take-profit and a Monday skip for as long as nobody
 * re-read it; anything user-visible now derives from these.
 */
export const gainersStrategy = {
  leverage: 2,
  /** Legs per basket — the top N of the gainers ranking. */
  basket: 4,
  /** Price move that closes a leg in profit, before leverage. */
  takeProfitFraction: 0.30,
  /**
   * Price move that closes a leg in loss, before leverage. At 2x this is an 80%
   * margin loss, and it sits inside the ~49% liquidation move so the stop can
   * actually fire — the old 0.80 sat past liquidation and never triggered.
   */
  stopFraction: 0.40,
  /** 1.00 = long only; the short leg is retired. */
  longWeight: 1.00,
  /** Share of the balance posted as margin; the rest is headroom for later legs. */
  deployFraction: 0.95,
  /** Ranking window: change over the last N hours. */
  lookbackHours: 52,
  /**
   * On the hour, deliberately: UTC 16:00 in, 00:00 out — UTC+8 00:00 and 08:00.
   *
   * The entry used to sit at 15:55 to dodge the crowd that trades the round
   * hour, and that cost is now accepted on purpose. The backtest can only fill
   * on the hourly grid, so a five-minute offset made every measurement an
   * approximation of what the agent actually did; matching the grid is worth
   * more than the fill it buys, because it is what lets a backtested change be
   * trusted in production.
   *
   * The ranking anchor moves with it — floor(entry − 52h) is now the 12:00 bar
   * two days back rather than 11:00 — which reselects about 8% of the legs.
   */
  openHourUtc: 16,
  openMinuteUtc: 0,
  holdHours: 8
} as const;
