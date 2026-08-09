import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";

export async function findBrowserExecutable(configured=""){
  const candidates=[
    configured,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    process.env.PROGRAMFILES?join(process.env.PROGRAMFILES,"Microsoft","Edge","Application","msedge.exe"):"",
    process.env["PROGRAMFILES(X86)"]?join(process.env["PROGRAMFILES(X86)"]!,"Microsoft","Edge","Application","msedge.exe"):"",
    process.env.PROGRAMFILES?join(process.env.PROGRAMFILES,"Google","Chrome","Application","chrome.exe"):""
  ].filter(Boolean);
  for(const candidate of candidates)try{await access(candidate,constants.X_OK);return candidate;}catch{}
  throw new Error("No Chrome/Edge/Chromium executable found; set VARIATIONAL_BROWSER_EXECUTABLE");
}

/**
 * Launches the exact same real Chrome window an operator would start by
 * hand — same persistent profile (so an existing login survives), same
 * debug port, pointed at the same URL — detached so it outlives this
 * process and keeps running as the operator's own window, not something
 * Playwright manages or will ever close.
 */
export function launchDetachedBrowser(executablePath:string,profilePath:string,debugPort:string,url:string){
  const child=spawn(executablePath,[`--remote-debugging-port=${debugPort}`,`--user-data-dir=${profilePath}`,url],{detached:true,stdio:"ignore"});
  child.unref();
}
