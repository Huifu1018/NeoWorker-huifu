import { fetchWithSystemProxy, isProxyConnectionFailure } from "../../utils/network-fetch";
import {
  SearchProvider,
  SearchProviderConfig,
  SearchQuery,
  SearchResponse,
  SearchResult,
  SearchType,
} from "./types";
import {
  extractFlightRoute,
  matchesFlightRouteDirection,
} from "./flight-query";


function describeNetworkError(error: Any): string {
  if (isProxyConnectionFailure(error)) return error.message;
  const cause = error?.cause;
  const code = cause?.code || error?.code;
  const detail = cause?.message || error?.message;

  if (code === "UND_ERR_CONNECT_TIMEOUT" || error?.name === "AbortError") {
    return "DuckDuckGo connection timed out. Check your network or proxy settings and try again.";
  }

  return detail
    ? `DuckDuckGo connection failed: ${detail}`
    : "Failed to connect to DuckDuckGo";
}

/**
 * Built-in web search provider (free, no API key required).
 * Scrapes DuckDuckGo HTML and falls back to Bing's public SERP when the DDG
 * route is blocked. Chinese lookups prefer the mainland Bing host; flight
 * results are still checked against the requested route direction.
 */
export class DuckDuckGoProvider implements SearchProvider {
  readonly type = "duckduckgo" as const;
  readonly supportedSearchTypes: SearchType[] = ["web"];

  private baseUrl = "https://html.duckduckgo.com/html/";

  constructor(_config?: SearchProviderConfig) {
    // No API key needed — this is a free provider.
  }

  async search(query: SearchQuery): Promise<SearchResponse> {
    const requestedSearchType = query.searchType || "web";
    const searchType = requestedSearchType;

    if (searchType !== "web") {
      throw new Error(`DuckDuckGo only supports web search, not ${searchType}`);
    }

    const maxResults = Math.min(query.maxResults || 10, 20);

    const text = String(query.query || "");
    const hasChinese = /[\u3400-\u9fff]/u.test(text);
    const preferChinaRoute =
      query.preferChinaRoute === true || query.region === "cn" || query.region === "cn-zh" || hasChinese;

    // Each independent engine gets one bounded attempt. A failed query must
    // never disable a healthy engine for later queries or other tasks.
    const attempts = preferChinaRoute
      ? [() => this.searchBing(query, maxResults, requestedSearchType),
         () => this.search360(query, maxResults),
         () => this.searchDuckDuckGo(query, maxResults)]
      : [() => this.searchDuckDuckGo(query, maxResults),
         () => this.searchBing(query, maxResults, requestedSearchType)];
    const failures: string[] = [];
    for (const attempt of attempts) {
      try {
        const result = await attempt();
        return { ...result, metadata: { ...result.metadata, priorEngineFailures: failures } };
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
    throw new Error(`Search engines did not return usable results: ${failures.join("; ")}. This does not establish that other websites are unreachable.`);
  }

  private async searchDuckDuckGo(query: SearchQuery, maxResults: number): Promise<SearchResponse> {
    const params = new URLSearchParams({
      q: query.query,
    });

    // DuckDuckGo HTML endpoint supports region via 'kl' param
    if (query.region) {
      params.set("kl", this.mapRegion(query.region));
    }

    // Date range via 'df' param
    if (query.dateRange) {
      params.set("df", this.mapDateRange(query.dateRange));
    }

    const controller = new AbortController();
    // Keep the whole free-provider chain below the 30s tool budget: at most
    // 8s Bing, 8s 360 and 10s DDG for mainland-first queries.
    const timeout = setTimeout(() => controller.abort(), 10_000);

    try {
      const requestInit: RequestInit = {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        },
        body: params.toString(),
        signal: controller.signal,
      };

      const response = await fetchWithSystemProxy(this.baseUrl, requestInit, {
        replaySafeSearch: true,
        nodeFallback: true,
      });

      if (!response.ok) {
        throw new Error(`DuckDuckGo request failed: ${response.status}`);
      }

      const html = await response.text();
      const results = this.parseResults(html, 20).filter((result) => this.isRelevant(query, result)).slice(0, maxResults);

      if (results.length === 0) {
        throw new Error("DuckDuckGo returned no results");
      }

      clearTimeout(timeout);

      return {
        results,
        query: query.query,
        searchType: "web",
        provider: "duckduckgo",
      };
    } catch (error: Any) {
      throw new Error(error?.message?.startsWith("DuckDuckGo") ? error.message : describeNetworkError(error));
    } finally {
      clearTimeout(timeout);
    }
  }

  private isRelevant(query: SearchQuery, result: SearchResult): boolean {
    const text = query.query.toLowerCase();
    const fields = `${result.title} ${result.url} ${result.snippet || ""}`.toLowerCase();
    if (/天气|\bweather\b/i.test(text) && !/天气|预报|weather|forecast/i.test(fields)) return false;
    const rail = /高铁|火车|列车|动车|铁路|\btrain|\brail/i.test(text);
    const flight = /航班|机票|航线|起飞|机场|航空|\bflight|\bairfare|\bairline/i.test(text);
    if (rail && !/高铁|火车|列车|动车|铁路|车次|train|rail|gaotie/i.test(fields)) return false;
    if (flight && !/航班|机票|航线|航空|机场|flight|airfare|airline|airport/i.test(fields)) return false;
    const route = (rail || flight) ? extractFlightRoute(text) : null;
    if (route && !matchesFlightRouteDirection(result, route)) return false;
    const tokens: string[] = text.match(/[a-z0-9]{3,}/g) || [];
    for (const run of text.match(/[\u3400-\u9fff]{2,}/g) || []) {
      for (let i = 0; i < run.length - 1; i++) tokens.push(run.slice(i, i + 2));
    }
    return !tokens.length || tokens.some((token) => fields.includes(token));
  }

  private async search360(query: SearchQuery, maxResults: number): Promise<SearchResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await fetchWithSystemProxy(`https://www.so.com/s?${new URLSearchParams({ q: query.query })}`, {
        signal: controller.signal,
        headers: { "User-Agent": "Mozilla/5.0", "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const html = await response.text();
      const results: SearchResult[] = [];
      // Only organic res-title cards. Sponsored g-title cards, AI summaries
      // and opaque tracking redirects are not source documents.
      const cards = html.split(/(?=<h3\b)/i);
      for (const card of cards) {
        if (!/^<h3\b[^>]*class=["'][^"']*\bres-title\b/i.test(card)) continue;
        const heading = card.match(/^<h3\b[^>]*>([\s\S]*?)<\/h3>/i)?.[1];
        const target = heading?.match(/\bdata-mdurl=["']([^"']+)["']/i)?.[1];
        if (!heading || !target) continue;
        const url = this.extractUrl(target);
        const title = this.stripHtml(heading).trim();
        // A bounded excerpt after the title, excluding scripts/style metadata.
        const body = card.slice(card.indexOf("</h3>") + 5).split(/<\/li>/i)[0];
        const snippet = this.stripHtml(body.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")).trim().slice(0, 600);
        const result = { title, url, snippet, source: this.extractHostname(url) };
        if (!url || !title || !this.isRelevant(query, result) || results.some((r) => r.url === url)) continue;
        results.push(result);
        if (results.length >= maxResults) break;
      }
      if (!results.length) throw new Error("no relevant organic results");
      return { results, query: query.query, searchType: "web", provider: "duckduckgo", metadata: { fallbackProvider: "360", fallbackFrom: "duckduckgo" } };
    } catch (error) {
      throw new Error(`360 Search: ${controller.signal.aborted ? "request timed out after 8 seconds" : (error as Error).message}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async searchBing(
    query: SearchQuery,
    maxResults: number,
    requestedSearchType: SearchType,
  ): Promise<SearchResponse> {
    const params = new URLSearchParams({
      q: query.query,
      count: String(maxResults),
    });
    const chinaRoute =
      query.preferChinaRoute === true ||
      query.region === "cn" ||
      query.region === "cn-zh" ||
      /[\u3400-\u9fff]/u.test(String(query.query || ""));
    const results: SearchResult[] = [];
    const hosts = chinaRoute
      ? ["https://cn.bing.com/search"]
      : ["https://www.bing.com/search"];
    const isRelevant = (title: string, url: string, snippet: string) => this.isRelevant(query, { title, url, snippet });
    const failures: string[] = [];
    for (const host of hosts) {
      const controller = new AbortController();
      // Three seconds was shared by system-proxy failure, direct recovery,
      // TLS and the response body, prematurely aborting working slow routes.
      const timeout = setTimeout(() => controller.abort(), 8_000);
      try {
        const response = await fetchWithSystemProxy(`${host}?${params}`, {
          headers: {
            "User-Agent": "Mozilla/5.0",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
          },
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Bing request failed: ${response.status}`);
        const html = await response.text();
        const htmlRegex =
          /<li[^>]+class=["'][^"']*b_algo[^"']*["'][^>]*>[\s\S]*?<h2[^>]*>\s*<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<p[^>]*>([\s\S]*?)<\/p>|<div[^>]+class=["'][^"']*b_caption[^"']*["'][^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>)[\s\S]*?<\/li>/gi;
        let match: RegExpExecArray | null;
        while ((match = htmlRegex.exec(html)) && results.length < maxResults) {
          const title = this.stripHtml(match[2]).trim();
          const url = this.extractUrl(match[1]);
          const snippet = this.stripHtml(match[3] || match[4] || "").trim();
          if (!title || !url || !isRelevant(title, url, snippet)) continue;
          results.push({ title, url, snippet, source: this.extractHostname(url) });
        }
        if (results.length === 0) {
          const rssRegex =
            /<item>[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?<link>([\s\S]*?)<\/link>[\s\S]*?<description>([\s\S]*?)<\/description>[\s\S]*?<\/item>/gi;
          while ((match = rssRegex.exec(html)) && results.length < maxResults) {
            const title = this.stripHtml(match[1]).trim();
            const url = this.extractUrl(match[2]);
            const snippet = this.stripHtml(match[3] || "").trim();
            if (!title || !url || !isRelevant(title, url, snippet)) continue;
            results.push({ title, url, snippet, source: this.extractHostname(url) });
          }
        }
        if (results.length > 0) break;
        failures.push(`${new URL(host).hostname}: no relevant results`);
      } catch (error: Any) {
        failures.push(`${new URL(host).hostname}: ${controller.signal.aborted
          ? "request timed out after 8 seconds" : error?.message || String(error)}`);
      } finally {
        clearTimeout(timeout);
      }
    }
    if (!results.length) {
      throw new Error(failures.join("; ") || "Bing returned no results");
    }
    return {
      results,
      query: query.query,
      searchType: "web",
      provider: "duckduckgo",
      metadata: {
        fallbackProvider: "bing",
        fallbackFrom: "duckduckgo",
        requestedSearchType,
        searchTypeDowngraded: requestedSearchType !== "web",
      },
    };
  }

  async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      const result = await this.search({ query: "天气预报 weather forecast", maxResults: 3 });
      if (result.results.length === 0) {
        return { success: false, error: "No results returned from DuckDuckGo" };
      }
      return { success: true };
    } catch (error: Any) {
      return {
        success: false,
        error: error.message || "Failed to connect to DuckDuckGo",
      };
    }
  }

  /**
   * Parse search results from DuckDuckGo HTML response.
   *
   * The HTML structure uses:
   * - .result__a for the title link (href = redirect URL, text = title)
   * - .result__snippet for the description text
   */
  private parseResults(html: string, maxResults: number): SearchResult[] {
    const results: SearchResult[] = [];

    // Match each result block: class="result__a" for title+url, class="result__snippet" for snippet
    const resultBlockRegex =
      /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

    let match: RegExpExecArray | null;
    while ((match = resultBlockRegex.exec(html)) !== null && results.length < maxResults) {
      const rawUrl = match[1];
      const rawTitle = match[2];
      const rawSnippet = match[3];

      // DDG wraps URLs in a redirect; extract actual URL from uddg= param
      const url = this.extractUrl(rawUrl);
      const title = this.stripHtml(rawTitle).trim();
      const snippet = this.stripHtml(rawSnippet).trim();

      if (url && title) {
        results.push({
          title,
          url,
          snippet,
          source: this.extractHostname(url),
        });
      }
    }

    return results;
  }

  /**
   * Extract the real URL from DuckDuckGo's redirect wrapper.
   * DDG links look like: /l/?uddg=https%3A%2F%2Fexample.com&rut=...
   */
  private extractUrl(rawUrl: string): string {
    try {
      let url = new URL(this.stripHtml(rawUrl), "https://duckduckgo.com");
      if (/(^|\.)duckduckgo\.com$/.test(url.hostname)) {
        const target = url.searchParams.get("uddg");
        if (!target) return ""; // ad click trackers and internal navigation
        url = new URL(target);
      }
      if (/(^|\.)bing\.com$/.test(url.hostname) && url.pathname === "/ck/a") {
        const target = url.searchParams.get("u");
        if (!target?.startsWith("a1")) return "";
        url = new URL(Buffer.from(target.slice(2), "base64url").toString("utf8"));
      }
      return ["https:", "http:"].includes(url.protocol) ? url.href : "";
    } catch {
      return "";
    }
  }

  private stripHtml(html: string): string {
    return html
      .replace(/<b>/g, "")
      .replace(/<\/b>/g, "")
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'")
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ");
  }

  private extractHostname(url: string): string | undefined {
    try {
      return new URL(url).hostname;
    } catch {
      return undefined;
    }
  }

  private mapRegion(region: string): string {
    const regionMap: Record<string, string> = {
      cn: "cn-zh",
      "cn-zh": "cn-zh",
      us: "us-en",
      uk: "uk-en",
      gb: "uk-en",
      de: "de-de",
      fr: "fr-fr",
      es: "es-es",
      it: "it-it",
      jp: "jp-jp",
      br: "br-pt",
    };
    return regionMap[region.toLowerCase()] || `${region.toLowerCase()}-en`;
  }

  private mapDateRange(range: string): string {
    switch (range) {
      case "day":
        return "d";
      case "week":
        return "w";
      case "month":
        return "m";
      case "year":
        return "y";
      default:
        return "w";
    }
  }
}
