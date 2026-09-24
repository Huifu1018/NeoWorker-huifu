import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { Sidebar } from "../Sidebar";
import { CollapsedSidebarRail } from "../CollapsedSidebarRail";
import { applyPersistedLanguage, getCurrentLanguage } from "../../i18n";
const initialLanguage = getCurrentLanguage();
afterEach(() => applyPersistedLanguage(initialLanguage));
const noop = () => {};

describe("Paper News navigation", () => {
  it.each([
    ["zh-CN", "论文动态"],
    ["en", "Paper News"],
  ])("shows an active localized destination in both sidebar sizes (%s)", (language, label) => {
    applyPersistedLanguage(language);
    const expanded = renderToStaticMarkup(
      React.createElement(Sidebar, {
        workspace: null,
        tasks: [],
        selectedTaskId: null,
        onSelectTask: noop,
        onOpenSettings: noop,
        onOpenAutomations: noop,
        onTasksChanged: noop,
        isPaperNewsActive: true,
        onOpenPaperNews: noop,
      }),
    );
    expect(expanded).toContain(`aria-pressed="true" title="${label}"`);
    const collapsed = renderToStaticMarkup(
      React.createElement(CollapsedSidebarRail, {
        onExpand: noop,
        onNewSession: noop,
        onOpenEverydayAgent: noop,
        onOpenAgentTeam: noop,
        onOpenIdeas: noop,
        onOpenAutomations: noop,
        onOpenToolsAndSkills: noop,
        onOpenSettings: noop,
        onOpenPaperNews: noop,
        isPaperNewsActive: true,
      }),
    );
    expect(collapsed).toContain(`aria-label="${label}" aria-current="page"`);
  });
});
