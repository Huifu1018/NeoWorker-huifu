import { CUSTOM_PROVIDER_MAP } from "./llm-provider-catalog";
import { MULTI_LLM_PROVIDER_DISPLAY } from "./types";

const customProviderDisplayMap = CUSTOM_PROVIDER_MAP as Map<string, { name: string }>;

export function normalizeLlmProviderType(providerType?: string | null): string | null {
  if (typeof providerType !== "string") return null;
  const trimmed = providerType.trim();
  if (!trimmed) return null;
  return trimmed === "kimi-coding" ? "kimi-code" : trimmed;
}

export function getLlmProviderDisplayName(providerType?: string | null): string {
  const normalized = normalizeLlmProviderType(providerType);
  if (!normalized || normalized === "unknown") return "Unknown";
  // The embedded execution provider is an implementation detail. Keep its
  // configuration key available to the main process while presenting a
  // neutral label anywhere usage data is rendered.
  if (normalized === "hermes" || normalized === "hermes-proxy") {
    return "Configured provider";
  }
  return (
    MULTI_LLM_PROVIDER_DISPLAY[normalized]?.name ||
    customProviderDisplayMap.get(normalized)?.name ||
    normalized
  );
}
