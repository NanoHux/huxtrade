const serverApi=process.env.API_INTERNAL_URL??process.env.NEXT_PUBLIC_API_URL??"http://localhost:4000";
export async function api<T>(path:string,fallback:T):Promise<T>{
 try{const response=await fetch(`${serverApi}${path}`,{cache:"no-store"});if(!response.ok)throw new Error(`${response.status}`);return await response.json() as T;}catch{return fallback;}
}
export const publicApi=process.env.NEXT_PUBLIC_API_URL??"http://localhost:4000";

