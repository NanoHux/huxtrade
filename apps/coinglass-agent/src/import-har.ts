import { chmod,readFile,writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CoinGlassFreeWebClient } from "@huxtrade/exchange-clients";
import { extractCoinGlassSessionFromHar } from "./har.js";

const harPath=process.argv[2];
const probeUrl=process.argv[3]??"https://www.coinglass.com/pro/futures/LiquidationHeatMap?coin=ETH&type=pair";
if(!harPath)throw new Error("Usage: pnpm --filter @huxtrade/coinglass-agent import-har <file.har> [probe-url]");

const projectRoot=resolve(import.meta.dirname,"../../..");
const har=JSON.parse(await readFile(resolve(process.env.INIT_CWD??projectRoot,harPath),"utf8")) as unknown;
const session=extractCoinGlassSessionFromHar(har);
await new CoinGlassFreeWebClient(undefined,undefined,undefined,session.obe,session.browserHeaders).capture(probeUrl,"24h");

const envPath=resolve(process.env.ENV_FILE_PATH??resolve(projectRoot,".env"));
let content="";
try{content=await readFile(envPath,"utf8");}catch{}
const values={
  COINGLASS_OBE:session.obe,
  COINGLASS_BROWSER_HEADERS_B64:Buffer.from(JSON.stringify(session.browserHeaders)).toString("base64url")
};
content=content.replace(/^COINGLASS_BROWSER_HEADERS=.*(?:\n|$)/m,"");
for(const [key,value] of Object.entries(values)){
  const line=`${key}=${JSON.stringify(value)}`;
  const pattern=new RegExp(`^${key}=.*$`,"m");
  content=pattern.test(content)?content.replace(pattern,line):`${content.trimEnd()}\n${line}\n`;
}
await writeFile(envPath,content,{encoding:"utf8",mode:0o600});
await chmod(envPath,0o600);
console.log(JSON.stringify({ok:true,probe:new URL(probeUrl).searchParams.get("coin"),savedTo:envPath}));
