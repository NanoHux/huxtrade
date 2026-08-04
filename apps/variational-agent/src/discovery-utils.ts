const sensitive=/(authorization|cookie|token|secret|password|signature|private|session|wallet|address|credential)/i;

export function redactDiscoveryValue(value:unknown,key=""):unknown{
  if(sensitive.test(key))return "[REDACTED]";
  if(Array.isArray(value))return value.map((item)=>redactDiscoveryValue(item));
  if(value&&typeof value==="object")return Object.fromEntries(Object.entries(value as Record<string,unknown>).map(([name,item])=>[name,redactDiscoveryValue(item,name)]));
  return value;
}

export function discoveryJsonBody(text:string|null){
  if(!text)return undefined;
  if(text.length>500_000)return "[BODY_TOO_LARGE]";
  try{return redactDiscoveryValue(JSON.parse(text));}catch{return "[NON_JSON_BODY]";}
}

export function discoverySafeUrl(raw:string){
  const url=new URL(raw);
  const query=[...url.searchParams.keys()].map((key)=>`${encodeURIComponent(key)}=[REDACTED]`).join("&");
  return `${url.origin}${url.pathname}${query?`?${query}`:""}`;
}
