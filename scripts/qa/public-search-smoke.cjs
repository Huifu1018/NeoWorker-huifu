// Exercise the actual Electron transport, search routing, parser and source
// reader against public sites. Synthetic fixtures cannot certify availability.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");
if (!process.versions.electron) {
  const { spawnSync } = require("node:child_process");
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "neoworker-search-qa-"));
  const env = { ...process.env, NEOWORKER_SEARCH_QA_PROFILE: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    const result = spawnSync(require("electron"), [__filename], { env, stdio: "inherit", timeout: 240_000 });
    if (result.error) console.error(result.error.message);
    process.exitCode = result.status ?? 1;
  } finally { fs.rmSync(profile, { recursive: true, force: true }); }
} else {
  const { app, session } = require("electron");
  const http = require("node:http");
  app.setPath("userData", process.env.NEOWORKER_SEARCH_QA_PROFILE);
  app.disableHardwareAcceleration();
  app.whenReady().then(async () => {
    const { SearchTools } = require("../../dist/electron/electron/agent/tools/search-tools.js");
    const { WebFetchTools } = require("../../dist/electron/electron/agent/tools/web-fetch-tools.js");
    const workspace = { id: "search-qa", path: app.getPath("userData"), name: "Search QA", permissions: {} };
    const daemon = { logEvent() {} };
    const search = new SearchTools(workspace, daemon, "search-qa");
    const reader = new WebFetchTools(workspace, daemon, "search-qa");
    const report = { platform: process.platform, electron: process.versions.electron, at: new Date().toISOString(), cases: [] };
    try {
      for (const [query, topic] of [["北京到杭州高铁时刻表", /高铁|列车|火车|train/i], ["北京到杭州航班时刻表", /航班|机票|flight/i], ["中国天气网 北京天气预报", /天气|weather/i]]) {
        const started = Date.now();
        const result = await search.webSearch({ query, maxResults: 5 });
        const sources = result.results || [];
        assert(sources.length, `No search results: ${query}; ${result.error || ""}`);
        assert(sources.every((r) => topic.test(`${r.title} ${r.snippet}`)), "Unrelated results returned");
        assert(sources.every((r) => !/duckduckgo.com\/y.js|bing.com\/ck\/a/.test(r.url)), "Ad/redirect leaked");
        const reads = [];
        // Test two real sources, not merely a successful search status.
        for (const source of sources.slice(0, 2)) {
          const page = await reader.webFetch({ url: source.url, maxLength: 20000 });
          const usable = page.success && page.contentLength > 300 && topic.test(page.content);
          reads.push({ url: source.url, success: page.success, usable, chars: page.contentLength, error: page.error, requiresBrowser: page.requiresBrowser });
          if (usable) break;
        }
        const entry = { query, ms: Date.now() - started, engine: result.metadata?.fallbackProvider || result.provider, results: sources.map(({ title, url }) => ({ title, url })), reads };
        report.cases.push(entry);
        console.log(JSON.stringify(entry));
        assert(reads.some((r) => r.usable), `No readable source body for ${query}`);
      }
      // Repeat real public search with a stopped proxy: verifies recovery beyond
      // the localhost-only test. Only this disposable profile is changed.
      const proxy = http.createServer();
      await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
      const port = proxy.address().port;
      await new Promise((resolve) => proxy.close(resolve));
      await session.defaultSession.setProxy({ mode: "fixed_servers", proxyRules: `127.0.0.1:${port}` });
      const result = await search.webSearch({ query: "北京到杭州高铁时刻表", maxResults: 3 });
      assert(result.results?.length, `Real public search failed after proxy stopped: ${result.error}`);
      assert.match(await session.defaultSession.resolveProxy("https://www.so.com"), new RegExp(`127.0.0.1:${port}`));
      const recoveredPage = await reader.webFetch({ url: result.results[0].url, maxLength: 20000 });
      assert(recoveredPage.success && recoveredPage.contentLength > 300, `Source fetch failed after proxy stopped: ${recoveredPage.error}`);
      report.brokenProxyRecovery = true;
      report.passed = true;
      console.log("PASS: public search + readable source pages + stopped-proxy recovery. Snippets are not verified live inventory.");
    } catch (error) {
      report.passed = false;
      report.error = error.message;
      console.error(error);
    } finally {
      const output = path.resolve(process.env.NEOWORKER_SEARCH_QA_REPORT || "public-search-smoke.json");
      fs.writeFileSync(output, JSON.stringify(report, null, 2));
      app.exit(report.passed ? 0 : 1);
    }
  }).catch((error) => { console.error(error); app.exit(1); });
}
