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

export function resolveConfiguredPath(value:string,sourceEnvFile=envFilePath){
  return resolve(dirname(sourceEnvFile),value);
}

const bool = z.enum(["true", "false"]).default("false").transform((v) => v === "true");
const coinGlassBrowserHeaders=z.string().default("").transform((value,context)=>{
  const allowed=new Set(["accept-language","priority","sec-ch-ua","sec-ch-ua-mobile","sec-ch-ua-platform","sec-fetch-dest","sec-fetch-mode","sec-fetch-site","user-agent"]);
  try{
    const parsed=JSON.parse(value?Buffer.from(value,"base64url").toString("utf8"):"{}") as unknown;
    if(!parsed||typeof parsed!=="object"||Array.isArray(parsed))throw new Error("must be a JSON object");
    const result:Record<string,string>={};
    for(const [name,headerValue] of Object.entries(parsed)){
      if(!allowed.has(name)||typeof headerValue!=="string"||headerValue.length>1024||/[\r\n]/.test(headerValue))throw new Error(`invalid browser header ${name}`);
      result[name]=headerValue;
    }
    return result;
  }catch(error){
    context.addIssue({code:"custom",message:`Invalid COINGLASS_BROWSER_HEADERS_B64: ${error instanceof Error?error.message:String(error)}`});
    return z.NEVER;
  }
});
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().default("postgres://huxtrade:huxtrade@localhost:5432/huxtrade"),
  API_HOST: z.string().default("0.0.0.0"),
  API_PORT: z.coerce.number().int().positive().default(4000),
  WEB_ORIGIN: z.string().default("http://localhost:3000"),
  BINANCE_FUTURES_BASE_URL: z.string().url().default("https://fapi.binance.com"),
  COINGLASS_ADAPTER_MODE: z.enum(["disabled","free-web"]).default("disabled"),
  COINGLASS_OBE: z.string().default(""),
  COINGLASS_BROWSER_HEADERS_B64: coinGlassBrowserHeaders,
  COINGLASS_AGENT_POLL_MS: z.coerce.number().int().min(5_000).default(15_000),
  COINGLASS_REFRESH_MS: z.coerce.number().int().min(60_000).default(10*60_000),
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
    cached={...parsed,VARIATIONAL_PROFILE_PATH:resolveConfiguredPath(parsed.VARIATIONAL_PROFILE_PATH),VARIATIONAL_DISCOVERY_OUTPUT:resolveConfiguredPath(parsed.VARIATIONAL_DISCOVERY_OUTPUT)};
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
