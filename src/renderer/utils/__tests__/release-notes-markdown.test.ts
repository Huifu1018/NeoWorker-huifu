import { describe, expect, it } from "vitest";
import { sanitizeReleaseNotesForDisplay } from "../release-notes-markdown";

describe("sanitizeReleaseNotesForDisplay", () => {
  it("removes build metadata before the user-facing release section", () => {
    const notes = `# NeoWorker v0.2.2

源码提交：\`7bbb4a7\`。

- macOS：Apple Silicon / arm64，下载 .dmg。
- Windows：x64，下载 -setup.exe。
- SHA256SUMS 文件用于校验下载，build JSON 记录源码与构建来源。

## [0.2.2] - 2026-09-22

### Changed

- Improve the update experience.`;

    const visible = sanitizeReleaseNotesForDisplay(notes);

    expect(visible).toContain("## [0.2.2]");
    expect(visible).toContain("Improve the update experience.");
    expect(visible).not.toContain("源码提交");
    expect(visible).not.toContain("SHA256SUMS");
    expect(visible).not.toContain("build JSON");
  });

  it("filters technical lines when a release has no version section", () => {
    const visible = sanitizeReleaseNotesForDisplay(
      "# NeoWorker v0.2.2\n\n源码提交：abc\n\n### Fixed\n\n- Faster startup.",
    );

    expect(visible).toBe("### Fixed\n\n- Faster startup.");
  });
});
