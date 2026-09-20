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
