import type { IntegrationMentionOption, SkillStatusEntry } from "../../shared/types";

export type IdeaSettingsTarget = "skills" | "integrations";
export interface IdeaRequirements {
  skill?: string;
  integrations?: string[];
  mode?: "plan";
}
export interface IdeaAvailabilitySnapshot {
  skills: SkillStatusEntry[];
  integrations: IntegrationMentionOption[];
}
export type IdeaAvailability = {
  state: "ready" | "setup" | "plan";
  reason?: "missingSkill" | "disabled" | "blocked" | "platform" | "dependencies" | "integration";
  details?: string[];
  settings?: IdeaSettingsTarget;
};

function hasIntegration(name: string, options: IntegrationMentionOption[]): boolean {
  const toolNames: Record<string, string[]> = {
    notion: ["notion_action"],
    calendar: ["calendar_action", "apple_calendar_action"],
    gmail: ["gmail_action"],
  };
  return options.some(option => {
    if (!["configured", "connected"].includes(option.status) || !Array.isArray(option.tools) || !option.tools.length) return false;
    if (option.source === "mcp" && option.status !== "connected") return false;
    // Match declared provider identity/tools, never a display label or fuzzy
    // alias (e.g. a disconnected server merely named "Notion").
    return option.providerKey === name || (toolNames[name] || []).some(tool => option.tools.includes(tool));
  });
}

export function getIdeaAvailability(idea: IdeaRequirements, snapshot: IdeaAvailabilitySnapshot): IdeaAvailability {
  if (idea.skill) {
    const skill = snapshot.skills.find(entry => entry.id === idea.skill);
    if (!skill) return { state: "setup", reason: "missingSkill", settings: "skills" };
    if (skill.disabled || skill.enabled === false) return { state: "setup", reason: "disabled", settings: "skills" };
    if (skill.blockedByAllowlist) return { state: "setup", reason: "blocked", settings: "skills" };
    if (skill.missing.os.length) return { state: "setup", reason: "platform", details: skill.requirements.os, settings: "skills" };
    const missing = [...skill.missing.bins, ...skill.missing.anyBins, ...skill.missing.env, ...skill.missing.config];
    if (!skill.eligible || missing.length) return { state: "setup", reason: "dependencies", details: missing, settings: "skills" };
  }
  const missingIntegrations = (idea.integrations || []).filter(name => !hasIntegration(name, snapshot.integrations));
  if (missingIntegrations.length) return { state: "setup", reason: "integration", details: missingIntegrations, settings: "integrations" };
  return { state: idea.mode === "plan" ? "plan" : "ready" };
}

export const IDEA_AVAILABILITY_TIMEOUT_MS = 10_000;

export async function loadIdeaAvailability(): Promise<IdeaAvailabilitySnapshot> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const skills = await window.electronAPI.getSkillStatus();
        const integrations = await window.electronAPI.listIntegrationMentionOptions();
        const fields = ["bins", "anyBins", "env", "config", "os"] as const;
        if (!Array.isArray(skills?.skills) || !Array.isArray(integrations) ||
          skills.skills.some(skill => !skill || typeof skill.id !== "string" || typeof skill.eligible !== "boolean" ||
            fields.some(field => !Array.isArray(skill.missing?.[field]) || !Array.isArray(skill.requirements?.[field]))) ||
          integrations.some(option => !option || !Array.isArray(option.tools))) {
          throw new Error("Availability check unavailable");
        }
        return { skills: skills.skills, integrations };
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Availability check timed out")), IDEA_AVAILABILITY_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
