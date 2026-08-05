import { Buffer } from "node:buffer";
import { discoveryJsonBody,discoverySafeUrl } from "./discovery-utils.js";

type JsonRecord=Record<string,unknown>;

function record(value:unknown):JsonRecord|undefined{
  return value&&typeof value==="object"&&!Array.isArray(value)?value as JsonRecord:undefined;
}

function harText(content:JsonRecord|undefined):string|null{
  if(!content||typeof content.text!=="string")return null;
  if(content.text.length>700_000)return null;
  if(content.encoding==="base64")try{return Buffer.from(content.text,"base64").toString("utf8");}catch{return null;}
  return content.text;
}

export function sanitizeHar(har:unknown,allowedOrigins:Set<string>):Array<Record<string,unknown>>{
  const root=record(har),log=record(root?.log);
  const entries=Array.isArray(log?.entries)?log.entries:[];
  const events:Array<Record<string,unknown>>=[];
  for(const item of entries){
    const entry=record(item),request=record(entry?.request),response=record(entry?.response);
    if(!request||typeof request.url!=="string"||typeof request.method!=="string")continue;
    let url:URL;
    try{url=new URL(request.url);}catch{continue;}
    if(!allowedOrigins.has(url.origin)||!url.pathname.startsWith("/api/"))continue;
    const postData=record(request.postData);
    events.push({
      at:typeof entry?.startedDateTime==="string"?entry.startedDateTime:undefined,
      kind:"request",
      method:request.method.toUpperCase(),
      url:discoverySafeUrl(request.url),
      body:discoveryJsonBody(typeof postData?.text==="string"?postData.text:null)
    });
    if(!response)continue;
    const content=record(response.content);
    const contentType=typeof content?.mimeType==="string"?content.mimeType:"";
    events.push({
      at:typeof entry?.startedDateTime==="string"?entry.startedDateTime:undefined,
      kind:"response",
      method:request.method.toUpperCase(),
      url:discoverySafeUrl(request.url),
      status:typeof response.status==="number"?response.status:undefined,
      contentType,
      body:contentType.includes("json")?discoveryJsonBody(harText(content)):undefined
    });
  }
  return events;
}

