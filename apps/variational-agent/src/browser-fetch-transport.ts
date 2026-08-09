import { resolve } from "node:path";
import { chromium,type Browser,type BrowserContext,type Page } from "playwright-core";
import type { AppConfig } from "@huxtrade/config";
import { findBrowserExecutable,launchDetachedBrowser } from "./browser-runtime.js";
import type { OmniTransport } from "./omni-adapter.js";

type FetchResult={ok:boolean;status:number;data:unknown};

/**
 * A 4xx here means Variational parsed and rejected the request outright —
 * by HTTP convention nothing was created server-side, unlike a timeout or
 * 5xx where that's genuinely unknown. Carrying status/path lets callers
 * retry only the unambiguous case without touching the ambiguous one, which
 * still must go through reconciliation rather than a blind resubmit.
 */
export class VariationalRequestError extends Error{
  constructor(public readonly status:number,public readonly path:string,public readonly detail?:string){
    super(`Variational request ${path} failed with HTTP ${status}${detail?`: ${detail}`:""}`);
    this.name="VariationalRequestError";
  }
}

/**
 * Variational's rejection bodies are the only thing that says WHY a 4xx
 * happened, and without them a structurally rejected asset (LIT has failed
 * 5/5, JUP 4/5) is indistinguishable from a transient one — the operator sees
 * "HTTP 422" forever and can neither fix nor rule out the cause. Truncated
 * because this ends up in order_events and business_errors, which are read by
 * humans, not parsed.
 */
/**
 * Venue conditions that reject a submission but clear on their own, so they
 * must not be mistaken for a structurally broken asset.
 *
 * `skew_limit_exceeded` is Variational capping long-OI-minus-short-OI per
 * asset: the trade is refused because the book is lopsided right now, and the
 * platform's own message says to wait or trade the other way. Counting these
 * toward the three-strike structural pause disables an asset — needing a
 * human to clear it — for a market state that resolves itself, and it is
 * direction-specific, so the opposite side may still be perfectly tradeable.
 */
const transientVenueRejections=["skew_limit_exceeded"];
export function isTransientVenueRejection(error:unknown){
  return error instanceof VariationalRequestError
    &&transientVenueRejections.some((code)=>(error.detail??"").includes(code));
}

export function summariseRejection(data:unknown,limit=300):string|undefined{
  if(data===null||data===undefined)return undefined;
  const record=typeof data==="object"&&!Array.isArray(data)?data as Record<string,unknown>:undefined;
  const direct=record?["message","error","detail","reason"].map((key)=>record[key]).find((value)=>typeof value==="string"&&value):undefined;
  const text=typeof direct==="string"?direct:typeof data==="string"?data:JSON.stringify(data);
  if(!text||text==="{}")return undefined;
  return text.length>limit?`${text.slice(0,limit)}…`:text;
}

/**
 * A 4xx from the order-creation call specifically (not quote/leverage calls,
 * and not a 5xx/timeout) means Variational rejected the request outright —
 * nothing was created, so retrying fresh is safe. Every other failure keeps
 * going through the existing UNKNOWN + reconciliation path unchanged: those
 * are genuinely ambiguous about whether an entry was created, and a blind
 * resubmit there could duplicate it.
 */
export function isRetryableEntryRejection(error:unknown){
  return error instanceof VariationalRequestError&&error.path==="/api/orders/new/limit"&&error.status>=400&&error.status<500;
}

// page.evaluate() has no built-in timeout (unlike goto/connectOverCDP-with-
// options) and hangs forever if the CDP session degrades mid-call — observed
// in practice with the CoinGlass agent's equivalent transport after
// repeatedly killing/restarting the attached Chrome process.
function withTimeout<T>(promise:Promise<T>,ms:number,label:string):Promise<T>{
  return new Promise((res,rej)=>{
    const timer=setTimeout(()=>rej(new Error(`${label} timed out after ${ms}ms`)),ms);
    promise.then((value)=>{clearTimeout(timer);res(value);},(error)=>{clearTimeout(timer);rej(error);});
  });
}

const looksLikeCrash=(error:unknown)=>/crash|target closed|session closed/i.test(error instanceof Error?error.message:String(error));
/** True when nothing is listening on the CDP debug port at all (the window crashed/closed) — as opposed to a session that connected but isn't logged in, which a relaunch can't fix. */
export const looksLikeNothingListening=(error:unknown)=>/ECONNREFUSED|ECONNRESET|failed to connect|websocket error/i.test(error instanceof Error?error.message:String(error));

export class BrowserFetchTransport implements OmniTransport{
  private browser?:Browser;
  private context?:BrowserContext;
  private page?:Page;
  private launch?:Promise<void>;
  private ownsContext=false;
  private pageCrashed=false;
  private readonly origin:string;

  constructor(private readonly config:Pick<AppConfig,"VARIATIONAL_BASE_URL"|"VARIATIONAL_PROFILE_PATH"|"VARIATIONAL_BROWSER_EXECUTABLE"|"VARIATIONAL_CDP_URL">){this.origin=new URL(config.VARIATIONAL_BASE_URL).origin;}

  private async connect(){
    if(this.page&&!this.page.isClosed()&&!this.pageCrashed)return;
    if(this.launch)return this.launch;
    this.launch=(async()=>{
      if(!this.context){
        if(this.config.VARIATIONAL_CDP_URL){
          this.browser=await this.connectCdpWithAutoRelaunch();
          this.context=this.browser.contexts()[0];
          if(!this.context)throw new Error("The Chrome CDP endpoint has no browser context");
        }else{
          this.context=await chromium.launchPersistentContext(resolve(this.config.VARIATIONAL_PROFILE_PATH),{
            executablePath:await findBrowserExecutable(this.config.VARIATIONAL_BROWSER_EXECUTABLE),headless:false,viewport:null,timeout:30_000
          });
          this.ownsContext=true;
        }
      }
      const reuse=!this.pageCrashed?this.context.pages().find((page)=>{try{return new URL(page.url()).origin===this.origin;}catch{return false;}})??this.context.pages()[0]:undefined;
      await this.attachPage(reuse??await this.context.newPage());
      let pageOrigin="";try{pageOrigin=new URL(this.page!.url()).origin;}catch{}
      if(pageOrigin!==this.origin)await this.page!.goto(this.config.VARIATIONAL_BASE_URL,{waitUntil:"domcontentloaded",timeout:30_000});
    })();
    try{await this.launch;}finally{this.launch=undefined;}
  }

  /**
   * A CDP-attached Chrome belongs to the operator — this only ever attaches
   * to one, never launches Playwright's own bundled browser for it, because
   * Variational's login flags automation-launched browsers as unsafe (see
   * VARIATIONAL_READONLY_DISCOVERY). But "belongs to the operator" doesn't
   * mean only the operator can restart it: relaunching the exact same real
   * Chrome.app the operator would, pointed at the same persistent profile,
   * is the same action either way — the profile's saved cookies survive the
   * relaunch, so an existing login comes back with it. If the debug port
   * was merely unreachable (window crashed/closed) rather than the session
   * itself being invalid, this alone fixes it with no login step needed.
   */
  private async connectCdpWithAutoRelaunch(){
    try{
      // No default timeout on this call: an unresponsive debug port hangs
      // the whole agent forever with no diagnostic. Fail fast instead.
      return await chromium.connectOverCDP(this.config.VARIATIONAL_CDP_URL,{timeout:15_000});
    }catch(error){
      if(!looksLikeNothingListening(error))throw error;
      const executable=await findBrowserExecutable(this.config.VARIATIONAL_BROWSER_EXECUTABLE);
      const port=new URL(this.config.VARIATIONAL_CDP_URL).port||"9222";
      launchDetachedBrowser(executable,resolve(this.config.VARIATIONAL_PROFILE_PATH),port,this.config.VARIATIONAL_BASE_URL);
      const deadline=Date.now()+30_000;
      let lastError:unknown=error;
      while(Date.now()<deadline){
        await new Promise((resolve)=>setTimeout(resolve,1_000));
        try{return await chromium.connectOverCDP(this.config.VARIATIONAL_CDP_URL,{timeout:5_000});}catch(retryError){lastError=retryError;}
      }
      throw new Error(`Relaunched the Variational Chrome window but it never became reachable on ${this.config.VARIATIONAL_CDP_URL}: ${lastError instanceof Error?lastError.message:String(lastError)}`);
    }
  }

  private async attachPage(page:Page){
    this.page=page;
    this.pageCrashed=false;
    page.on("crash",()=>{this.pageCrashed=true;});
  }

  // A crashed page's context/browser is usually still fine — only the
  // renderer process for that one tab died. Replace just the page and
  // re-navigate rather than tearing down the whole CDP/profile connection.
  private async recreatePage(){
    if(this.page&&!this.page.isClosed())try{await this.page.close();}catch{}
    this.page=undefined;
    await this.connect();
  }

  async request(path:string,init:{method?:"GET"|"POST";body?:unknown}={}){
    if(!path.startsWith("/api/"))throw new Error("Variational browser fetch only permits /api/ paths");
    try{
      return await this.requestOnce(path,init);
    }catch(error){
      if(!this.pageCrashed&&!looksLikeCrash(error))throw error;
      // One retry on a fresh page: a crashed renderer doesn't recover on its
      // own, so without this every subsequent order/reconciliation call
      // would fail until someone notices and restarts the whole process.
      await this.recreatePage();
      return await this.requestOnce(path,init);
    }
  }

  private async requestOnce(path:string,init:{method?:"GET"|"POST";body?:unknown}){
    await this.connect();
    if(!this.page)throw new Error("Variational browser page is unavailable");
    let currentOrigin="";try{currentOrigin=new URL(this.page.url()).origin;}catch{}
    if(currentOrigin!==this.origin)throw new Error("Variational browser is not on the configured origin; login or CAPTCHA may be blocking it");
    const method=init.method??"GET";
    const result=await withTimeout(this.page.evaluate(async({path,method,body}):Promise<FetchResult>=>{
      const response=await fetch(path,{method,credentials:"same-origin",headers:body===undefined?undefined:{"content-type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)});
      const contentType=response.headers.get("content-type")??"";
      let data:unknown=null;
      if(contentType.includes("json"))try{data=await response.json();}catch{}
      return {ok:response.ok,status:response.status,data};
    },{path,method,body:init.body}),20_000,`Variational browser fetch ${path.split("?")[0]}`);
    if(!result.ok)throw new VariationalRequestError(result.status,path.split("?")[0]??path,summariseRejection(result.data));
    return result.data;
  }

  async close(){
    if(this.ownsContext)await this.context?.close();
    // A CDP-attached Chrome belongs to the operator and must remain open.
    this.page=undefined;this.context=undefined;this.browser=undefined;
  }
}
