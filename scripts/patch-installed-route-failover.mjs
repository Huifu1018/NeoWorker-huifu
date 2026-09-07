import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const asar = require("@electron/asar");
const { Pickle } = require("@electron/asar/lib/pickle");

const source = path.resolve(process.argv[2] || "/Applications/NeoWorker.app/Contents/Resources/app.asar");
const output = path.resolve(process.argv[3] || ".novaready/package-output/app.asar.route-failover-v1");
const project = path.resolve(process.cwd());
if (source === output || fs.existsSync(output)) throw new Error("Output must be new and separate");
const hash = data => crypto.createHash("sha256").update(data).digest("hex");
const replacements = new Map([
  ["dist/electron/electron/agent/executor.js", path.join(project, "dist/electron/electron/agent/executor.js")],
  ["dist/daemon/electron/agent/executor.js", path.join(project, "dist/daemon/electron/agent/executor.js")],
  ["dist/cli/electron/agent/executor.js", path.join(project, "dist/cli/electron/agent/executor.js")],
]);
const patches = new Map([...replacements].map(([archivePath, localPath]) => {
  if (!fs.existsSync(localPath)) throw new Error(`Missing compiled replacement: ${localPath}`);
  return [archivePath, fs.readFileSync(localPath)];
}));
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
for (const file of patches.keys()) if (!entries.some(item => item.file === file)) throw new Error(`Archive entry missing: ${file}`);
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
const inputFd = fs.openSync(source, "r");
const outputFd = fs.openSync(output, "wx");
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
for (const [file, content] of patches) if (!asar.extractFile(output, file).equals(content)) throw new Error(`Archive verification failed: ${file}`);
console.log(JSON.stringify({ source, output, patchedEntries: [...patches.keys()] }, null, 2));
