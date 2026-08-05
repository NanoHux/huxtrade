import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if(process.platform!=="darwin")throw new Error("This command only supports macOS launchd");

const action=process.argv[2]??"status";
const label="io.huxtrade.variational-agent";
const projectRoot=resolve(dirname(fileURLToPath(import.meta.url)),"../..");
const launchAgents=join(homedir(),"Library/LaunchAgents");
const logDirectory=join(homedir(),"Library/Logs/HuxTrade");
const plistPath=join(launchAgents,`${label}.plist`);
const domain=`gui/${process.getuid()}`;
const service=`${domain}/${label}`;
const xml=(value)=>String(value).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;");
const shell=(value)=>`'${String(value).replaceAll("'",`'\\''`)}'`;
const command=`cd ${shell(projectRoot)} && exec corepack pnpm --filter @huxtrade/variational-agent start`;
const plist=`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array><string>/bin/zsh</string><string>-lc</string><string>${xml(command)}</string></array>
  <key>WorkingDirectory</key><string>${xml(projectRoot)}</string>
  <key>EnvironmentVariables</key><dict>
    <key>ENV_FILE_OVERRIDE</key><string>false</string>
    <key>DATABASE_URL</key><string>postgres://huxtrade:huxtrade@127.0.0.1:5432/huxtrade</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(join(logDirectory,"variational-agent.out.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(join(logDirectory,"variational-agent.err.log"))}</string>
</dict></plist>
`;

function launchctl(args,{ignoreFailure=false}={}){
  try{return execFileSync("/bin/launchctl",args,{encoding:"utf8",stdio:ignoreFailure?"ignore":"pipe"});}
  catch(error){if(ignoreFailure)return "";throw error;}
}

async function assertSafeInstallConfig(){
  const env=await readFile(join(projectRoot,".env"),"utf8");
  const setting=(key)=>{
    const raw=env.match(new RegExp(`^${key}=(.*)$`,"m"))?.[1]?.trim()??"";
    if(raw.startsWith('"'))try{return JSON.parse(raw);}catch{}
    return raw;
  };
  const cdp=setting("VARIATIONAL_CDP_URL");
  if(setting("VARIATIONAL_ADAPTER_MODE")!=="browser-fetch")throw new Error("Set VARIATIONAL_ADAPTER_MODE=browser-fetch before installing launchd");
  if(!setting("VARIATIONAL_BASE_URL"))throw new Error("Set VARIATIONAL_BASE_URL before installing launchd");
  if(!/^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(cdp))throw new Error("Set VARIATIONAL_CDP_URL to a loopback Chrome debugging port before installing launchd");
  if(setting("LIVE_TRADING_ENABLED")!=="false")throw new Error("Install and verify launchd in read-only mode with LIVE_TRADING_ENABLED=false first");
}

if(action==="install"){
  await assertSafeInstallConfig();
  await mkdir(launchAgents,{recursive:true});await mkdir(logDirectory,{recursive:true});
  await writeFile(plistPath,plist,{encoding:"utf8",mode:0o600});await chmod(plistPath,0o600);
  launchctl(["bootout",service],{ignoreFailure:true});
  launchctl(["bootstrap",domain,plistPath]);launchctl(["enable",service]);launchctl(["kickstart","-k",service]);
  console.log(`Installed and started ${label}: ${plistPath}`);
}else if(action==="uninstall"){
  launchctl(["bootout",service],{ignoreFailure:true});await rm(plistPath,{force:true});
  console.log(`Uninstalled ${label}`);
}else if(action==="status"){
  process.stdout.write(launchctl(["print",service]));
}else if(action==="render"){
  process.stdout.write(plist);
}else throw new Error("Usage: variational-launchagent.mjs install|status|uninstall|render");
