import {
  SearchProvider,
  SearchProviderConfig,
  SearchQuery,
  SearchResponse,
  SearchResult,
  SearchType,
} from "./types";

/**
 * Serper.dev provider - Google Search API with web, news, and image results.
 * https://serper.dev/
 */
export class SerperProvider implements SearchProvider {
  readonly type = "serper" as const;
  readonly supportedSearchTypes: SearchType[] = ["web", "news", "images"];

  private apiKey: string;
  private baseUrl = "https://google.serper.dev";

  constructor(config: SearchProviderConfig) {
    const apiKey = config.serperApiKey;
    if (!apiKey) {
      throw new Error(
        "Serper API key is required. Configure it in Settings or get one from https://serper.dev/",
      );
    }
    this.apiKey = apiKey;
  }

  async search(query: SearchQuery): Promise<SearchResponse> {
    const searchType = query.searchType || "web";

    if (!this.supportedSearchTypes.includes(searchType)) {
      throw new Error(`Serper does not support ${searchType} search`);
    }

    const response = await fetch(`${this.baseUrl}/${this.getEndpoint(searchType)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": this.apiKey,
      },
      body: JSON.stringify({
        q: query.query,
        num: query.maxResults || 10,
        ...(query.region && { gl: query.region }),
        ...(query.language && { hl: query.language }),
        ...(query.dateRange && { tbs: this.mapDateRange(query.dateRange) }),
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Serper API error: ${response.status} - ${error}`);
    }

    const data = (await response.json()) as {
      organic?: Any[];
      news?: Any[];
      images?: Any[];
      searchParameters?: { q?: string };
      credits?: number;
    };

    return {
      results: this.mapResults(data, searchType),
      query: query.query,
      searchType,
      provider: "serper",
      metadata: {
        credits: data.credits,
      },
    };
  }

  async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      await this.search({ query: "test", maxResults: 1 });
      return { success: true };
    } catch (error: Any) {
      return {
        success: false,
        error: error.message || "Failed to connect to Serper",
      };
    }
  }

  private getEndpoint(searchType: SearchType): string {
    switch (searchType) {
      case "news":
        return "news";
      case "images":
        return "images";
      default:
        return "search";
    }
  }

  private mapDateRange(range: string): string {
    switch (range) {
      case "day":
        return "qdr:d";
      case "week":
        return "qdr:w";
      case "month":
        return "qdr:m";
      case "year":
        return "qdr:y";
      default:
        return "qdr:w";
    }
  }

  private mapResults(data: Any, searchType: SearchType): SearchResult[] {
    if (searchType === "images") {
      return (data.images || []).map((r: Any) => ({
        title: r.title || "",
        url: r.link || r.imageUrl || "",
        snippet: r.snippet || r.source || "",
        thumbnailUrl: r.thumbnailUrl,
        imageUrl: r.imageUrl,
        width: r.imageWidth,
        height: r.imageHeight,
        source: r.source,
      }));
    }

    if (searchType === "news") {
      return (data.news || []).map((r: Any) => ({
        title: r.title || "",
        url: r.link || "",
        snippet: r.snippet || "",
        publishedDate: r.date,
        source: r.source,
      }));
    }

    return (data.organic || []).map((r: Any) => ({
      title: r.title || "",
      url: r.link || "",
      snippet: r.snippet || "",
      publishedDate: r.date,
      source: r.source,
    }));
  }
}
