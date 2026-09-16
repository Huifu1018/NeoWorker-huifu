import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("../SearchSettings.tsx", import.meta.url)),
  "utf8",
);

describe("search settings providers", () => {
  it("shows every backend search provider in the configuration tabs", () => {
    expect(source).toContain("const providerTabs = configStatus?.providers || []");
    expect(source).toContain("{providerTabs.map((provider) => (");
    expect(source).toContain('"searchSettings.provider.notConfigured"');
    expect(source).toContain('activeProviderConfig.type === "serper"');
  });

  it("limits primary and fallback choices to providers that are actually runnable", () => {
    expect(source).toContain(
      "const selectableProviders = providerTabs.filter((p) => p.configured);",
    );
    expect(source).toContain('activeProviderConfig.type === "duckduckgo"');
  });
});
