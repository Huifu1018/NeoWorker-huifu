import { describe, expect, it } from "vitest";
import type { LLMSettings } from "../../llm/provider-factory";
import {
  buildHermesProviderBridgeEnvironment,
  resolveHermesProviderBridge,
} from "../hermes-provider-bridge";

function settings(overrides: Partial<LLMSettings> = {}): LLMSettings {
  return {
    providerType: "deepseek",
    modelKey: "deepseek-chat",
    ...overrides,
  };
}

describe("Hermes provider bridge", () => {
  it("passes the selected DeepSeek route explicitly", () => {
    const bridge = resolveHermesProviderBridge(
      settings({
        deepseek: {
          apiKey: "deepseek-secret",
          baseUrl: "https://deepseek.example/v1",
          model: "deepseek-chat",
        },
      }),
      "deepseek",
      "deepseek-chat",
    );

    expect(bridge).toEqual({
      provider: "deepseek",
      model: "deepseek-chat",
      apiMode: "chat_completions",
      baseUrl: "https://deepseek.example/v1",
      apiKey: "deepseek-secret",
    });
  });

  it("prefers an Anthropic subscription token when that auth mode is selected", () => {
    const bridge = resolveHermesProviderBridge(
      settings({
        providerType: "anthropic",
        anthropic: {
          apiKey: "api-key",
          subscriptionToken: "subscription-token",
          authMethod: "subscription",
        },
      }),
      "anthropic",
      "claude-sonnet-4-6",
    );

    expect(bridge.apiKey).toBe("subscription-token");
    expect(bridge.apiMode).toBe("anthropic_messages");
  });

  it("translates Bedrock credentials into the child-process environment", () => {
    const bridge = resolveHermesProviderBridge(
      settings({
        providerType: "bedrock",
        bedrock: {
          region: "ap-southeast-1",
          accessKeyId: "access-key",
          secretAccessKey: "secret-key",
          sessionToken: "session-token",
          model: "anthropic.claude-sonnet-4-6",
        },
      }),
      "bedrock",
      "anthropic.claude-sonnet-4-6",
    );
    const environment = buildHermesProviderBridgeEnvironment(
      bridge,
      "/tmp/neoworker-hermes-runtime",
    );

    expect(environment).toMatchObject({
      HERMES_HOME: "/tmp/neoworker-hermes-runtime",
      NEOWORKER_HERMES_PROVIDER: "bedrock",
      NEOWORKER_HERMES_API_MODE: "bedrock_converse",
      AWS_REGION: "ap-southeast-1",
      AWS_DEFAULT_REGION: "ap-southeast-1",
      AWS_ACCESS_KEY_ID: "access-key",
      AWS_SECRET_ACCESS_KEY: "secret-key",
      AWS_SESSION_TOKEN: "session-token",
    });
    expect(environment.NEOWORKER_HERMES_API_KEY).toBeUndefined();
  });

  it("uses the catalog compatibility for custom providers", () => {
    const bridge = resolveHermesProviderBridge(
      settings({
        providerType: "anthropic-compatible",
        customProviders: {
          "anthropic-compatible": {
            apiKey: "custom-secret",
            baseUrl: "https://gateway.example/anthropic",
            model: "claude-sonnet-4-6",
          },
        },
      }),
      "anthropic-compatible",
      "claude-sonnet-4-6",
    );

    expect(bridge.apiMode).toBe("anthropic_messages");
    expect(bridge.baseUrl).toBe("https://gateway.example/anthropic");
    expect(bridge.apiKey).toBe("custom-secret");
  });

  it("does not silently reinterpret a MoA route", () => {
    expect(() =>
      resolveHermesProviderBridge(
        settings({ providerType: "moa" }),
        "moa",
        "default",
      ),
    ).toThrow("Mixture-of-Agents");
  });

  it("does not route the embedded Harness through an external Hermes service", () => {
    for (const providerType of ["hermes", "hermes-proxy"] as const) {
      expect(() =>
        resolveHermesProviderBridge(
          settings({ providerType }),
          providerType,
          "hermes-agent",
        ),
      ).toThrow("external Hermes Agent/API Server provider");
    }
  });
});
