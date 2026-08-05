import { chmod,mkdir,readFile,writeFile } from "node:fs/promises";
import { basename,dirname,resolve } from "node:path";
import { sanitizeHar } from "./har-discovery-utils.js";

const args=process.argv.slice(2).filter(value=>value!=="--");
const inputArg=args[0];
if(!inputArg)throw new Error("Usage: pnpm discover:har -- /absolute/path/to/sanitized.har [output.jsonl]");
const inputPath=resolve(inputArg);
const outputPath=resolve(args[1]??`${inputPath.replace(/\.har$/i,"")}-variational-sanitized.jsonl`);
const allowedOrigins=new Set([
  "https://omni.variational.io",
  ...(process.env.VARIATIONAL_DISCOVERY_ALLOWED_ORIGINS??"").split(",").map(value=>value.trim()).filter(Boolean).map(value=>new URL(value).origin)
]);

const parsed:unknown=JSON.parse(await readFile(inputPath,"utf8"));
const events=sanitizeHar(parsed,allowedOrigins);
await mkdir(dirname(outputPath),{recursive:true});
await writeFile(outputPath,events.map(event=>JSON.stringify(event)).join("\n")+(events.length?"\n":""),{encoding:"utf8",mode:0o600});
try{await chmod(outputPath,0o600);}catch{}
console.log(`Wrote ${events.length} sanitized Variational API events to ${basename(outputPath)}`);
console.log("The source HAR may still contain browser data. Keep it private and remove it manually after verifying the sanitized output.");
