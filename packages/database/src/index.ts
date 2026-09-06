import pg from "pg";
import { getConfig } from "@huxtrade/config";

const { Pool } = pg;
export const pool = new Pool({ connectionString: getConfig().DATABASE_URL, max: 12 });
export const query = <T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values: unknown[] = []) => pool.query<T>(text, values);

export async function transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const value = await fn(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Record one health poll.
 *
 * `degradeAfter` is how many consecutive failed polls it takes to call the
 * service degraded. It exists because a service that polls a remote API turns
 * every dropped request into a state flip, and every flip back emits a
 * recovery notification: one blip on the wire became one Telegram message, a
 * dozen a day. Below the threshold the failure is still counted, but the state
 * — and therefore the notification and the error log — stays put.
 *
 * Leave it at 1 for checks that are already debounced by their caller (the
 * telegram worker only reports failure after exhausting its retries) or where
 * a single failure really is the outage.
 */
export async function recordHealth(service: string, ok: boolean, error?: unknown, blocksTrading = false,emitRecoveryEvent=true,degradeAfter=1) {
  const previous=(await query<{state:string;error:string|null;consecutive_failures:number}>("SELECT state,error,consecutive_failures FROM service_health WHERE service=$1",[service])).rows[0];
  const message = error instanceof Error ? error.message : error ? String(error) : null;
  const failures = ok ? 0 : (previous?.consecutive_failures ?? 0) + 1;
  const wasDegraded = previous?.state === "degraded";
  // Hold the previous state while the failures are still under the threshold,
  // so a blip neither degrades the service nor, on the next poll, "recovers" it.
  const state = ok ? "healthy" : failures >= degradeAfter ? "degraded" : (previous?.state ?? "healthy");
  await query(
    `INSERT INTO service_health(service, state, last_success_at, consecutive_failures, error, blocks_trading, updated_at)
     VALUES ($1, $2, CASE WHEN $3 THEN now() ELSE NULL END, $6, $4, $5, now())
     ON CONFLICT (service) DO UPDATE SET
       state=EXCLUDED.state,
       last_success_at=CASE WHEN $3 THEN now() ELSE service_health.last_success_at END,
       consecutive_failures=EXCLUDED.consecutive_failures,
       error=EXCLUDED.error, blocks_trading=EXCLUDED.blocks_trading, updated_at=now()`,
    [service, state, ok, message, blocksTrading, failures]
  );
  if(!ok&&message&&state==="degraded"&&(!wasDegraded||previous.error!==message))await query("INSERT INTO business_errors(service,code,message,blocks_trading) VALUES($1,'SERVICE_HEALTH_FAILURE',$2,$3)",[service,message,blocksTrading]);
  if(ok&&emitRecoveryEvent&&wasDegraded)await query("INSERT INTO outbox(topic,payload) VALUES('notification.service_recovered',$1)",[JSON.stringify({service,recoveredAt:new Date().toISOString()})]);
}

export async function recordBusinessError(input:{service:string;code:string;message:string;assetId?:string;context?:Record<string,unknown>;blocksTrading?:boolean}){
  await query("INSERT INTO business_errors(service,asset_id,code,message,context,blocks_trading) VALUES($1,$2,$3,$4,$5,$6)",[
    input.service,input.assetId??null,input.code,input.message,JSON.stringify(input.context??{}),input.blocksTrading??false
  ]);
}

export async function claimRestartRequest(service:string):Promise<boolean>{
  return transaction(async(client)=>{
    const result=await client.query<{id:string}>(`SELECT id::text FROM outbox WHERE topic='service.restart_requested' AND status='pending' AND payload->>'service'=$1 ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1`,[service]);
    if(!result.rows[0])return false;
    await client.query("UPDATE outbox SET status='sent',sent_at=now() WHERE id=$1",[result.rows[0].id]);
    return true;
  });
}
