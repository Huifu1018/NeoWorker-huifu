import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const mainSource = readFileSync(
  new URL("../../main.tsx", import.meta.url),
  "utf8",
);
const styles = readFileSync(
  new URL("../../styles/composer-control-refinement.css", import.meta.url),
  "utf8",
);

describe("composer control refinement", () => {
  it("loads the compact composer layer after the reading layer", () => {
    const readingImport = mainSource.indexOf(
      'import "./styles/conversation-reading.css"',
    );
    const compactImport = mainSource.indexOf(
      'import "./styles/composer-control-refinement.css"',
    );

    expect(readingImport).toBeGreaterThan(-1);
    expect(compactImport).toBeGreaterThan(readingImport);
  });

  it("uses one compact permission control size in welcome and session composers", () => {
    expect(styles).toMatch(
      /\.welcome-input-container\.cli-input-container \.permission-access-btn,[\s\S]*?\.session-composer\.input-container \.permission-access-btn\s*\{[\s\S]*?height:\s*32px;[\s\S]*?min-height:\s*32px;[\s\S]*?gap:\s*5px;[\s\S]*?padding-inline:\s*6px;/,
    );
    expect(styles).toMatch(
      /\.permission-access-btn > svg[\s\S]*?width:\s*14px;[\s\S]*?height:\s*14px;/,
    );
  });

  it("keeps the session send arrow white whenever the blue button is actionable", () => {
    expect(styles).toMatch(
      /\.session-composer\.input-container\s+\.lets-go-btn\.lets-go-btn-sm:not\(:disabled\):not\(\.composer-send-empty\)\s*\{[\s\S]*?color:\s*#ffffff;/,
    );
    expect(styles).toMatch(
      /\.session-composer\.input-container\s+\.lets-go-btn\.lets-go-btn-sm:not\(:disabled\):not\(\.composer-send-empty\)\s*>\s*svg\s*\{[\s\S]*?stroke:\s*currentColor;/,
    );
    expect(styles).toMatch(
      /\.session-composer\.input-container:has\(\.prompt-composer-input\[data-has-draft="true"\]\)[\s\S]*?\.lets-go-btn\.lets-go-btn-sm\.composer-send-empty:not\(:disabled\)\s*\{[\s\S]*?color:\s*#ffffff;/,
    );
  });
});
