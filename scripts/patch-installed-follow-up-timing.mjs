// Narrow, fail-closed hotfix for the installed desktop build. Never writes the
// input archive, never touches user data, and preserves all unrelated entries.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import cp from "node:child_process";
import { createRequire } from "node:module";
import { build } from "esbuild";
import ts from "typescript";
const require = createRequire(import.meta.url);
const asar = require("@electron/asar");
const { Pickle } = require("@electron/asar/lib/pickle");
const source = path.resolve(process.argv[2] || "/Applications/NeoWorker.app/Contents/Resources/app.asar");
const output = path.resolve(process.argv[3] || ".novaready/package-output/app.asar.follow-up-timing-v1");
if (source === output || fs.existsSync(output)) throw new Error("Output must be a new, separate archive");
const marker = "NW_FOLLOW_UP_TIMING_V1";
const hash = data => crypto.createHash("sha256").update(data).digest("hex");
function replaceOnce(text, from, to) {
  if (text.indexOf(from) < 0 || text.indexOf(from) !== text.lastIndexOf(from)) throw new Error(`Unrecognized installed code: ${from.slice(0, 100)}`);
  return text.replace(from, () => to);
}
function method(text, name) {
  const ast = ts.createSourceFile("executor.js", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const cls = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "TaskExecutor");
  const found = cls?.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(ast) === name);
  if (!found) throw new Error(`Missing executor method: ${name}`);
  return found.getText(ast);
}
const sourcePath = "src/electron/agent/executor.ts";
const transpile = text => ts.transpileModule(text, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
} }).outputText;
const baseline = transpile(cp.execFileSync("git", ["show", `HEAD:${sourcePath}`], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }));
const updated = transpile(fs.readFileSync(sourcePath, "utf8"));
const patches = new Map();
for (const runtime of ["electron", "daemon", "cli"]) {
  const file = `dist/${runtime}/electron/agent/executor.js`;
  let text = asar.extractFile(source, file).toString();
  if (text.includes(marker)) throw new Error("Already patched");
  for (const name of ["sendMessage"]) {
    const oldMethod = method(text, name);
    if (oldMethod.replace(/\s+/g, "") !== method(baseline, name).replace(/\s+/g, "")) throw new Error(`Installed ${runtime}/${name} differs from baseline; refusing overwrite`);
    text = replaceOnce(text, oldMethod, method(updated, name));
  }
  const oldFailureMessage = method(text, "buildFollowUpFailureMessage");
  const newFailureMessage = replaceOnce(oldFailureMessage,
    "const lower = raw.toLowerCase();",
    'const lower = raw.toLowerCase();\nif (lower.includes("image-capable model/provider")) return "当前模型不支持图片，本轮已结束，对话上下文已保留。请切换支持图片的模型后重新发送。";');
  text = replaceOnce(text, oldFailureMessage, newFailureMessage);
  patches.set(file, Buffer.from(`${text}\n/* ${marker} */\n`));
}
const html = asar.extractFile(source, "dist/renderer/index.html").toString();
const entry = html.match(/src="\.\/(assets\/index-[^\"]+\.js)"/)?.[1];
if (!entry) throw new Error("Missing renderer entry");
const rendererPath = `dist/renderer/${entry}`;
let renderer = asar.extractFile(source, rendererPath).toString();
if (renderer.includes(marker)) throw new Error("Renderer already patched");
// Inject the tested source helper as an isolated bundle, preserving existing
// renderer exports/imports and all previously installed UI changes.
const helper = await build({ stdin: {
  contents: 'export {deriveTaskWorkTiming} from "./src/renderer/utils/task-working-state";',
  resolveDir: process.cwd(),
}, bundle: true, write: false, format: "iife", globalName: "__NWFollowUpTiming" });
renderer = `/* ${marker}_HELPER_BEGIN */\n${helper.outputFiles[0].text}\n/* ${marker}_HELPER_END */\n${renderer}`;
renderer = replaceOnce(renderer,
  "function W6(e,n,o=!1){const[i,r]=x.useState(Date.now());x.useEffect(()=>{if(r(Date.now()),!o||n)return;const d=setInterval(()=>r(Date.now()),1e3);return()=>clearInterval(d)},[e,o,n]);const c=n||(o?i:Date.now());return F6(c-e)}",
  "function W6(startedAt,completedAt,isActive=false){const[now,setNow]=x.useState(Date.now());x.useEffect(()=>{if(!isActive)return;setNow(Date.now());const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer)},[startedAt,isActive,completedAt]);return F6((isActive?now:(completedAt??Date.now()))-startedAt)}");
renderer = replaceOnce(renderer,
  "const et=qe||Dn!==null,Nt=x.useMemo(()=>d4(oe,n?.id),[oe,n?.id]),$e=ko??Nt,Re=n?Dn??$e??n.createdAt:Date.now(),hn=Dn?void 0:Ii(n?.status)?n?.completedAt??n?.updatedAt:n?.completedAt,Gt=W6(Re,hn,!!(n&&et))",
  "const __nwTiming=x.useMemo(()=>__NWFollowUpTiming.deriveTaskWorkTiming(n,oe,xe,Dn),[n,oe,xe,Dn]),et=__nwTiming.isActive,Nt=x.useMemo(()=>d4(oe,n?.id),[oe,n?.id]),$e=ko??Nt,Re=__nwTiming.startedAt,hn=__nwTiming.completedAt,Gt=W6(Re,hn,!!(n&&et))");
renderer = replaceOnce(renderer, 'M==="follow_up_failed"||M==="task_interrupted"', 'M==="follow_up_failed"||M==="follow_up_completed"||M==="task_interrupted"');
patches.set(rendererPath, Buffer.from(renderer));

const raw = asar.getRawHeader(source);
const entries = [];
function collect(node, prefix = "") {
  for (const [name, entry] of Object.entries(node.files || {})) {
    const file = prefix ? `${prefix}/${name}` : name;
    if (entry.files) collect(entry, file);
    else if (!entry.unpacked && entry.offset !== undefined) entries.push({ file, entry, offset: Number(entry.offset), size: entry.size });
  }
}
collect(raw.header);
entries.sort((a, b) => a.offset - b.offset);
let nextOffset = 0;
for (const item of entries) {
  const content = patches.get(item.file);
  item.entry.offset = String(nextOffset);
  if (content) {
    item.entry.size = content.length;
    const blockSize = item.entry.integrity?.blockSize || 4 * 1024 * 1024;
    const blocks = [];
    for (let i = 0; i < content.length; i += blockSize) blocks.push(hash(content.subarray(i, i + blockSize)));
    item.entry.integrity = { algorithm: "SHA256", hash: hash(content), blockSize, blocks };
  }
  nextOffset += item.entry.size;
}
const header = Pickle.createEmpty(); header.writeString(JSON.stringify(raw.header));
const headerBuffer = header.toBuffer();
const size = Pickle.createEmpty(); size.writeUInt32(headerBuffer.length);
fs.mkdirSync(path.dirname(output), { recursive: true });
const inputFd = fs.openSync(source, "r"), outputFd = fs.openSync(output, "wx");
const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
try {
  fs.writeSync(outputFd, size.toBuffer()); fs.writeSync(outputFd, headerBuffer);
  for (const item of entries) {
    const content = patches.get(item.file);
    if (content) { fs.writeSync(outputFd, content); continue; }
    let remaining = item.size, position = raw.headerSize + 8 + item.offset;
    while (remaining) {
      const count = Math.min(buffer.length, remaining);
      if (fs.readSync(inputFd, buffer, 0, count, position) !== count) throw new Error("Short archive read");
      fs.writeSync(outputFd, buffer, 0, count); remaining -= count; position += count;
    }
  }
  fs.fsyncSync(outputFd);
} finally { fs.closeSync(inputFd); fs.closeSync(outputFd); }
for (const [file, content] of patches) {
  if (!asar.extractFile(output, file).equals(content)) throw new Error(`Archive verification failed: ${file}`);
}
console.log(JSON.stringify({ source, output, patchedEntries: [...patches.keys()] }, null, 2));
