import { afterEach, describe, expect, it, vi } from "vitest";
import { LLMProviderFactory, type LLMSettings } from "../provider-factory";
import { resolveHermesProviderBridge } from "../../runtime/hermes-provider-bridge";
import { buildSavedLLMSettings } from "../../../ipc/llm-settings-save";
import { LLMProviderTypeSchema, LLMSettingsSchema, TaskModelUpdateSchema } from "../../../utils/validation";
import { getCustomProviderCatalog, getCustomProviderDefinition } from "../../../../shared/llm-provider-catalog";

const first = "custom-openai-first";
const second = "custom-openai-second";
const fixture = (): LLMSettings => ({
  providerType: first, modelKey: "same-model",
  openaiCompatible: { displayName: "Existing platform", apiKey: "legacy-key", baseUrl: "https://legacy.example/v1", model: "legacy-model" },
  customProviders: {
    [first]: { displayName: "Platform A", apiKey: "key-a", baseUrl: "https://a.example/v1", model: "same-model" },
    [second]: { displayName: "Platform B", apiKey: "key-b", baseUrl: "https://b.example/v1", model: "same-model" },
  },
  providerModelRegistry: {
    [first]: { models: ["same-model"] },
    [second]: { models: ["same-model"] },
    "openai-compatible": { models: ["legacy-model"] },
  },
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("independent user-defined providers", () => {
  it("lists independent names alongside the unchanged legacy provider", () => {
    vi.spyOn(LLMProviderFactory, "loadSettings").mockReturnValue(fixture());
    const providers = LLMProviderFactory.getAvailableProviders();
    expect(providers).toContainEqual({ type: first, name: "Platform A", configured: true });
    expect(providers).toContainEqual({ type: second, name: "Platform B", configured: true });
    expect(providers).toContainEqual({ type: "openai-compatible", name: "Existing platform", configured: true });
    expect(getCustomProviderCatalog(fixture().customProviders).filter(p => p.id.startsWith("custom-openai-"))).toHaveLength(2);
  });

  it("routes identical model IDs to different endpoints and credentials", async () => {
    vi.spyOn(LLMProviderFactory, "loadSettings").mockReturnValue(fixture());
    const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);
    for (const providerType of [first, second] as const) {
      const provider = LLMProviderFactory.createProvider({ type: providerType });
      await provider.createMessage({ model: "same-model", maxTokens: 10, system: "", messages: [{ role: "user", content: "test" }] });
    }
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const [index, suffix] of ["a", "b"].entries()) {
      const [url, options] = fetch.mock.calls[index];
      expect(String(url)).toBe(`https://${suffix}.example/v1/chat/completions`);
      expect(new Headers(options.headers).get("authorization")).toBe(`Bearer key-${suffix}`);
      expect(JSON.parse(options.body).model).toBe("same-model");
    }
  });

  it("passes independent routes through the task runtime bridge", () => {
    for (const [providerType, suffix] of [[first, "a"], [second, "b"]] as const) {
      expect(resolveHermesProviderBridge(fixture(), providerType, "same-model")).toEqual({
        provider: providerType, model: "same-model", apiMode: "chat_completions",
        baseUrl: `https://${suffix}.example/v1`, apiKey: `key-${suffix}`,
      });
    }
  });

  it("preserves names and independent configs through validated save and reload", () => {
    const original = fixture();
    const parsed = LLMSettingsSchema.parse(original);
    const saved = buildSavedLLMSettings(parsed, original);
    const restored = JSON.parse(JSON.stringify(saved));
    expect(restored.customProviders).toEqual(original.customProviders);
    expect(restored.openaiCompatible).toEqual(original.openaiCompatible);
    expect(LLMProviderFactory.getProviderModelStatus({ ...restored, providerType: second }).currentModel).toBe("same-model");
  });

  it("deleting one provider leaves its sibling and legacy provider intact", () => {
    const original = fixture();
    const next = fixture();
    delete next.customProviders![second];
    delete next.providerModelRegistry![second];
    const saved = buildSavedLLMSettings(LLMSettingsSchema.parse(next), original);
    expect(saved.customProviders?.[second]).toBeUndefined();
    expect(saved.customProviders?.[first]).toEqual(original.customProviders?.[first]);
    expect(saved.openaiCompatible).toEqual(original.openaiCompatible);
  });

  it("accepts instance IDs in task selection and rejects malformed/unknown IDs", () => {
    expect(TaskModelUpdateSchema.parse({ taskId: "11111111-1111-4111-8111-111111111111", providerType: second, modelKey: "same-model" }).providerType).toBe(second);
    for (const id of ["custom-openai-", "custom-openai-../secret", "other-provider", "__proto__", "custom-openai-" + "a".repeat(81), null]) {
      expect(LLMProviderTypeSchema.safeParse(id).success).toBe(false);
    }
    expect(getCustomProviderDefinition("custom-openai-../secret")).toBeUndefined();
    expect(LLMProviderTypeSchema.safeParse("openai-compatible").success).toBe(true);
  });
});
