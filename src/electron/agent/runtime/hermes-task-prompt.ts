export interface HermesInitialPromptOptions {
  taskPrompt: string;
  workspacePath: string;
  contextNotes?: string[];
  appliedSkillContext?: string;
  resuming?: boolean;
}

export interface HermesFollowUpPromptOptions {
  message: string;
  workspacePath: string;
}

export interface HermesRecoveryPromptOptions {
  taskPrompt: string;
  workspacePath: string;
}

const MAX_TASK_PROMPT_CHARS = 48_000;
const MAX_CONTEXT_CHARS = 16_000;
const MAX_FOLLOW_UP_CHARS = 24_000;
const MAX_WORKSPACE_PATH_CHARS = 4_000;
const TRUNCATION_MARKER = "\n[NeoWorker context truncated]\n";

function clampText(value: unknown, maxChars: number): string {
  const text = String(value || "").trim();
  if (text.length <= maxChars) return text;
  const retained = Math.max(0, maxChars - TRUNCATION_MARKER.length);
  const head = Math.ceil(retained * 0.7);
  const tail = retained - head;
  return `${text.slice(0, head)}${TRUNCATION_MARKER}${text.slice(-tail)}`;
}

function normalizeContextNotes(notes: string[] | undefined): string {
  if (!Array.isArray(notes) || notes.length === 0) return "";
  const unique = Array.from(
    new Set(
      notes
        .map((note) => String(note || "").trim())
        .filter(Boolean),
    ),
  );
  return clampText(unique.join("\n\n"), MAX_CONTEXT_CHARS);
}

function hostContract(): string {
  return [
    "<neoworker_runtime_contract_v1>",
    "You are the reasoning and task orchestration runtime inside NeoWorker.",
    "NeoWorker owns all local side effects and exposes the approved tools through its MCP Tool Host.",
    "Use only tools exposed by the NeoWorker host for files, Shell, dependencies, and other workspace actions.",
    "Do not claim an action succeeded until the tool result confirms it.",
    "Keep multi-step work ordered when a later step depends on an earlier result.",
    "Do not repeat a side effect whose result is unknown; inspect the workspace and checkpoint first.",
    "Finish with a concise factual response after the requested work is complete or clearly blocked.",
    "</neoworker_runtime_contract_v1>",
  ].join("\n");
}

export function buildHermesInitialPrompt(
  options: HermesInitialPromptOptions,
): string {
  const taskPrompt = clampText(options.taskPrompt, MAX_TASK_PROMPT_CHARS);
  const workspacePath = clampText(options.workspacePath, MAX_WORKSPACE_PATH_CHARS);
  const context = normalizeContextNotes(options.contextNotes);
  const skillContext = clampText(options.appliedSkillContext, MAX_CONTEXT_CHARS);
  const sections = [
    hostContract(),
    `<neoworker_workspace_v1>\nWorkspace root: ${workspacePath}\n</neoworker_workspace_v1>`,
    `<neoworker_task_v1>\n${taskPrompt}\n</neoworker_task_v1>`,
    context
      ? `<neoworker_context_v1>\n${context}\n</neoworker_context_v1>`
      : "",
    skillContext
      ? `<neoworker_skills_v1>\n${skillContext}\n</neoworker_skills_v1>`
      : "",
    options.resuming
      ? [
          "<neoworker_recovery_notice_v1>",
          "This is a resumed Hermes session. Inspect the existing checkpoint, workspace, and prior tool results before starting another side effect.",
          "Completed work must be preserved; unknown side effects require explicit confirmation before retry.",
          "</neoworker_recovery_notice_v1>",
        ].join("\n")
      : "",
  ];
  return sections.filter(Boolean).join("\n\n");
}

export function buildHermesFollowUpPrompt(
  options: HermesFollowUpPromptOptions,
): string {
  const workspacePath = clampText(options.workspacePath, MAX_WORKSPACE_PATH_CHARS);
  const message = clampText(options.message, MAX_FOLLOW_UP_CHARS);
  return [
    "<neoworker_follow_up_v1>",
    "Continue the existing Hermes session using its prior conversation and tool results.",
    `Workspace root: ${workspacePath}`,
    "Treat the latest user message below as the new instruction for this turn.",
    "Do not restart completed work or repeat a side effect unless the current state proves it is required.",
    `Latest user message:\n${message}`,
    "</neoworker_follow_up_v1>",
  ].join("\n");
}

export function buildHermesRecoveryPrompt(
  options: HermesRecoveryPromptOptions,
): string {
  const workspacePath = clampText(options.workspacePath, MAX_WORKSPACE_PATH_CHARS);
  const taskPrompt = clampText(options.taskPrompt, 12_000);
  return [
    "<neoworker_recovery_v1>",
    "The previous Hermes transport or process ended before the task was fully finalized.",
    `Workspace root: ${workspacePath}`,
    `Original task objective (reference only):\n${taskPrompt}`,
    "Continue from the saved Hermes checkpoint. Inspect existing files and prior tool results first.",
    "Do not automatically repeat a tool call whose side effect result is unknown. If confirmation is requested, wait for it.",
    "When the task is complete, provide a concise factual final response.",
    "</neoworker_recovery_v1>",
  ].join("\n");
}

export const _testUtils = {
  clampText,
  hostContract,
  normalizeContextNotes,
};
