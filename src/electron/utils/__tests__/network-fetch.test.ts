import { afterEach, describe, expect, it, vi } from "vitest";
import { createNetworkFetch, isProxyConnectionFailure } from "../network-fetch";

const proxyError = () => new Error("net::ERR_PROXY_CONNECTION_FAILED");
const setup = () => {
  const primary = vi.fn().mockRejectedValue(proxyError());
  const direct = vi.fn().mockResolvedValue(new Response("recovered"));
  const directFetch = vi.fn().mockResolvedValue(direct);
  return { primary, direct, directFetch, fetch: createNetworkFetch(() => ({ fetch: primary, directFetch })) };
};

describe("system proxy failure recovery", () => {
  afterEach(() => vi.restoreAllMocks());

  it("uses the system transport when it succeeds", async () => {
    const s = setup();
    s.primary.mockResolvedValue(new Response("proxy works"));
    expect(await (await s.fetch("https://example.com")).text()).toBe("proxy works");
    expect(s.directFetch).not.toHaveBeenCalled();
  });

  it.each(["GET", "HEAD"])("retries %s once with the original URL, headers, abort and redirect policy", async (method) => {
    const s = setup();
    const signal = new AbortController().signal;
    const result = await s.fetch("https://example.com", { method, redirect: "manual", signal, headers: { Accept: "text/html", "Proxy-Authorization": "secret" } });
    expect(await result.text()).toBe("recovered");
    expect(s.primary).toHaveBeenCalledTimes(1);
    expect(s.direct).toHaveBeenCalledTimes(1);
    const [url, init] = s.direct.mock.calls[0];
    expect(url).toBe("https://example.com");
    expect(init).toMatchObject({ method, redirect: "manual", signal, credentials: "omit" });
    expect(init.headers.get("accept")).toBe("text/html");
    expect(init.headers.has("proxy-authorization")).toBe(false);
  });

  it("allows only explicitly replay-safe search POSTs", async () => {
    const s = setup();
    await s.fetch("https://example.com/search", { method: "POST", body: "q=test" }, { replaySafeSearch: true });
    expect(s.direct.mock.calls[0][1].body).toBe("q=test");
  });

  it.each(["POST", "PUT", "DELETE", "PATCH"])("does not replay a %s action", async (method) => {
    const s = setup();
    await expect(s.fetch("https://example.com", { method, body: "data" })).rejects.toThrow("ERR_PROXY_CONNECTION_FAILED");
    expect(s.directFetch).not.toHaveBeenCalled();
  });

  it.each(["ERR_CERT_AUTHORITY_INVALID", "ERR_TUNNEL_CONNECTION_FAILED", "ERR_PROXY_AUTH_REQUESTED", "ERR_MANDATORY_PROXY_CONFIGURATION_FAILED", "ERR_PAC_SCRIPT_FAILED", "ERR_CONNECTION_TIMED_OUT"])("does not switch to direct for %s", async (code) => {
    const s = setup();
    s.primary.mockRejectedValue(new Error(code));
    await expect(s.fetch("https://example.com")).rejects.toThrow(code);
    expect(s.directFetch).not.toHaveBeenCalled();
  });

  it("does not retry HTTP proxy authentication or access denials", async () => {
    const s = setup();
    s.primary.mockResolvedValue(new Response("auth required", { status: 407 }));
    expect((await s.fetch("https://example.com")).status).toBe(407);
    expect(s.directFetch).not.toHaveBeenCalled();
  });

  it("honors cancellation before fallback", async () => {
    const s = setup();
    const controller = new AbortController();
    s.primary.mockImplementation(async () => { controller.abort(); throw proxyError(); });
    await expect(s.fetch("https://example.com", { signal: controller.signal })).rejects.toThrow();
    expect(s.directFetch).not.toHaveBeenCalled();
  });

  it("honors cancellation while the direct session initializes", async () => {
    const s = setup();
    const controller = new AbortController();
    s.directFetch.mockImplementation(async () => { controller.abort(); return s.direct; });
    await expect(s.fetch("https://example.com", { signal: controller.signal })).rejects.toThrow();
    expect(s.direct).not.toHaveBeenCalled();
  });

  it("reports both failed routes without looping", async () => {
    const s = setup();
    s.direct.mockRejectedValue(new Error("net::ERR_NAME_NOT_RESOLVED"));
    await expect(s.fetch("https://example.com")).rejects.toThrow("直连重试也失败");
    expect(s.primary).toHaveBeenCalledTimes(1);
    expect(s.direct).toHaveBeenCalledTimes(1);
  });

  it("works outside Electron", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("node"));
    expect(await (await createNetworkFetch(() => null)("https://example.com")).text()).toBe("node");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("recognizes the nested Chromium error", () => {
    expect(isProxyConnectionFailure(new Error("fetch failed", { cause: { code: "ERR_PROXY_CONNECTION_FAILED" } }))).toBe(true);
  });
});
