import { resolve } from "node:path";
import { chromium,type Browser,type BrowserContext,type Page } from "playwright-core";
import type { AppConfig } from "@huxtrade/config";
import { findBrowserExecutable } from "./browser-runtime.js";
import type { OmniTransport } from "./omni-adapter.js";

type FetchResult={ok:boolean;status:number;data:unknown};

export class BrowserFetchTransport implements OmniTransport{
  private browser?:Browser;
  private context?:BrowserContext;
  private page?:Page;
  private launch?:Promise<void>;
  private ownsContext=false;
  private readonly origin:string;

  constructor(private readonly config:Pick<AppConfig,"VARIATIONAL_BASE_URL"|"VARIATIONAL_PROFILE_PATH"|"VARIATIONAL_BROWSER_EXECUTABLE"|"VARIATIONAL_CDP_URL">){this.origin=new URL(config.VARIATIONAL_BASE_URL).origin;}

  private async connect(){
    if(this.page&&!this.page.isClosed())return;
    if(this.launch)return this.launch;
    this.launch=(async()=>{
      if(this.config.VARIATIONAL_CDP_URL){
        this.browser=await chromium.connectOverCDP(this.config.VARIATIONAL_CDP_URL);
        this.context=this.browser.contexts()[0];
        if(!this.context)throw new Error("The Chrome CDP endpoint has no browser context");
      }else{
        this.context=await chromium.launchPersistentContext(resolve(this.config.VARIATIONAL_PROFILE_PATH),{
          executablePath:await findBrowserExecutable(this.config.VARIATIONAL_BROWSER_EXECUTABLE),headless:false,viewport:null
        });
        this.ownsContext=true;
      }
      this.page=this.context.pages().find((page)=>{try{return new URL(page.url()).origin===this.origin;}catch{return false;}})??this.context.pages()[0]??await this.context.newPage();
      let pageOrigin="";try{pageOrigin=new URL(this.page.url()).origin;}catch{}
      if(pageOrigin!==this.origin)await this.page.goto(this.config.VARIATIONAL_BASE_URL,{waitUntil:"domcontentloaded"});
    })();
    try{await this.launch;}finally{this.launch=undefined;}
  }

  async request(path:string,init:{method?:"GET"|"POST";body?:unknown}={}){
    if(!path.startsWith("/api/"))throw new Error("Variational browser fetch only permits /api/ paths");
    await this.connect();
    if(!this.page)throw new Error("Variational browser page is unavailable");
    let currentOrigin="";try{currentOrigin=new URL(this.page.url()).origin;}catch{}
    if(currentOrigin!==this.origin)throw new Error("Variational browser is not on the configured origin; login or CAPTCHA may be blocking it");
    const method=init.method??"GET";
    const result=await this.page.evaluate(async({path,method,body}):Promise<FetchResult>=>{
      const response=await fetch(path,{method,credentials:"same-origin",headers:body===undefined?undefined:{"content-type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)});
      const contentType=response.headers.get("content-type")??"";
      let data:unknown=null;
      if(contentType.includes("json"))try{data=await response.json();}catch{}
      return {ok:response.ok,status:response.status,data};
    },{path,method,body:init.body});
    if(!result.ok)throw new Error(`Variational request ${path.split("?")[0]} failed with HTTP ${result.status}`);
    return result.data;
  }

  async close(){
    if(this.ownsContext)await this.context?.close();
    // A CDP-attached Chrome belongs to the operator and must remain open.
    this.page=undefined;this.context=undefined;this.browser=undefined;
  }
}
