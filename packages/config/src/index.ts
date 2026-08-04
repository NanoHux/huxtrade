import dotenv from "dotenv";
import { z } from "zod";

// Service restarts intentionally reload the bind-mounted .env by default.
// One-off tools can set ENV_FILE_OVERRIDE=false so explicit shell variables win.
dotenv.config({path:process.env.ENV_FILE_PATH??".env",override:process.env.ENV_FILE_OVERRIDE!=="false"});

const bool = z.enum(["true", "false"]).default("false").transform((v) => v === "true");
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().default("postgres://huxtrade:huxtrade@localhost:5432/huxtrade"),
  API_HOST: z.string().default("0.0.0.0"),
  API_PORT: z.coerce.number().int().positive().default(4000),
  WEB_ORIGIN: z.string().default("http://localhost:3000"),
  BINANCE_FUTURES_BASE_URL: z.string().url().default("https://fapi.binance.com"),
  COINGLASS_BASE_URL: z.string().url().default("https://open-api-v4.coinglass.com"),
  COINGLASS_API_KEY: z.string().default(""),
  VARIATIONAL_BASE_URL: z.string().default(""),
  VARIATIONAL_PROFILE_PATH: z.string().default("./playwright-profile"),
  VARIATIONAL_BROWSER_EXECUTABLE: z.string().default(""),
  VARIATIONAL_DISCOVERY_OUTPUT: z.string().default("./variational-discovery"),
  VARIATIONAL_DISCOVERY_ALLOWED_ORIGINS: z.string().default(""),
  VARIATIONAL_ADAPTER_MODE: z.enum(["disabled", "discovery", "http", "browser-fetch", "ui"]).default("disabled"),
  LIVE_TRADING_ENABLED: bool,
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
  cached ??= schema.parse(process.env);
  if (cached.MARGIN_RESUME_PERCENT >= cached.MARGIN_PAUSE_PERCENT) {
    throw new Error("MARGIN_RESUME_PERCENT must be lower than MARGIN_PAUSE_PERCENT");
  }
  if(cached.LIVE_TRADING_ENABLED&&!["http","browser-fetch","ui"].includes(cached.VARIATIONAL_ADAPTER_MODE)){
    throw new Error("LIVE_TRADING_ENABLED requires a production Variational adapter mode");
  }
  return cached;
}

export const fixedRules = Object.freeze({
  scanMinutes: 15,
  binanceStaleMs: 5 * 60_000,
  heatmapStaleMs: 30 * 60_000,
  robustZThreshold: 1,
  minimumRiskReward: 1.5,
  stopAtrBuffer: 0.5,
  takeProfitAtrOffset: 0.15,
  variationalPollMs: 30_000,
  telegramRetryMs: 10_000,
  telegramMaxAttempts: 3,
  displayTimeZone: "Asia/Shanghai"
});
