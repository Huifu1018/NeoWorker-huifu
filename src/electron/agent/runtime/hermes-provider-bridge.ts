import type { LLMProviderType } from "../../../shared/types";
import { CUSTOM_PROVIDER_MAP } from "../../../shared/llm-provider-catalog";
import type { LLMSettings } from "../llm/provider-factory";

export type HermesAcpApiMode =
  | "chat_completions"
  | "codex_responses"
  | "anthropic_messages"
  | "bedrock_converse";

export interface HermesProviderBridgeConfig {
  provider: string;
  model: string;
  apiMode: HermesAcpApiMode;
  baseUrl?: string;
  apiKey?: string;
  environment?: Record<string, string>;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    const candidate = text(value);
    if (candidate) return candidate;
  }
  return "";
}

function resolveAnthropicCredential(settings: LLMSettings): string {
  const anthropic = settings.anthropic;
  if (!anthropic) return "";
  const apiKey = text(anthropic.apiKey);
  const subscriptionToken = text(anthropic.subscriptionToken);
  if (anthropic.authMethod === "subscription") {
    return subscriptionToken || apiKey;
  }
  if (anthropic.authMethod === "api_key") {
    return apiKey || subscriptionToken;
  }
  return subscriptionToken || apiKey;
}

function normalizeKimiCodingProvider(providerType: LLMProviderType): LLMProviderType {
  return providerType === "kimi-coding" ? "kimi-code" : providerType;
}

function normalizeAzureAnthropicEndpoint(endpoint: string): string {
  const trimmed = endpoint.replace(/\/+$/, "");
  if (
    trimmed &&
    !/\/anthropic(?:\/|$)/i.test(trimmed) &&
    /\.openai\.azure\.com$/i.test(trimmed)
  ) {
    return `${trimmed}/anthropic`;
  }
  return trimmed;
}

function modelUsesOpenAIResponses(model: string): boolean {
  return /^gpt-5(?:[.-]|$)/i.test(model.trim());
}

function defaultBedrockBaseUrl(region: string): string {
  return `https://bedrock-runtime.${region}.amazonaws.com`;
}

function defaultOpenAIBaseUrl(): string {
  return "https://api.openai.com/v1";
}

function defaultGeminiBaseUrl(): string {
  return "https://generativelanguage.googleapis.com/v1beta";
}

function ensureOllamaOpenAIBaseUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  if (!normalized) return "http://localhost:11434/v1";
  if (/\/v\d+(?:[a-z]+\d*)?$/i.test(normalized)) return normalized;
  return `${normalized}/v1`;
}

function buildAzureOpenAIBaseUrl(
  settings: LLMSettings,
  model: string,
): HermesProviderBridgeConfig {
  const azure = settings.azure;
  const endpoint = text(azure?.endpoint).replace(/\/+$/, "");
  const deployment = firstText(azure?.deployment, azure?.deployments?.[0], model);
  const apiVersion = firstText(azure?.apiVersion, "2024-12-01-preview");
  if (!endpoint || !deployment) {
    throw new Error(
      "Hermes Harness cannot use Azure OpenAI until its endpoint and deployment are configured.",
    );
  }
  return {
    provider: "azure",
    model,
    apiMode: "chat_completions",
    baseUrl:
      `${endpoint}/openai/deployments/${encodeURIComponent(deployment)}` +
      `?api-version=${encodeURIComponent(apiVersion)}`,
    apiKey: text(azure?.apiKey),
  };
}

function buildPiProviderBridge(
  settings: LLMSettings,
  model: string,
): HermesProviderBridgeConfig {
  const provider = text(settings.pi?.provider).toLowerCase() || "anthropic";
  const apiKey = text(settings.pi?.apiKey);

  if (provider === "anthropic") {
    return {
      provider,
      model,
      apiMode: "anthropic_messages",
      baseUrl: "https://api.anthropic.com",
      apiKey,
    };
  }
  if (provider === "google" || provider === "gemini") {
    return {
      provider: "gemini",
      model,
      apiMode: "chat_completions",
      baseUrl: defaultGeminiBaseUrl(),
      apiKey,
    };
  }
  if (provider === "openai") {
    return {
      provider,
      model,
      apiMode: modelUsesOpenAIResponses(model)
        ? "codex_responses"
        : "chat_completions",
      baseUrl: defaultOpenAIBaseUrl(),
      apiKey,
    };
  }

  return {
    provider,
    model,
    apiMode: "chat_completions",
    baseUrl: defaultOpenAIBaseUrl(),
    apiKey,
  };
}

function buildCustomProviderBridge(
  settings: LLMSettings,
  providerType: LLMProviderType,
  model: string,
): HermesProviderBridgeConfig {
  const normalizedProvider = normalizeKimiCodingProvider(providerType);
  if (normalizedProvider === "hermes" || normalizedProvider === "hermes-proxy") {
    throw new Error(
      "The embedded Hermes Harness cannot use the external Hermes Agent/API Server provider. " +
        "Select a concrete upstream provider first.",
    );
  }
  const catalogEntry = CUSTOM_PROVIDER_MAP.get(normalizedProvider);
  if (!catalogEntry) {
    throw new Error(
      `Hermes Harness does not have a provider bridge for "${providerType}".`,
    );
  }

  const customConfig =
    settings.customProviders?.[normalizedProvider] ||
    settings.customProviders?.[providerType];
  const baseUrl = firstText(customConfig?.baseUrl, catalogEntry.baseUrl);
  if (!baseUrl) {
    throw new Error(
      `${catalogEntry.name} requires a base URL before Hermes Harness can use it.`,
    );
  }

  return {
    provider: normalizedProvider,
    model,
    apiMode:
      catalogEntry.compatibility === "anthropic"
        ? "anthropic_messages"
        : "chat_completions",
    baseUrl,
    apiKey: text(customConfig?.apiKey),
  };
}

/**
 * Translate NeoWorker's decrypted provider settings into explicit Hermes
 * constructor arguments. Hermes still provides the agent loop and transports,
 * but it no longer decides the provider by reading ~/.hermes or the shell.
 */
export function resolveHermesProviderBridge(
  settings: LLMSettings,
  providerType: LLMProviderType,
  model: string,
): HermesProviderBridgeConfig {
  const normalizedModel = text(model);

  switch (providerType) {
    case "anthropic":
      return {
        provider: "anthropic",
        model: normalizedModel,
        apiMode: "anthropic_messages",
        baseUrl: "https://api.anthropic.com",
        apiKey: resolveAnthropicCredential(settings),
      };
    case "bedrock": {
      const region = firstText(settings.bedrock?.region, "us-east-1");
      const environment: Record<string, string> = {
        AWS_REGION: region,
        AWS_DEFAULT_REGION: region,
      };
      const accessKeyId = text(settings.bedrock?.accessKeyId);
      const secretAccessKey = text(settings.bedrock?.secretAccessKey);
      const sessionToken = text(settings.bedrock?.sessionToken);
      const profile = text(settings.bedrock?.profile);
      if (accessKeyId) environment.AWS_ACCESS_KEY_ID = accessKeyId;
      if (secretAccessKey) environment.AWS_SECRET_ACCESS_KEY = secretAccessKey;
      if (sessionToken) environment.AWS_SESSION_TOKEN = sessionToken;
      if (profile) environment.AWS_PROFILE = profile;
      return {
        provider: "bedrock",
        model: normalizedModel,
        apiMode: "bedrock_converse",
        baseUrl: defaultBedrockBaseUrl(region),
        environment,
      };
    }
    case "ollama":
      return {
        provider: "ollama",
        model: normalizedModel,
        apiMode: "chat_completions",
        baseUrl: ensureOllamaOpenAIBaseUrl(
          firstText(settings.ollama?.baseUrl, "http://localhost:11434"),
        ),
        apiKey: text(settings.ollama?.apiKey),
      };
    case "gemini":
      return {
        provider: "gemini",
        model: normalizedModel,
        apiMode: "chat_completions",
        baseUrl: defaultGeminiBaseUrl(),
        apiKey: text(settings.gemini?.apiKey),
      };
    case "openrouter":
      return {
        provider: "openrouter",
        model: normalizedModel,
        apiMode: "chat_completions",
        baseUrl: firstText(
          settings.openrouter?.baseUrl,
          "https://openrouter.ai/api/v1",
        ),
        apiKey: text(settings.openrouter?.apiKey),
      };
    case "deepseek":
      return {
        provider: "deepseek",
        model: normalizedModel,
        apiMode: "chat_completions",
        baseUrl: firstText(settings.deepseek?.baseUrl, "https://api.deepseek.com"),
        apiKey: text(settings.deepseek?.apiKey),
      };
    case "openai": {
      const openai = settings.openai;
      if (
        openai?.authMethod === "oauth" &&
        text(openai.accessToken) &&
        text(openai.refreshToken)
      ) {
        return {
          provider: "openai-codex",
          model: normalizedModel,
          apiMode: "codex_responses",
          baseUrl: "https://chatgpt.com/backend-api",
          apiKey: text(openai.accessToken),
        };
      }
      return {
        provider: "openai",
        model: normalizedModel,
        apiMode: modelUsesOpenAIResponses(normalizedModel)
          ? "codex_responses"
          : "chat_completions",
        baseUrl: defaultOpenAIBaseUrl(),
        apiKey: text(openai?.apiKey),
      };
    }
    case "azure":
      return buildAzureOpenAIBaseUrl(settings, normalizedModel);
    case "azure-anthropic": {
      const azureAnthropic = settings.azureAnthropic;
      const endpoint = normalizeAzureAnthropicEndpoint(
        text(azureAnthropic?.endpoint),
      );
      const deployment = firstText(
        azureAnthropic?.deployment,
        azureAnthropic?.deployments?.[0],
        normalizedModel,
      );
      if (!endpoint || !deployment) {
        throw new Error(
          "Hermes Harness cannot use Azure Anthropic until its endpoint and deployment are configured.",
        );
      }
      return {
        provider: "azure-anthropic",
        model: deployment,
        apiMode: "anthropic_messages",
        baseUrl: endpoint,
        apiKey: text(azureAnthropic?.apiKey),
      };
    }
    case "groq":
      return {
        provider: "groq",
        model: normalizedModel,
        apiMode: "chat_completions",
        baseUrl: firstText(
          settings.groq?.baseUrl,
          "https://api.groq.com/openai/v1",
        ),
        apiKey: text(settings.groq?.apiKey),
      };
    case "xai":
      return {
        provider: "xai",
        model: normalizedModel,
        apiMode: "codex_responses",
        baseUrl: firstText(settings.xai?.baseUrl, "https://api.x.ai/v1"),
        apiKey: text(settings.xai?.apiKey),
      };
    case "xai-oauth":
      return {
        provider: "xai-oauth",
        model: normalizedModel,
        apiMode: "codex_responses",
        baseUrl: firstText(settings.xai?.baseUrl, "https://api.x.ai/v1"),
        apiKey: text(settings.xai?.accessToken),
      };
    case "kimi":
      return {
        provider: "kimi",
        model: normalizedModel,
        apiMode: "chat_completions",
        baseUrl: firstText(
          settings.kimi?.baseUrl,
          "https://api.moonshot.cn/v1",
        ),
        apiKey: text(settings.kimi?.apiKey),
      };
    case "pi":
      return buildPiProviderBridge(settings, normalizedModel);
    case "openai-compatible":
      return {
        provider: "openai-compatible",
        model: normalizedModel,
        apiMode: "chat_completions",
        baseUrl: firstText(
          settings.openaiCompatible?.baseUrl,
          "http://localhost:1234/v1",
        ),
        apiKey: text(settings.openaiCompatible?.apiKey),
      };
    case "moa":
      throw new Error(
        "Hermes Harness cannot directly run a Mixture-of-Agents route. Select a concrete provider first.",
      );
    default:
      return buildCustomProviderBridge(settings, providerType, normalizedModel);
  }
}

export function buildHermesProviderBridgeEnvironment(
  bridge: HermesProviderBridgeConfig,
  hermesHome: string,
): NodeJS.ProcessEnv {
  return {
    HERMES_HOME: hermesHome,
    NEOWORKER_HERMES_PROVIDER: bridge.provider,
    NEOWORKER_HERMES_MODEL: bridge.model,
    NEOWORKER_HERMES_API_MODE: bridge.apiMode,
    ...(bridge.baseUrl
      ? { NEOWORKER_HERMES_BASE_URL: bridge.baseUrl }
      : {}),
    ...(bridge.apiKey
      ? { NEOWORKER_HERMES_API_KEY: bridge.apiKey }
      : {}),
    ...bridge.environment,
  };
}
