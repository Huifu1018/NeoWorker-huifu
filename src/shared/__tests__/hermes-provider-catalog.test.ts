import { describe, expect, it } from "vitest";
import { CUSTOM_PROVIDER_CATALOG } from "../llm-provider-catalog";
import { MULTI_LLM_PROVIDER_DISPLAY } from "../types";

describe("Hermes Agent provider", () => {
  it("uses the local OpenAI-compatible Gateway defaults", () => {
    const hermes = CUSTOM_PROVIDER_CATALOG.find((entry) => entry.id === "hermes");
    expect(hermes).toMatchObject({
      name: "Hermes Agent",
      compatibility: "openai",
      baseUrl: "http://127.0.0.1:8642/v1",
      defaultModel: "hermes-agent",
      apiKeyOptional: true,
    });
  });

  it("has a multi-provider display entry", () => {
    expect(MULTI_LLM_PROVIDER_DISPLAY.hermes).toMatchObject({
      name: "Hermes Agent",
    });
  });

  it("keeps the API Server and model-only proxy entries distinct", () => {
    const gateway = CUSTOM_PROVIDER_CATALOG.find((entry) => entry.id === "hermes");
    const proxy = CUSTOM_PROVIDER_CATALOG.find((entry) => entry.id === "hermes-proxy");
    expect(gateway?.description).toMatch(/own agent and tools/i);
    expect(proxy).toMatchObject({
      name: "Hermes Model Proxy",
      baseUrl: "http://127.0.0.1:8645/v1",
      apiKeyOptional: true,
      defaultModel: "",
    });
    expect(proxy?.description).toMatch(/model-only proxy/i);
  });
});
