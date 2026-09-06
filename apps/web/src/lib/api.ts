const serverApi=process.env.API_INTERNAL_URL||process.env.NEXT_PUBLIC_API_URL||"http://localhost:4000";
export async function api<T>(path:string,fallback:T):Promise<T>{
 try{const response=await fetch(`${serverApi}${path}`,{cache:"no-store"});if(!response.ok)throw new Error(`${response.status}`);return await response.json() as T;}catch{return fallback;}
}
/**
 * Base for fetches made in the browser. Empty by default, so they go to this
 * app's own origin and get proxied on by the rewrite in next.config.mjs —
 * whatever address the page was opened at. Set NEXT_PUBLIC_API_URL only to
 * point the browser somewhere else on purpose; an absolute value here has to
 * be routable from every machine that opens the page.
 */
export const publicApi=process.env.NEXT_PUBLIC_API_URL??"";
