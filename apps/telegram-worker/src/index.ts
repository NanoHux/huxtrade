import { fixedRules, getConfig } from "@huxtrade/config";
import { claimRestartRequest, pool, query, recordHealth, transaction } from "@huxtrade/database";
const config=getConfig(),sleep=(ms:number)=>new Promise((r)=>setTimeout(r,ms));
function format(topic:string,payload:Record<string,unknown>){return `[HuxTrade] ${topic.replace("notification.","")}\n${Object.entries(payload).map(([k,v])=>`${k}: ${typeof v==="object"?JSON.stringify(v):v}`).join("\n")}`;}
async function send(text:string){if(!config.TELEGRAM_BOT_TOKEN||!config.TELEGRAM_CHAT_ID)throw new Error("Telegram is not configured");const r=await fetch(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id:config.TELEGRAM_CHAT_ID,text})});if(!r.ok)throw new Error(`Telegram HTTP ${r.status}`);}
async function tick(){
 if(await claimRestartRequest("telegram-worker")){await pool.end();process.exit(0);}
 const health=await query<{state:string}>("SELECT state FROM service_health WHERE service='telegram-worker'");
 if(health.rows[0]?.state==="degraded"){await query("UPDATE outbox SET status='dropped' WHERE status='pending' AND topic LIKE 'notification.%'");return;}
 const item=await transaction(async(client)=>{const r=await client.query<Record<string,unknown>>("SELECT * FROM outbox WHERE status='pending' AND topic LIKE 'notification.%' AND available_at<=now() ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1");if(!r.rows[0])return null;await client.query("UPDATE outbox SET status='processing' WHERE id=$1",[r.rows[0].id]);return r.rows[0];});
 if(!item)return;
 const eventType=String(item.topic).replace("notification.","");
 const preference=await query<{enabled:boolean}>("SELECT enabled FROM notification_preferences WHERE event_type=$1",[eventType]);
 if(preference.rows[0]&&!preference.rows[0].enabled){await query("UPDATE outbox SET status='dropped' WHERE id=$1",[item.id]);return;}
 try{await send(format(String(item.topic),item.payload as Record<string,unknown>));await query("UPDATE outbox SET status='sent',sent_at=now(),attempts=attempts+1 WHERE id=$1",[item.id]);await recordHealth("telegram-worker",true);}
 catch(error){const attempts=Number(item.attempts)+1;if(attempts>=fixedRules.telegramMaxAttempts){await query("UPDATE outbox SET status='failed',attempts=$1 WHERE id=$2",[attempts,item.id]);await recordHealth("telegram-worker",false,error,false);}else await query("UPDATE outbox SET status='pending',attempts=$1,available_at=now()+interval '10 seconds' WHERE id=$2",[attempts,item.id]);}
}
process.on("SIGTERM",async()=>{await pool.end();process.exit(0);});
await recordHealth("telegram-worker",Boolean(config.TELEGRAM_BOT_TOKEN&&config.TELEGRAM_CHAT_ID),config.TELEGRAM_BOT_TOKEN&&config.TELEGRAM_CHAT_ID?undefined:"Telegram is not configured",false);
while(true){await tick();await sleep(2_000);}
