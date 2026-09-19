import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { getIdeaAvailability, loadIdeaAvailability, IDEA_AVAILABILITY_TIMEOUT_MS, type IdeaAvailabilitySnapshot } from "../idea-availability";
import type { SkillStatusEntry, IntegrationMentionOption } from "../../../shared/types";

const empty = () => ({ bins: [], anyBins: [], env: [], config: [], os: [] });
function skill(overrides: Partial<SkillStatusEntry> = {}): SkillStatusEntry {
  return { id: "test", name: "Test", description: "", prompt: "", icon: "", eligible: true, disabled: false, blockedByAllowlist: false, requirements: empty(), missing: empty(), ...overrides };
}
function integration(overrides: Partial<IntegrationMentionOption> = {}): IntegrationMentionOption {
  return { id: "builtin:notion", label: "Notion", providerKey: "notion", source: "builtin", iconKey: "notion", tools: ["notion_action"], description: "", promptHint: "", aliases: [], status: "configured", ...overrides };
}
const snapshot = (overrides: Partial<IdeaAvailabilitySnapshot> = {}): IdeaAvailabilitySnapshot => ({ skills: [skill()], integrations: [], ...overrides });

describe("idea availability", () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
  it("times out an unresponsive check and allows a fresh retry", async () => {
    vi.useFakeTimers();
    const getSkillStatus = vi.fn().mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValue({ skills: [skill()] });
    vi.stubGlobal("window", { electronAPI: { getSkillStatus, listIntegrationMentionOptions: vi.fn().mockResolvedValue([]) } });
    const failed = expect(loadIdeaAvailability()).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(IDEA_AVAILABILITY_TIMEOUT_MS);
    await failed;
    await expect(loadIdeaAvailability()).resolves.toEqual(snapshot());
    expect(vi.getTimerCount()).toBe(0);
  });
  it("rejects malformed status instead of crashing the gallery or enabling a card", async () => {
    const getSkillStatus = vi.fn().mockResolvedValue({ skills: [{ id: "test", eligible: true }] });
    const listIntegrationMentionOptions = vi.fn().mockResolvedValue([]);
    vi.stubGlobal("window", { electronAPI: { getSkillStatus, listIntegrationMentionOptions } });
    await expect(loadIdeaAvailability()).rejects.toThrow("unavailable");
    getSkillStatus.mockResolvedValue({ skills: [skill()] });
    listIntegrationMentionOptions.mockResolvedValue([{ providerKey: "notion", status: "configured" }]);
    await expect(loadIdeaAvailability()).rejects.toThrow("unavailable");
  });
  it("requires installed enabled eligible skills", () => {
    expect(getIdeaAvailability({ skill: "missing" }, snapshot()).reason).toBe("missingSkill");
    expect(getIdeaAvailability({ skill: "test" }, snapshot()).state).toBe("ready");
    for (const overrides of [{ disabled: true }, { enabled: false }]) {
      expect(getIdeaAvailability({ skill: "test" }, snapshot({ skills: [skill(overrides)] })).reason).toBe("disabled");
    }
    expect(getIdeaAvailability({ skill: "test" }, snapshot({ skills: [skill({ blockedByAllowlist: true })] })).reason).toBe("blocked");
  });
  it("reports unsupported operating systems and missing dependencies", () => {
    const windows = skill({ eligible: false, missing: { ...empty(), os: ["darwin"] }, requirements: { ...empty(), os: ["darwin"] } });
    expect(getIdeaAvailability({ skill: "test" }, snapshot({ skills: [windows] })).reason).toBe("platform");
    for (const key of ["bins", "anyBins", "env", "config"] as const) {
      const entry = skill({ eligible: false, missing: { ...empty(), [key]: ["dependency"] } });
      expect(getIdeaAvailability({ skill: "test" }, snapshot({ skills: [entry] }))).toMatchObject({ state: "setup", reason: "dependencies", details: ["dependency"] });
    }
  });
  it("does not treat a bundled household template as configured Notion", () => {
    const idea = { skill: "test", integrations: ["notion"] };
    expect(getIdeaAvailability(idea, snapshot())).toMatchObject({ state: "setup", settings: "integrations", details: ["notion"] });
    expect(getIdeaAvailability(idea, snapshot({ integrations: [integration()] })).state).toBe("ready");
  });
  it("does not trust a disconnected MCP or display-name coincidence", () => {
    const idea = { integrations: ["notion"] };
    for (const option of [integration({ source: "mcp" }), integration({ providerKey: "unrelated", tools: ["read_file"] }), integration({ tools: [] })]) {
      expect(getIdeaAvailability(idea, snapshot({ integrations: [option] })).state).toBe("setup");
    }
  });
  it("checks all dependencies and recognizes calendar tools", () => {
    const cal = integration({ providerKey: "google-workspace:calendar", tools: ["calendar_action"] });
    expect(getIdeaAvailability({ integrations: ["calendar"] }, snapshot({ integrations: [cal] })).state).toBe("ready");
    expect(getIdeaAvailability({ integrations: ["notion", "calendar"] }, snapshot({ integrations: [cal] })).state).toBe("setup");
  });
  it("separates plans from executable templates", () => {
    expect(getIdeaAvailability({ mode: "plan" }, snapshot()).state).toBe("plan");
    expect(getIdeaAvailability({}, snapshot()).state).toBe("ready");
  });
  it("declares bundled tools and service prerequisites instead of assuming presence", () => {
    const load = (id: string) => JSON.parse(readFileSync(new URL(`../../../../resources/skills/${id}.json`, import.meta.url), "utf8"));
    expect(load("peekaboo").requires).toMatchObject({ bins: ["peekaboo"], os: ["darwin"] });
    expect(load("blogwatcher").requires).toMatchObject({ bins: ["blogwatcher"] });
    expect(load("local-websearch").requires).toMatchObject({ env: ["SEARXNG_URL"] });
  });
});
