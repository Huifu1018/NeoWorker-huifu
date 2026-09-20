// Run with Node; re-launches inside real Electron with an isolated profile.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");

if (!process.versions.electron) {
  const { spawnSync } = require("node:child_process");
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "neoworker-proxy-qa-"));
  const env = { ...process.env, NEOWORKER_PROXY_QA_PROFILE: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    const result = spawnSync(require("electron"), [__filename], { env, stdio: "inherit", timeout: 60_000 });
    if (result.error) console.error(result.error.message);
    process.exitCode = result.status ?? 1;
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
  }
} else {
  const { app, session, net } = require("electron");
  const http = require("node:http");
  app.setPath("userData", process.env.NEOWORKER_PROXY_QA_PROFILE);
  app.disableHardwareAcceleration();
  app.whenReady().then(async () => {
    let hits = 0;
    let destinationHits = 0;
    const server = http.createServer((req, res) => {
      hits++;
      if (req.url.startsWith("/redirect/")) {
        res.writeHead(Number(req.url.split("/").pop()), { location: "/destination" }); res.end(); return;
      }
      if (req.url === "/destination") destinationHits++;
      if (req.url === "/slow") return;
      if (req.url === "/empty") { res.writeHead(204); res.end(); return; }
      res.end("reachable");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    // Reserve and close a random port to represent a stopped local proxy.
    const proxy = http.createServer();
    await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const proxyPort = proxy.address().port;
    await new Promise((resolve) => proxy.close(resolve));
    try {
      await session.defaultSession.setProxy({ mode: "fixed_servers", proxyRules: `http=127.0.0.1:${proxyPort}`, proxyBypassRules: "<-loopback>" });
      const url = `http://127.0.0.1:${server.address().port}/`;
      await assert.rejects(net.fetch(url), /ERR_PROXY_CONNECTION_FAILED/);
      const { fetchWithSystemProxy } = require("../../dist/electron/electron/utils/network-fetch.js");
      assert.equal(await (await fetchWithSystemProxy(url, { redirect: "manual" })).text(), "reachable");
      assert.equal(hits, 1);
      assert.match(await session.defaultSession.resolveProxy(url), new RegExp(`127.0.0.1:${proxyPort}`));
      await assert.rejects(fetchWithSystemProxy(url, { method: "POST", body: "do-not-repeat" }), /ERR_PROXY_CONNECTION_FAILED/);
      assert.equal(hits, 1);
      assert.equal(await (await fetchWithSystemProxy(url, { method: "POST", body: "q=test" }, { replaySafeSearch: true })).text(), "reachable");
      assert.equal(hits, 2);
      for (const code of [301, 302, 303, 307, 308]) {
        const redirect = await fetchWithSystemProxy(`${url}redirect/${code}`, { redirect: "manual" });
        assert.equal(redirect.status, code);
        assert.equal(redirect.headers.get("location"), "/destination");
      }
      assert.equal(destinationHits, 0, "manual redirect must not contact an unchecked destination");
      const { WebFetchTools } = require("../../dist/electron/electron/agent/tools/web-fetch-tools.js");
      const reader = new WebFetchTools({ path: app.getPath("userData") }, { logEvent() {} }, "redirect-qa");
      const page = await reader.webFetch({ url: `${url}redirect/302` });
      assert.equal(page.success, true, page.error);
      assert.equal(page.content, "reachable");
      assert.equal(destinationHits, 1);
      assert.equal((await fetchWithSystemProxy(`${url}empty`, { redirect: "manual" })).status, 204);
      assert.equal(await (await fetchWithSystemProxy(url, { method: "HEAD", redirect: "manual" })).text(), "");
      await assert.rejects(fetchWithSystemProxy(`${url}slow`, { redirect: "manual", signal: AbortSignal.timeout(250) }));
      console.log("PASS: real Electron manual redirects, policy-checked source reader, empty responses and cancellation.");
      console.log("PASS: real Electron broken-proxy recovery; original proxy unchanged; write requests not replayed.");
      server.close();
      app.exit(0);
    } catch (error) {
      console.error(error);
      server.close();
      app.exit(1);
    }
  }).catch((error) => { console.error(error); app.exit(1); });
}
