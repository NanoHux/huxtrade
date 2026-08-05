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
