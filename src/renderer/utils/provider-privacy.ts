import type {
  LLMModelInfo,
  LLMProviderInfo,
  LLMProviderType,
} from "../../shared/types";

/**
 * Provider identifiers used by the embedded execution service. They remain
 * valid configuration values for the Electron process, but are not product
 * names that should be exposed by renderer controls.
 */
export const HIDDEN_BACKEND_PROVIDER_TYPES: ReadonlySet<string> = new Set([
  "hermes",
  "hermes-proxy",
]);

export function isHiddenBackendProviderType(
  providerType?: string | null,
): boolean {
  return typeof providerType === "string"
    ? HIDDEN_BACKEND_PROVIDER_TYPES.has(providerType.trim().toLowerCase())
    : false;
}

/** Return a stable, implementation-neutral label for a configured provider. */
export function getUserVisibleProviderName(
  providerType?: string | null,
  suppliedName?: string | null,
): string {
  if (isHiddenBackendProviderType(providerType)) return "Configured provider";
  const name = typeof suppliedName === "string" ? suppliedName.trim() : "";
  return name || (typeof providerType === "string" ? providerType : "");
}

/**
 * Keep the provider key for IPC/configuration, while replacing its display
 * name. This lets an existing configuration continue working without putting
 * an implementation name in a menu or status card.
 */
export function sanitizeProviderInfoForDisplay<T extends LLMProviderInfo>(
  provider: T,
): T {
  if (!isHiddenBackendProviderType(provider.type)) return provider;
  return {
    ...provider,
    name: getUserVisibleProviderName(provider.type, provider.name),
  };
}

export function filterProvidersForDisplay<T extends LLMProviderInfo>(
  providers: T[],
  options: { keepSelectedType?: string | null; includeHidden?: boolean } = {},
): T[] {
  const selectedType = options.keepSelectedType?.trim().toLowerCase();
  const includeHidden = options.includeHidden === true;
  return providers
    .filter((provider) => {
      if (!isHiddenBackendProviderType(provider.type)) return true;
      if (includeHidden) return true;
      return (
        Boolean(selectedType) &&
        provider.type.trim().toLowerCase() === selectedType
      );
    })
    .map(sanitizeProviderInfoForDisplay);
}

export function sanitizeModelInfoForDisplay<T extends LLMModelInfo>(
  model: T,
  providerType?: LLMProviderType | string | null,
): T {
  if (!isHiddenBackendProviderType(providerType)) return model;
  return {
    ...model,
    // Keep `key` untouched because it is sent back to the main process. The
    // label and description are what renderer users see.
    displayName: "Configured model",
    description: "Configured model",
  };
}

export function sanitizeModelsForDisplay<T extends LLMModelInfo>(
  models: T[],
  providerType?: LLMProviderType | string | null,
): T[] {
  return models.map((model) => sanitizeModelInfoForDisplay(model, providerType));
}
