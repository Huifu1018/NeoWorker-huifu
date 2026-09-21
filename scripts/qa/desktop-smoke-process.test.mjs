import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const helperUrl = new URL("../desktop-smoke-process.mjs", import.meta.url).href;

test("smoke runner exits when an orphan helper ignores SIGTERM and holds its pipes", {
  skip: process.platform === "win32",
}, async () => {
  const grandchild = `process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000);`;
  const parent = `
    require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], {stdio: 'inherit'});
    setInterval(() => {}, 1000);
  `;
  const driver = `
    import { spawn } from 'node:child_process';
    import { stopSmokeProcessGroup } from ${JSON.stringify(helperUrl)};
    const probe = spawn(process.execPath, ['-e', ${JSON.stringify(parent)}], {detached:true, stdio:['ignore','pipe','pipe']});
    await new Promise((resolve, reject) => {
      probe.once('error', reject);
      probe.stdout.once('data', resolve);
    });
    await stopSmokeProcessGroup(probe, 100);
    console.log('cleaned');
  `;
  const result = await execFileAsync(process.execPath, ["--input-type=module", "-e", driver], {
    timeout: 5_000,
  });
  assert.match(result.stdout, /cleaned/);
});

test("cleanup also accepts a smoke process that has already exited", {
  skip: process.platform === "win32",
}, async () => {
  const driver = `
    import { spawn } from 'node:child_process';
    import { stopSmokeProcessGroup } from ${JSON.stringify(helperUrl)};
    const probe = spawn(process.execPath, ['-e', ''], {detached:true, stdio:['ignore','pipe','pipe']});
    await new Promise((resolve, reject) => {
      probe.once('error', reject);
      probe.once('close', resolve);
    });
    await stopSmokeProcessGroup(probe, 100);
    console.log('cleaned');
  `;
  const result = await execFileAsync(process.execPath, ["--input-type=module", "-e", driver], {
    timeout: 5_000,
  });
  assert.match(result.stdout, /cleaned/);
});
