type Fetch = typeof globalThis.fetch;

export interface NetworkTransport {
  fetch: Fetch;
  directFetch: () => Promise<Fetch>;
}

let directFetchPromise: Promise<Fetch> | undefined;

function electronTransport(): NetworkTransport | null {
  try {
    const electron = require("electron") as typeof import("electron");
    if (typeof electron.net?.fetch !== "function") return null;
    return {
      fetch: electron.net.fetch.bind(electron.net) as Fetch,
      directFetch: () => {
        // Never change the default session or the user's OS proxy settings.
        // A non-persistent session avoids sharing browser cookies or proxy auth.
        directFetchPromise ??= (async () => {
          const session = electron.session.fromPartition("neoworker-public-web-direct", { cache: false });
          await session.setProxy({ mode: "direct" });
          return session.fetch.bind(session) as Fetch;
        })().catch((error) => {
          directFetchPromise = undefined;
          throw error;
        });
        return directFetchPromise;
      },
    };
  } catch {
    return null;
  }
}

export function isProxyConnectionFailure(error: unknown): boolean {
  const value = error as { message?: string; code?: string; cause?: { message?: string; code?: string } };
  // Authentication, certificates, HTTP denials, PAC policy and general
  // timeouts must not silently trigger a different route.
  return /\bERR_PROXY_CONNECTION_FAILED\b/.test(
    [value?.code, value?.message, value?.cause?.code, value?.cause?.message].join(" "),
  );
}

export function createNetworkFetch(getTransport: () => NetworkTransport | null = electronTransport) {
  return async (
    url: string,
    init: RequestInit = {},
    options: { replaySafeSearch?: boolean; nodeFallback?: boolean } = {},
  ): Promise<Response> => {
    const transport = getTransport();
    if (!transport) return globalThis.fetch(url, init);
    try {
      return await transport.fetch(url, init);
    } catch (error) {
      if (init.signal?.aborted) throw error;
      const method = String(init.method || "GET").toUpperCase();
      const replaySafe = method === "GET" || method === "HEAD" ||
        (method === "POST" && options.replaySafeSearch && typeof init.body === "string");
      if (!replaySafe) throw error;
      if (isProxyConnectionFailure(error)) {
        try {
          const directFetch = await transport.directFetch();
          init.signal?.throwIfAborted();
          const headers = new Headers(init.headers);
          headers.delete("proxy-authorization");
          headers.delete("proxy-connection");
          return await directFetch(url, { ...init, headers, credentials: "omit" });
        } catch (directError) {
          if (init.signal?.aborted) throw directError;
          throw new Error(
            `系统代理连接失败（ERR_PROXY_CONNECTION_FAILED），直连重试也失败。请检查系统代理设置及代理软件是否运行。直连错误：${(directError as Error)?.message || "连接失败"}`,
            { cause: directError },
          );
        }
      }
      // Preserve the existing DDG Node fallback for non-proxy transport errors.
      // Do not retry certificate, authentication or server-policy failures.
      if (options.nodeFallback && !/ERR_CERT_|ERR_SSL_|ERR_PROXY_AUTH|ERR_TUNNEL_|ERR_MANDATORY_PROXY|ERR_PAC_/i.test(String((error as Error)?.message))) {
        return globalThis.fetch(url, init);
      }
      throw error;
    }
  };
}

export const fetchWithSystemProxy = createNetworkFetch();
