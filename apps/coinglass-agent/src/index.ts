import { getConfig } from "@huxtrade/config";
import { claimRestartRequest,pool,query,recordBusinessError,recordHealth } from "@huxtrade/database";
import { parseCoinGlassHeatmapUrl,type CoinGlassHeatmapRange } from "@huxtrade/exchange-clients";
import { CoinGlassBrowserClient } from "./browser-capture.js";

const config=getConfig();
const collector=new CoinGlassBrowserClient(config);
const sleep=(ms:number)=>new Promise((resolve)=>setTimeout(resolve,ms));
const lastAssetFailures=new Map<string,string>();
let stopping=false;
const heatmapRanges=new Set<CoinGlassHeatmapRange>(["12h","24h","3d","7d","30d"]);

type RefreshRequest={requestId:string;requestedAt:string;closedAt:string;heatmapRange:CoinGlassHeatmapRange};
type ProbeRequest={requestId:string;requestedAt:string;sourceUrl:string;range:CoinGlassHeatmapRange};

const unresolvedFailures=await query<{asset_id:string;message:string}>(`SELECT DISTINCT ON(e.asset_id) e.asset_id::text,e.message
  FROM business_errors e
  WHERE e.service='coinglass-agent' AND e.code='COINGLASS_HEATMAP_CAPTURE_FAILED' AND e.asset_id IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM coinglass_heatmaps h WHERE h.asset_id=e.asset_id AND h.captured_at>e.occurred_at)
  ORDER BY e.asset_id,e.occurred_at DESC`);
for(const failure of unresolvedFailures.rows)lastAssetFailures.set(failure.asset_id,failure.message);

async function setSession(ready:boolean,error?:string){
  await query(`INSERT INTO app_state(key,value) VALUES('coinglass_session',$1)
    ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`,[JSON.stringify({ready,lastCheckedAt:new Date().toISOString(),error:error??null})]);
}

async function pendingRefreshRequest():Promise<RefreshRequest|undefined>{
  const [request,result]=await Promise.all([
    query<{value:Record<string,unknown>}>("SELECT value FROM app_state WHERE key='coinglass_refresh_request'"),
    query<{value:Record<string,unknown>}>("SELECT value FROM app_state WHERE key='coinglass_refresh_result'")
  ]);
  const value=request.rows[0]?.value;
  if(!value||typeof value.requestId!=="string"||typeof value.requestedAt!=="string"||typeof value.closedAt!=="string"||typeof value.heatmapRange!=="string"||!heatmapRanges.has(value.heatmapRange as CoinGlassHeatmapRange))return undefined;
  if(result.rows[0]?.value.requestId===value.requestId)return undefined;
  return value as RefreshRequest;
}

// Asset creation (§4.2) and the settings "test connection" action both need a
// one-off capture of an arbitrary URL, synchronously, from apps/api's Docker
// container which cannot reach the operator's Chrome itself. They hand the
// job to this natively-running agent through the same Postgres app_state
// request/result handshake the scheduled refresh already uses.
async function pendingProbeRequest():Promise<ProbeRequest|undefined>{
  const [request,result]=await Promise.all([
    query<{value:Record<string,unknown>}>("SELECT value FROM app_state WHERE key='coinglass_probe_request'"),
    query<{value:Record<string,unknown>}>("SELECT value FROM app_state WHERE key='coinglass_probe_result'")
  ]);
  const value=request.rows[0]?.value;
  if(!value||typeof value.requestId!=="string"||typeof value.requestedAt!=="string"||typeof value.sourceUrl!=="string"||typeof value.range!=="string"||!heatmapRanges.has(value.range as CoinGlassHeatmapRange))return undefined;
  if(result.rows[0]?.value.requestId===value.requestId)return undefined;
  return value as ProbeRequest;
}

async function handleProbe(request:ProbeRequest){
  try{
    parseCoinGlassHeatmapUrl(request.sourceUrl);
    const result=await collector.capture(request.sourceUrl,request.range);
    await query(`INSERT INTO app_state(key,value) VALUES('coinglass_probe_result',$1)
      ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`,[JSON.stringify({
      requestId:request.requestId,ok:true,sourceUrl:result.sourceUrl,capturedAt:result.capturedAt.toISOString(),regions:result.regions,raw:result.raw
    })]);
  }catch(error){
    await query(`INSERT INTO app_state(key,value) VALUES('coinglass_probe_result',$1)
      ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`,[JSON.stringify({
      requestId:request.requestId,ok:false,error:error instanceof Error?error.message:String(error)
    })]);
  }
}

async function scan(request?:RefreshRequest){
  const strategy=(await query<{heatmap_range:CoinGlassHeatmapRange}>("SELECT heatmap_range FROM strategies WHERE enabled=true LIMIT 1")).rows[0];
  const range=request?.heatmapRange??strategy?.heatmap_range??"24h";
  const assets=await query<{id:string;code:string;coinglass_url:string;captured_at:string|null}>(`SELECT a.id,a.code,a.coinglass_url,h.captured_at::text
    FROM assets a LEFT JOIN coinglass_heatmaps h ON h.asset_id=a.id AND h.heatmap_range=$1
    WHERE a.collect_enabled=true ORDER BY a.code`,[range]);
  let succeeded=0,fresh=0,captured=0;
  for(const asset of assets.rows){
    if(stopping)break;
    const age=asset.captured_at?Date.now()-new Date(asset.captured_at).getTime():Infinity;
    if(!request&&age<config.COINGLASS_REFRESH_MS){fresh+=1;continue;}
    // Back-to-back full-page navigations of a heavy ECharts/WebGL heatmap
    // with no pause between them has crashed the Chrome renderer in practice.
    if(captured>0)await sleep(config.COINGLASS_CAPTURE_DELAY_MS);
    captured+=1;
    try{
      const result=await collector.capture(asset.coinglass_url,range);
      await query(`INSERT INTO coinglass_heatmaps(asset_id,heatmap_range,source_url,captured_at,regions,raw)
        VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT(asset_id,heatmap_range) DO UPDATE SET source_url=EXCLUDED.source_url,captured_at=EXCLUDED.captured_at,regions=EXCLUDED.regions,raw=EXCLUDED.raw,updated_at=now()`,[
        asset.id,range,result.sourceUrl,result.capturedAt,JSON.stringify(result.regions),JSON.stringify(result.raw)
      ]);
      lastAssetFailures.delete(asset.id);
      succeeded+=1;
    }catch(error){
      const message=error instanceof Error?error.message:String(error);
      if(lastAssetFailures.get(asset.id)!==message){
        await recordBusinessError({service:"coinglass-agent",assetId:asset.id,code:"COINGLASS_HEATMAP_CAPTURE_FAILED",message,blocksTrading:true,context:{code:asset.code,range,sourceUrl:asset.coinglass_url}});
        lastAssetFailures.set(asset.id,message);
      }
    }
  }
  const missing=assets.rows.length-(fresh+succeeded);
  const ok=assets.rows.length>0&&missing===0;
  const ready=ok;
  await setSession(ready,ok?undefined:`${missing} Heatmap capture(s) unavailable`);
  await recordHealth("coinglass-agent",ok,ok?undefined:`${missing} of ${assets.rows.length} Heatmap capture(s) unavailable`,!ok);
  if(request)await query(`INSERT INTO app_state(key,value) VALUES('coinglass_refresh_result',$1)
    ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`,[JSON.stringify({requestId:request.requestId,requestedAt:request.requestedAt,closedAt:request.closedAt,heatmapRange:range,completedAt:new Date().toISOString(),assetCount:assets.rows.length,succeeded,failed:missing})]);
}

while(!stopping){
  // The backend can rewrite the session header and ask for a restart; exiting
  // lets the supervisor reload .env instead of running on a stale credential.
  if(await claimRestartRequest("coinglass-agent")){await collector.close();await pool.end();process.exit(0);}
  if(config.COINGLASS_ADAPTER_MODE!=="browser"){
    // Fail visible, not fatal: a crash loop would never report health and would
    // make the credential-restart verification in the API look like a failure.
    await setSession(false,"COINGLASS_ADAPTER_MODE is not browser");
    await recordHealth("coinglass-agent",false,"COINGLASS_ADAPTER_MODE is not browser; configure the session in 系统设置",true,false);
    await sleep(config.COINGLASS_AGENT_POLL_MS);
    continue;
  }
  try{
    const probe=await pendingProbeRequest();
    if(probe)await handleProbe(probe);
    await scan(await pendingRefreshRequest());
  }catch(error){await setSession(false,error instanceof Error?error.message:String(error));await recordHealth("coinglass-agent",false,error,true);}
  if(!stopping)await sleep(config.COINGLASS_AGENT_POLL_MS);
}

async function shutdown(){stopping=true;await collector.close();await pool.end();}
process.on("SIGINT",()=>{void shutdown();});
process.on("SIGTERM",()=>{void shutdown();});
