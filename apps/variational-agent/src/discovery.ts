import { access,appendFile,chmod,mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { join,resolve } from "node:path";
import { chromium } from "playwright-core";
import { getConfig } from "@huxtrade/config";
import { discoveryJsonBody,discoverySafeUrl } from "./discovery-utils.js";

const config=getConfig();
if(config.VARIATIONAL_ADAPTER_MODE!=="discovery")throw new Error("Set VARIATIONAL_ADAPTER_MODE=discovery before protocol capture");
if(!config.VARIATIONAL_BASE_URL)throw new Error("VARIATIONAL_BASE_URL is required for protocol capture");
const target=new URL(config.VARIATIONAL_BASE_URL);
const allowedOrigins=new Set([target.origin,...config.VARIATIONAL_DISCOVERY_ALLOWED_ORIGINS.split(",").map((value)=>value.trim()).filter(Boolean).map((value)=>new URL(value).origin)]);

async function browserExecutable(){
  const candidates=[
    config.VARIATIONAL_BROWSER_EXECUTABLE,
    process.env.PROGRAMFILES?join(process.env.PROGRAMFILES,"Microsoft","Edge","Application","msedge.exe"):"",
    process.env["PROGRAMFILES(X86)"]?join(process.env["PROGRAMFILES(X86)"]!,"Microsoft","Edge","Application","msedge.exe"):"",
    process.env.PROGRAMFILES?join(process.env.PROGRAMFILES,"Google","Chrome","Application","chrome.exe"):""
  ].filter(Boolean);
  for(const candidate of candidates)try{await access(candidate,constants.X_OK);return candidate;}catch{}
  throw new Error("No Edge/Chrome executable found; set VARIATIONAL_BROWSER_EXECUTABLE");
}

const output=resolve(config.VARIATIONAL_DISCOVERY_OUTPUT);
await mkdir(output,{recursive:true});
const stamp=new Date().toISOString().replace(/[:.]/g,"-");
const capturePath=join(output,`variational-protocol-${stamp}.jsonl`);
await appendFile(capturePath,"",{encoding:"utf8",mode:0o600});
try{await chmod(capturePath,0o600);}catch{}
let writeQueue=Promise.resolve();
function record(event:Record<string,unknown>){writeQueue=writeQueue.then(()=>appendFile(capturePath,`${JSON.stringify(event)}\n`,"utf8"));}

const context=await chromium.launchPersistentContext(resolve(config.VARIATIONAL_PROFILE_PATH),{
  executablePath:await browserExecutable(),headless:false,viewport:null
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
await page.goto(config.VARIATIONAL_BASE_URL,{waitUntil:"domcontentloaded"});
console.log(`Variational discovery is recording sanitized same-origin JSON traffic to ${capturePath}`);
console.log("Interact manually in the visible browser. Press Ctrl+C here when the approved capture is complete.");
await new Promise<void>((done)=>{
  const stop=async()=>{await writeQueue;await context.close();done();};
  process.once("SIGINT",stop);process.once("SIGTERM",stop);
});
