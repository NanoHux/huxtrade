import dotenv from "dotenv";
import { existsSync } from "node:fs";
import { dirname,resolve } from "node:path";
import { z } from "zod";

// Service restarts intentionally reload the bind-mounted .env by default.
// One-off tools can set ENV_FILE_OVERRIDE=false so explicit shell variables win.
function findEnvFile(){
  if(process.env.ENV_FILE_PATH)return resolve(process.env.ENV_FILE_PATH);
  let directory=process.cwd();
  while(true){
    const candidate=resolve(directory,".env");
    if(existsSync(candidate))return candidate;
    const parent=dirname(directory);
    if(parent===directory)return resolve(process.cwd(),".env");
    directory=parent;
  }
}
const envFilePath=findEnvFile();
dotenv.config({path:envFilePath,override:process.env.ENV_FILE_OVERRIDE!=="false"});
// Anything that edits secrets on disk (API settings routes) must write to
// this exact resolved path, not re-derive it from cwd/ENV_FILE_PATH — pnpm's
// filtered `start` scripts chdir into the package directory, so a fresh
// resolve(".env") silently lands on a different, non-bind-mounted file.
export function getEnvFilePath(){return envFilePath;}

export function resolveConfiguredPath(value:string,sourceEnvFile=envFilePath){
  return resolve(dirname(sourceEnvFile),value);
}

const bool = z.enum(["true", "false"]).default("false").transform((v) => v === "true");
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().default("postgres://huxtrade:huxtrade@localhost:5432/huxtrade"),
  API_HOST: z.string().default("0.0.0.0"),
  API_PORT: z.coerce.number().int().positive().default(4000),
  WEB_ORIGIN: z.string().default("http://localhost:3000"),
  BINANCE_FUTURES_BASE_URL: z.string().url().default("https://fapi.binance.com"),
  COINGLASS_ADAPTER_MODE: z.enum(["disabled","browser"]).default("disabled"),
  COINGLASS_PROFILE_PATH: z.string().default("./coinglass-profile"),
  COINGLASS_BROWSER_EXECUTABLE: z.string().default(""),
  COINGLASS_CDP_URL: z.string().default(""),
  COINGLASS_AGENT_POLL_MS: z.coerce.number().int().min(5_000).default(15_000),
  COINGLASS_REFRESH_MS: z.coerce.number().int().min(60_000).default(15*60_000),
  COINGLASS_CAPTURE_DELAY_MS: z.coerce.number().int().min(0).default(2_000),
  VARIATIONAL_BASE_URL: z.string().default(""),
  VARIATIONAL_PROFILE_PATH: z.string().default("./playwright-profile"),
  VARIATIONAL_BROWSER_EXECUTABLE: z.string().default(""),
  VARIATIONAL_CDP_URL: z.string().default(""),
  VARIATIONAL_DISCOVERY_OUTPUT: z.string().default("./variational-discovery"),
  VARIATIONAL_DISCOVERY_ALLOWED_ORIGINS: z.string().default(""),
  VARIATIONAL_ADAPTER_MODE: z.enum(["disabled", "discovery", "http", "browser-fetch", "ui"]).default("disabled"),
  VARIATIONAL_ENTRY_SLIPPAGE: z.coerce.number().min(0).max(0.1).default(0.005),
  VARIATIONAL_PROTECTION_SLIPPAGE: z.coerce.number().min(0).max(0.1).default(0.03),
  VARIATIONAL_CLOSE_SLIPPAGE: z.coerce.number().min(0).max(0.1).default(0.01),
  LIVE_TRADING_ENABLED: bool,
  // Shadow is the default and must stay that way until the resting model has
  // its own track record: it computes every decision and writes every
  // entry_plans row, but emits no outbox message, so the live path is written
  // and wired yet electrically dead. Flipping to `live` is the rollout step,
  // and flipping back is the whole rollback plan.
  STRATEGY_EXECUTION_MODE: z.enum(["shadow","live"]).default("shadow"),
  TELEGRAM_BOT_TOKEN: z.string().default(""),
  TELEGRAM_CHAT_ID: z.string().default(""),
  DEFAULT_MARGIN_USDC: z.coerce.number().min(1).default(10),
  MAX_MARGIN_USDC: z.coerce.number().min(1).default(20),
  LEVERAGE: z.coerce.number().int().positive().default(5),
  MAX_ORDERS_PER_SYMBOL_SIDE: z.coerce.number().int().positive().default(5),
  MARGIN_PAUSE_PERCENT: z.coerce.number().min(0).max(100).default(80),
  MARGIN_RESUME_PERCENT: z.coerce.number().min(0).max(100).default(75)
});

export type AppConfig = z.infer<typeof schema>;
let cached: AppConfig | undefined;
export function getConfig(): AppConfig {
  if(!cached){
    const parsed=schema.parse(process.env);
    cached={...parsed,VARIATIONAL_PROFILE_PATH:resolveConfiguredPath(parsed.VARIATIONAL_PROFILE_PATH),VARIATIONAL_DISCOVERY_OUTPUT:resolveConfiguredPath(parsed.VARIATIONAL_DISCOVERY_OUTPUT),COINGLASS_PROFILE_PATH:resolveConfiguredPath(parsed.COINGLASS_PROFILE_PATH)};
  }
  if (cached.MARGIN_RESUME_PERCENT >= cached.MARGIN_PAUSE_PERCENT) {
    throw new Error("MARGIN_RESUME_PERCENT must be lower than MARGIN_PAUSE_PERCENT");
  }
  if(cached.LIVE_TRADING_ENABLED&&cached.VARIATIONAL_ADAPTER_MODE!=="browser-fetch")throw new Error("LIVE_TRADING_ENABLED requires the implemented browser-fetch Variational adapter");
  if(cached.VARIATIONAL_ADAPTER_MODE==="browser-fetch"&&!cached.VARIATIONAL_BASE_URL)throw new Error("VARIATIONAL_BASE_URL is required for browser-fetch mode");
  if(cached.VARIATIONAL_CDP_URL){
    const url=new URL(cached.VARIATIONAL_CDP_URL);
    if(!["127.0.0.1","localhost","::1"].includes(url.hostname))throw new Error("VARIATIONAL_CDP_URL must use a loopback host");
  }
  if(cached.COINGLASS_CDP_URL){
    const url=new URL(cached.COINGLASS_CDP_URL);
    if(!["127.0.0.1","localhost","::1"].includes(url.hostname))throw new Error("COINGLASS_CDP_URL must use a loopback host");
  }
  return cached;
}

export const fixedRules = Object.freeze({
  scanMinutes: 15,
  binanceStaleMs: 5 * 60_000,
  heatmapStaleMs: 30 * 60_000,
  robustZThreshold: 1,
  // The reward/risk floor an order must clear to be worth placing. There is no
  // fallback beneath it: a signal whose structure cannot pay 1.4 times its own
  // stop distance is not traded at all, rather than traded on a stop invented
  // from the margin size.
  minimumRiskReward: 1.4,
  // A CAP on where the target may sit, not a filter that refuses the trade.
  // Replaying the 2026-08-07..09 plan ledger (231 plans, 84 fills, 67
  // resolved) against 1m bars, the hit rate falls apart as the planned ratio
  // rises: 1.4-1.8 hit 14% of the time, 2.5-4.0 hit 11%, and 4.0+ hit 0 times
  // in 25 trades. A ratio that high is not a better trade, it is a target
  // parked on a liquidation peak price never reaches — so the answer is to
  // bring the target in to 4R and take the trade, not to throw the setup away.
  // The same price also stands in as the objective when there is no zone
  // ahead at all, which is a runaway move rather than a reason to refuse.
  maximumRiskReward: 4,
  stopAtrBuffer: 0.5,
  takeProfitAtrOffset: 0.15,
  // A zone standing between the entry and the objective is only treated as a
  // real obstacle once it reaches this share of the objective's own intensity.
  // Below it the cluster is assumed to be run through — the direction call
  // said price is going that way, and a thin band of liquidations is what such
  // a move consumes on the way. At or above it the move is assumed to stall
  // there instead, so it becomes the objective and the ratio is measured
  // against it. Evaluated exactly once: the demoted objective is not itself
  // re-scanned for obstacles, which would recurse without a natural end.
  // 0.7 rather than 0.6: replaying 750 armed scans, raising it to 0.7 turned
  // 11% more of them into placeable plans and lifted the median ratio from
  // 4.48 to 4.77, because fewer mid-sized clusters demote the objective away
  // from the real peak. That gain is an assumption, not a discovery — every
  // extra plan is one that expects price to run through a cluster the old
  // threshold respected — so it is worth revisiting once enough trades have
  // reached their own target or stop to say whether the assumption holds.
  falsePeakIntensityRatio: 0.7,
  // Never settable: the per-asset stacking cap is a spec red line, not a
  // tuning knob. Variational nets an instrument into one aggregate position
  // with one auto-resizing TP/SL, so a second same-direction order shares the
  // first one's stop and both die together.
  maxWorkingOrdersPerAsset: 1,
  // Defaults for the resting limit entry model. Every knob the entry-band /
  // confluence / hysteresis algorithm reads lives here, so none of it can
  // drift into a hardcoded literal at a call site — and each is overridable
  // per strategy through strategies.resting_entry, so tuning never needs a
  // redeploy. resolveRestingEntry() in strategy-engine merges the two.
  restingEntry: Object.freeze({
    // Entry band, in 1h ATR from the scan's reference price. Nearer than
    // `min` there is no execution advantage over just taking the market;
    // farther than `max` the order would rarely fill and would be leaning on
    // structure that has gone stale by the time price gets there.
    entryBandAtrMin: 0.3,
    entryBandAtrMax: 2.5,
    // The order sits *in front of* the structure it leans on, never inside
    // it: the liquidation sweep is what triggers the reversal, so the fill
    // has to happen before price reaches the zone's near edge.
    entryOffsetAtr: 0.1,
    confluenceMergeAtr: 0.35,
    // Hysteresis band. Below this the working order is left alone — churning
    // the same level every 15 minutes costs cancel/replace round-trips and
    // loses queue position for no structural reason.
    replaceThresholdAtr: 0.25,
    biasPersistenceScans: 4,
    // A single counter-signal is not a reversal. Flipping on one 15m bar used
    // a signal noisier than the stop-loss to overrule the stop-loss: an armed
    // BTC bias reversed six times in five hours, and each reversal after a
    // fill market-closed a position that still had its own defined risk. A
    // flip now has to be asserted this many times, with no intervening
    // confirmation of the original direction, before anything is acted on.
    // One counter-signal is enough to withdraw an UNFILLED order: cancelling
    // costs nothing but a round trip, so the asymmetry that justified waiting
    // for a second assertion does not exist here. Filled positions are never
    // closed on a direction signal at all (revalidateWorkingOrder rule 4), so
    // this number has never governed them.
    flipConfirmationScans: 1,
    // Every tracked asset may arm at once. If Phase 0 P0-2 shows that resting
    // orders lock initial margin, lowering this is the lever that stops the
    // account parking its whole margin in orders that never fill.
    maxArmedAssets: 15,
    // Heatmap candidates score on the region's `percentile`, which
    // eligibleHeatmapRegions already normalises to 0..1. Raw `intensity` is
    // an absolute Coinglass number whose scale differs per asset and per
    // range, so it could never be compared against a fixed swing/EMA weight
    // or summed with one at a confluence.
    swingScore: 0.55,
    emaScore: 0.3,
    // Incumbency. Without it the selection is winner-take-all, so two clusters
    // whose scores differ by a hair — and whose prices differ by more than a
    // full ATR — trade places whenever one of them drifts across the entry
    // band's far edge, teleporting the working order back and forth. The
    // replace hysteresis cannot damp that: it measures price distance, and the
    // two candidates are genuinely far apart. This makes the sitting structure
    // defend its place instead.
    incumbentScoreBonus: 0.5,
    // Refuses to trade WITH a move that has already run, in either direction.
    //
    // Selling pressure inside a strong advance is profit-taking, not a turn.
    // Replaying seven days across ten assets, SHORT signals on something
    // already up 10%+ over 24h averaged -4.66% against the position in the
    // following hour and won 27.6% of the time, against -0.11% and 45.6% on
    // quiet assets — the same signal inverted, not merely weakened. Every
    // stop-out in the first week was a short, three of them into 24h gains of
    // 8%, 12% and 38%. The threshold sits above the measured 10% so it only
    // refuses the extreme case rather than most of one side.
    //
    // The long side is now filtered on the same threshold by operator
    // decision. Stated plainly: the mirror case was measured on only 14
    // observations, which is not evidence, so this half rests on the symmetry
    // argument rather than on data — worth revisiting once enough longs into
    // 15% dumps have resolved to measure it directly.
    extremeMoveBlockPercent: 15,
    // Same-direction circuit breaker. Three stop-outs one way inside a few
    // hours is the signature of a regime the model is reading backwards, not
    // of three independent unlucky trades: on 2026-08-08 four shorts stopped
    // out between 18:58 and 22:14 for -157 USDC, and halting after the third
    // would have prevented the last of them. Halting only stops that
    // direction ARMING; positions keep their own stop and target, and working
    // orders drain naturally as their bias expires.
    lossStreakCount: 3,
    lossStreakWindowHours: 6,
    lossStreakHaltHours: 12,
    // Scale-out. Of 67 resolved trades in the 2026-08-07..09 replay, 61%
    // reached +0.6R of unrealised profit and 72% reached +0.5R, yet only 12%
    // ever reached their target: the dominant outcome is a position that goes
    // meaningfully green and then gives all of it back plus the stop. Taking
    // part of the position off at this level and moving the rest's stop to
    // breakeven moves per-trade expectancy from -0.691R to about 0.00R.
    //
    // Two honest caveats live with these numbers. The excursion is measured on
    // 1m bar highs, so some of it was never transactable — the live trigger
    // reads the venue's own mark price instead, and will therefore fire less
    // often than the replay implies. And the replay's optimum keeps sliding
    // toward "exit sooner, exit more", whose limit is not trading at all; 0.5R
    // is chosen as the point where the excursion distribution is still dense
    // (72%) rather than as the peak of a curve fitted to 67 samples.
    scaleOutTriggerR: 0.5,
    scaleOutFraction: 0.5,
    // Below this stop width the scale-out is skipped entirely. TRUMP's stop
    // was 0.41% of price, which puts 0.5R at 0.2% — the spread paid to close
    // half at market on an RFQ venue eats a large share of that, so the
    // round trip stops being worth its own execution cost.
    scaleOutMinStopPercent: 0.8,
    // The breakeven stop is set this fraction of a stop-width *beyond* entry,
    // in the position's favour, so the exit still clears the spread rather
    // than scratching at exactly the entry price and paying to get out.
    breakevenOffsetR: 0.05,
    // The stop must clear the quoted spread by this multiple or the order is
    // not worth submitting. Measured against the SPREAD, not as a percentage
    // of price: PAXG's 0.062% stop was only 1.08x its own 0.057% spread, so
    // the position would have been most of the way to its stop the moment it
    // filled, while BTC trades fine on a 0.21% stop because its spread is
    // small. No flat percentage floor separates those two.
    //
    // 4, not the 8 this first shipped with. 8 was reasoned from Binance
    // order-book spreads; Variational quotes RFQ and its majors sit at 5-7
    // basis points, which would have refused roughly a fifth of all plans —
    // and refused them hardest on the low-volatility majors the rule was
    // never aimed at. At 4x one round trip costs a quarter of the stop, which
    // is already expensive; the number is provisional until enough rejections
    // have logged real spreads to set it from the distribution rather than
    // from an analogy.
    minStopSpreadMultiple: 4,
    // Structural rejections repeat: PAXG rebuilt the same sub-spread stop and
    // was refused every 15 minutes, leaving a dead order row each time. After
    // this many in a row the asset stops being offered for submission for
    // `structuralBackoffHours`. Transient venue refusals (skew limits) and
    // network failures are deliberately excluded — those clear on their own.
    structuralRejectionLimit: 3,
    structuralBackoffHours: 6,
    // Virtual entries. The level is tracked locally and nothing reaches the
    // venue until price arrives AND two 5m closes decline to contradict the
    // trade. A resting limit order is filled TO you — price arrives, the order
    // is taken, and the model learns about it afterwards; this makes the last
    // step a decision instead. Cancelling a virtual entry costs nothing, which
    // is what makes the extra question worth asking. Set false to go back to
    // posting the limit order immediately.
    virtualEntryConfirmation: 1,
    // Confirmation runs on the close of 5m candles.
    virtualEntryIntervalMinutes: 5
  }),
  // Whitelist size. Every asset costs one CoinGlass heatmap capture and one
  // Binance round trip per 15-minute scan, which is the real constraint — the
  // capture agent already reports occasional misses at 28 assets. Raised from
  // 50 because assets with trading history cannot be deleted (that would take
  // their orders and signals with them), so retired ones accumulate against
  // the cap forever and the ceiling was being spent on tickers nobody trades.
  maxAssets: 120,
  variationalPollMs: 30_000,
  telegramRetryMs: 10_000,
  telegramMaxAttempts: 3,
  displayTimeZone: "Asia/Shanghai"
});
