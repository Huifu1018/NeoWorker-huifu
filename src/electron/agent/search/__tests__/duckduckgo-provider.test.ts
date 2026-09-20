import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DuckDuckGoProvider } from "../duckduckgo-provider";

function response(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

const bingRss = `<?xml version="1.0"?>
<rss><channel><item>
  <title>北京天气 - 中国天气网</title>
  <link>https://weather.example.test/beijing</link>
  <description>北京天气预报与出行建议</description>
</item></channel></rss>`;

const bingFlightRss = `<?xml version="1.0"?>
<rss><channel><item>
  <title>杭州到西安航班时刻 - 航班查询</title>
  <link>https://flight.example.test/hgh-xiy</link>
  <description>杭州到西安航班与航班时刻查询</description>
</item></channel></rss>`;

describe("DuckDuckGoProvider transport fallback", () => {
  afterEach(() => { vi.useRealTimers(); });
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("allows a recovering mainland request to finish after the former three-second limit", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => new Promise((resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      setTimeout(() => resolve(response(bingFlightRss)), 4500);
    }));
    const pending = new DuckDuckGoProvider().search({ query: "杭州到西安航班" });
    await vi.advanceTimersByTimeAsync(4500);
    const result = await pending;
    expect(result.results).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses the mainland Bing route first for Chinese non-flight searches", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(response(bingRss));

    const result = await new DuckDuckGoProvider().search({
      query: "北京天气",
      maxResults: 3,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      "https://cn.bing.com/search",
    );
    expect(result.results).toHaveLength(1);
    expect(result.metadata).toMatchObject({
      fallbackProvider: "bing",
      fallbackFrom: "duckduckgo",
    });
  });

  it("uses mainland Bing for Chinese flight queries and filters reversed routes", async () => {
    const html = bingFlightRss.replace("</channel>", `<item><title>西安到杭州航班</title><link>https://flight.example.test/xiy-hgh</link><description>西安到杭州航班查询</description></item></channel>`);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(response(html));

    const result = await new DuckDuckGoProvider().search({
      query: "杭州到西安航班",
      maxResults: 3,
      preferFlight: true,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      "cn.bing.com/search",
    );
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      title: "杭州到西安航班时刻 - 航班查询",
    });
  });

  it("falls back to Bing when DuckDuckGo is blocked", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("connect timeout"))
      .mockResolvedValueOnce(response(bingFlightRss.replace("杭州到西安航班时刻 - 航班查询", "HGH to XIY flights")));

    const result = await new DuckDuckGoProvider().search({
      query: "HGH to XIY flights",
      maxResults: 3,
      preferFlight: true,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      "html.duckduckgo.com",
    );
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(
      "www.bing.com/search",
    );
    expect(result.results).toHaveLength(1);
    expect(result.metadata?.fallbackProvider).toBe("bing");
  });
});

const organicDdg = (title = "Weather forecast") => `<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fweather.example.test%2Fforecast&amp;rut=1">${title}</a><a class="result__snippet">Weather forecast for tomorrow</a>`;

describe("public search result quality and recovery", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it("does not disable DDG across subsequent queries after one failed request", async () => {
    const fetch = vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce(response(bingRss.replaceAll("北京天气", "Weather")))
      .mockResolvedValueOnce(response(organicDdg()));
    const provider = new DuckDuckGoProvider();
    await provider.search({ query: "Weather" });
    const second = await provider.search({ query: "Weather tomorrow" });
    expect(fetch.mock.calls[2][0]).toContain("duckduckgo");
    expect(second.results[0].url).toBe("https://weather.example.test/forecast");
  });

  it("rejects city introductions and uses independent mainland organic sources", async () => {
    const bing = `<li class="b_algo"><h2><a href="https://example.test/beijing">北京市简介</a></h2><p>北京是中国首都</p></li>`;
    // Structure captured from an actual 360 SERP: title wrappers, tracking
    // href, explicit source data-mdurl, organic vs promoted heading classes.
    const mainland = `<h3 class="g-title"><a data-mdurl="https://ads.example.test">北京到杭州高铁广告</a></h3>
      <h3 class="res-title"><a href="https://www.so.com/link?m=opaque" data-mdurl="https://trains.example.test/route?a=1&amp;b=2"><em>北京到杭州高铁</em>时刻表</a></h3><p>北京到杭州列车查询</p></li>
      <h3 class="res-title"><a href="https://ai.so.com/search/answer">北京到杭州高铁</a></h3>`;
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(response(bing)).mockResolvedValueOnce(response(mainland));
    const result = await new DuckDuckGoProvider().search({ query: "北京到杭州高铁" });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result.metadata?.fallbackProvider).toBe("360");
    expect(result.results).toHaveLength(1);
    expect(result.results[0].url).toBe("https://trains.example.test/route?a=1&b=2");
    expect(result.metadata?.priorEngineFailures).toHaveLength(1);
  });

  it("removes DDG ad trackers and unsafe URLs before applying the result limit", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response(
      `<a class="result__a" href="https://duckduckgo.com/y.js?ad_domain=ads.test">Weather advert</a><a class="result__snippet">Weather</a>` +
      `<a class="result__a" href="javascript:alert(1)">Weather link</a><a class="result__snippet">Weather</a>` + organicDdg(),
    ));
    const result = await new DuckDuckGoProvider().search({ query: "Weather", maxResults: 1 });
    expect(result.results).toHaveLength(1);
    expect(result.results[0].url).toBe("https://weather.example.test/forecast");
  });

  it("does not confuse a financial forecast with a weather request", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response('<a class="result__a" href="https://investor.example.test/nvidia">NVIDIA revenue outlook</a><a class="result__snippet">Quarterly revenue guidance</a>'));
    const result = await new DuckDuckGoProvider().search({ query: "NVIDIA revenue forecast" });
    expect(result.results[0].url).toBe("https://investor.example.test/nvidia");
  });

  it("decodes Bing source redirects instead of returning search tracking URLs", async () => {
    const target = "https://weather.example.test/beijing";
    const link = `https://www.bing.com/ck/a?!&amp;u=a1${Buffer.from(target).toString("base64url")}`;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response(`<li class="b_algo"><h2><a href="${link}">北京天气</a></h2><p>北京天气预报</p></li>`));
    const result = await new DuckDuckGoProvider().search({ query: "北京天气" });
    expect(result.results[0].url).toBe(target);
  });

  it("stops three failing engines inside the tool budget without background retries", async () => {
    vi.useFakeTimers();
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const assertion = expect(new DuckDuckGoProvider().search({ query: "北京到杭州高铁" })).rejects.toThrow("does not establish");
    await vi.advanceTimersByTimeAsync(26_000);
    await assertion;
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });
});
