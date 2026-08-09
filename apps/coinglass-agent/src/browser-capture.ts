import { resolve } from "node:path";
import { chromium,type Browser,type BrowserContext,type Page } from "playwright-core";
import type { AppConfig } from "@huxtrade/config";
import { buildCoinGlassHeatmapPageUrl,coinGlassHeatmapRanges,normalizeCoinGlassWebHeatmap,parseCoinGlassHeatmapUrl,type CoinGlassHeatmapRange,type CoinGlassWebHeatmapPayload } from "@huxtrade/exchange-clients";
import { findBrowserExecutable } from "./browser-runtime.js";

// CoinGlass encrypts the liqHeatMap response body and rotates the encryption
// version without notice (v0 -> v1 broke the prior reverse-engineered AES
// client). Rather than re-derive their cipher, let the already-authenticated
// page decrypt it for us and read the plaintext straight out of JSON.parse.
const rangeOptionLabel:Record<CoinGlassHeatmapRange,string>={
  "12h":"12 hour","24h":"24 hour","3d":"3 day","7d":"1 week","30d":"1 month"
};

type DecodedHeatmap={liq:unknown[];y:number[]};
type CaptureFlag={__cgCapture?:DecodedHeatmap};

// page.evaluate() has no built-in timeout (unlike goto/click/waitForFunction)
// and hangs forever if the CDP session degrades mid-call — observed in
// practice after repeatedly killing/restarting the attached Chrome process.
function withTimeout<T>(promise:Promise<T>,ms:number,label:string):Promise<T>{
  return new Promise((res,rej)=>{
    const timer=setTimeout(()=>rej(new Error(`${label} timed out after ${ms}ms`)),ms);
    promise.then((value)=>{clearTimeout(timer);res(value);},(error)=>{clearTimeout(timer);rej(error);});
  });
}

const looksLikeCrash=(error:unknown)=>/crash|target closed|session closed/i.test(error instanceof Error?error.message:String(error));

export class CoinGlassBrowserClient{
  private browser?:Browser;
  private context?:BrowserContext;
  private page?:Page;
  private launch?:Promise<void>;
  private ownsContext=false;
  private pageCrashed=false;

  constructor(private readonly config:Pick<AppConfig,"COINGLASS_CDP_URL"|"COINGLASS_PROFILE_PATH"|"COINGLASS_BROWSER_EXECUTABLE">){}

  private async connect(){
    if(this.page&&!this.page.isClosed()&&!this.pageCrashed)return;
    if(this.launch)return this.launch;
    this.launch=(async()=>{
      if(!this.context){
        if(this.config.COINGLASS_CDP_URL){
          // No default timeout on this call: an unresponsive debug port (stale
          // from a killed prior process, browser crash, etc.) hangs the whole
          // agent forever with no diagnostic. Fail fast and let the caller
          // record it as a business error instead.
          this.browser=await chromium.connectOverCDP(this.config.COINGLASS_CDP_URL,{timeout:15_000});
          this.context=this.browser.contexts()[0];
          if(!this.context)throw new Error("The Chrome CDP endpoint has no browser context");
        }else{
          this.context=await chromium.launchPersistentContext(resolve(this.config.COINGLASS_PROFILE_PATH),{
            executablePath:await findBrowserExecutable(this.config.COINGLASS_BROWSER_EXECUTABLE),headless:false,viewport:null,timeout:30_000
          });
          this.ownsContext=true;
        }
      }
      await this.recreatePage();
    })();
    try{await this.launch;}finally{this.launch=undefined;}
  }

  // A crashed page's context/browser is usually still fine — the renderer
  // process for just that tab died (heavy ECharts/WebGL heatmap, rapid
  // back-to-back navigations). Only the page itself needs replacing.
  private async recreatePage(){
    if(this.page&&!this.page.isClosed())try{await this.page.close();}catch{}
    if(!this.context)throw new Error("CoinGlass browser context is unavailable");
    this.page=await this.context.newPage();
    this.pageCrashed=false;
    this.page.on("crash",()=>{this.pageCrashed=true;});
    // Installed before any page script runs, so it survives every
    // navigation and observes CoinGlass's own decrypt call unconditionally.
    await this.page.addInitScript(()=>{
      const target=window as unknown as CaptureFlag;
      target.__cgCapture=undefined;
      const originalParse=JSON.parse;
      JSON.parse=function(text:string,...rest:unknown[]){
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result=(originalParse as any)(text,...rest);
        try{
          if(result&&typeof result==="object"&&Array.isArray(result.liq)&&Array.isArray(result.y))target.__cgCapture=result;
        }catch{}
        return result;
      };
    });
  }

  async capture(sourceUrl:string,range:CoinGlassHeatmapRange){
    if(!(range in coinGlassHeatmapRanges))throw new Error(`Unsupported CoinGlass Heatmap range: ${range}`);
    try{
      return await this.captureOnce(sourceUrl,range);
    }catch(error){
      if(!this.pageCrashed&&!looksLikeCrash(error))throw error;
      // One retry on a fresh page: a crashed renderer doesn't recover on its
      // own, so without this the agent would fail every capture until someone
      // notices and restarts the whole process.
      await this.recreatePage();
      return await this.captureOnce(sourceUrl,range);
    }
  }

  private async captureOnce(sourceUrl:string,range:CoinGlassHeatmapRange){
    const parsed=parseCoinGlassHeatmapUrl(sourceUrl);
    await this.connect();
    if(!this.page)throw new Error("CoinGlass browser page is unavailable");
    const navigationUrl=`https://www.coinglass.com/pro/futures/LiquidationHeatMap?coin=${parsed.coin}&type=pair`;
    await this.page.goto(navigationUrl,{waitUntil:"domcontentloaded",timeout:30_000});
    if(range!=="24h"){
      // The page always loads with 24h selected and does not read a "time"
      // query param, so a non-default range must be picked from the UI.
      const trigger=this.page.getByRole("combobox").filter({hasText:/^(12 hour|24 hour|48 hour|3 day|1 week|2 week|1 month|3 month|6 month|1 Year|2 Year)$/});
      await trigger.first().click({timeout:15_000});
      await withTimeout(this.page.evaluate(()=>{(window as unknown as CaptureFlag).__cgCapture=undefined;}),10_000,"CoinGlass capture-flag reset");
      await this.page.getByRole("option",{name:rangeOptionLabel[range],exact:true}).click({timeout:15_000});
    }
    const capturedAtMs=Date.now();
    await this.page.waitForFunction(()=>(window as unknown as CaptureFlag).__cgCapture!==undefined,null,{timeout:30_000});
    const data=await withTimeout(this.page.evaluate(()=>(window as unknown as CaptureFlag).__cgCapture),10_000,"CoinGlass capture-data read") as DecodedHeatmap;
    const payload:CoinGlassWebHeatmapPayload={code:"0",data:data as NonNullable<CoinGlassWebHeatmapPayload["data"]>};
    const normalized=normalizeCoinGlassWebHeatmap(payload);
    return {...normalized,sourceUrl:buildCoinGlassHeatmapPageUrl(parsed.url,range),capturedAt:new Date(capturedAtMs)};
  }

  async close(){
    if(this.ownsContext)await this.context?.close();
    // A CDP-attached Chrome belongs to the operator and must remain open.
    this.page=undefined;this.context=undefined;this.browser=undefined;
  }
}
