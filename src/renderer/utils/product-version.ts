import { useEffect, useState } from "react";
import { PRODUCT_DISPLAY_VERSION } from "../../shared/product-brand";

/**
 * Resolve the version from Electron's package metadata instead of relying on
 * a renderer-bundled constant. This keeps installed builds and their visible
 * badges aligned when the same source is packaged under different versions.
 */
export function useProductDisplayVersion(): string {
  const [displayVersion, setDisplayVersion] = useState(PRODUCT_DISPLAY_VERSION);

  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.getAppVersion) return;

    void api
      .getAppVersion()
      .then((info) => {
        const version = String(info?.version || "").trim().replace(/^v/i, "");
        if (version && version !== "browser-preview") {
          setDisplayVersion(`V${version}`);
        }
      })
      .catch(() => {
        // Keep the build-time branding fallback if version lookup is unavailable.
      });
  }, []);

  return displayVersion;
}
