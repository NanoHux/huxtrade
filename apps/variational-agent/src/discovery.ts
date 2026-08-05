import { appendFile,chmod,mkdir } from "node:fs/promises";
import { join,resolve } from "node:path";
import { chromium } from "playwright-core";
import { getConfig } from "@huxtrade/config";
import { findBrowserExecutable } from "./browser-runtime.js";
import { discoveryJsonBody,discoverySafeUrl } from "./discovery-utils.js";

const config=getConfig();
if(config.VARIATIONAL_ADAPTER_MODE!=="discovery")throw new Error("Set VARIATIONAL_ADAPTER_MODE=discovery before protocol capture");
if(!config.VARIATIONAL_BASE_URL)throw new Error("VARIATIONAL_BASE_URL is required for protocol capture");
const target=new URL(config.VARIATIONAL_BASE_URL);
const allowedOrigins=new Set([target.origin,...config.VARIATIONAL_DISCOVERY_ALLOWED_ORIGINS.split(",").map((value)=>value.trim()).filter(Boolean).map((value)=>new URL(value).origin)]);

const output=resolve(config.VARIATIONAL_DISCOVERY_OUTPUT);
await mkdir(output,{recursive:true});
const stamp=new Date().toISOString().replace(/[:.]/g,"-");
const capturePath=join(output,`variational-protocol-${stamp}.jsonl`);
await appendFile(capturePath,"",{encoding:"utf8",mode:0o600});
try{await chmod(capturePath,0o600);}catch{}
let writeQueue=Promise.resolve();
function record(event:Record<string,unknown>){writeQueue=writeQueue.then(()=>appendFile(capturePath,`${JSON.stringify(event)}\n`,"utf8"));}

const context=await chromium.launchPersistentContext(resolve(config.VARIATIONAL_PROFILE_PATH),{
  executablePath:await findBrowserExecutable(config.VARIATIONAL_BROWSER_EXECUTABLE),headless:false,viewport:null
});
context.on("request",(request)=>{
  const url=new URL(request.url());if(!allowedOrigins.has(url.origin))return;
  record({at:new Date().toISOString(),kind:"request",method:request.method(),url:discoverySafeUrl(request.url()),resourceType:request.resourceType(),body:discoveryJsonBody(request.postData())});
});
context.on("response",async(response)=>{
  const url=new URL(response.url());if(!allowedOrigins.has(url.origin))return;
  const contentType=response.headers()["content-type"]??"";
  let body:unknown;
  if(contentType.includes("json"))try{body=discoveryJsonBody(await response.text());}catch(error){body={captureError:error instanceof Error?error.message:String(error)};}
  record({at:new Date().toISOString(),kind:"response",method:response.request().method(),url:discoverySafeUrl(response.url()),status:response.status(),contentType,body});
});

const page=context.pages()[0]??await context.newPage();
try{
  await page.goto(config.VARIATIONAL_BASE_URL,{waitUntil:"domcontentloaded"});
}catch(error){
  // Keep the discovery browser alive when the initial navigation is aborted or
  // the remote site temporarily closes the connection. The operator can retry
  // from the address bar without losing the sanitized capture session.
  console.warn(`Initial navigation failed; retry manually in the open browser: ${error instanceof Error?error.message:String(error)}`);
}
console.log(`Variational discovery is recording sanitized same-origin JSON traffic to ${capturePath}`);
console.log("Interact manually in the visible browser. Press Ctrl+C here when the approved capture is complete.");
await new Promise<void>((done)=>{
  const stop=async()=>{await writeQueue;await context.close();done();};
  process.once("SIGINT",stop);process.once("SIGTERM",stop);
});
