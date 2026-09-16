import { beforeEach, describe, expect, it, vi } from "vitest";
import { SerperProvider } from "../serper-provider";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("SerperProvider", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("maps web search results from Serper", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        organic: [
          {
            title: "DeepSeek report",
            link: "https://example.test/deepseek",
            snippet: "A report about DeepSeek",
            source: "Example",
          },
        ],
        credits: 1,
      }),
    );

    const result = await new SerperProvider({
      type: "serper",
      serperApiKey: "key",
    }).search({ query: "DeepSeek", maxResults: 3 });

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://google.serper.dev/search",
    );
    expect(result.provider).toBe("serper");
    expect(result.results[0]).toMatchObject({
      title: "DeepSeek report",
      url: "https://example.test/deepseek",
      snippet: "A report about DeepSeek",
      source: "Example",
    });
    expect(result.metadata?.credits).toBe(1);
  });

  it("uses the news endpoint for news searches", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        news: [
          {
            title: "Market news",
            link: "https://example.test/news",
            snippet: "News snippet",
            date: "1 hour ago",
            source: "Example News",
          },
        ],
      }),
    );

    const result = await new SerperProvider({
      type: "serper",
      serperApiKey: "key",
    }).search({ query: "market", searchType: "news" });

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://google.serper.dev/news",
    );
    expect(result.results[0]).toMatchObject({
      publishedDate: "1 hour ago",
      source: "Example News",
    });
  });
});
