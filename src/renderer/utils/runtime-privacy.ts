import type { TaskEvent } from "../../shared/types";
import { getEffectiveTaskEventType } from "./task-event-compat";

/**
 * Renderer-only privacy boundary for execution runtime metadata.
 *
 * Hermes is an implementation detail of NeoWorker.  The event store still
 * keeps the metadata needed by the executor, but renderer projections must
 * not expose the runtime name, ACP transport, session identifiers, or host
 * error codes.  The helpers in this module deliberately inspect structured
 * fields instead of searching every message for the word "Hermes" so a user
 * can still discuss that word in their own prompt or answer.
 */

const HERMES_TOKEN_PATTERN = /\bhermes\b/i;
const HERMES_TYPE_PATTERN = /^hermes(?:[_-]|$)/i;
const HERMES_ERROR_PATTERN = /^hermes[_-]/i;

const HERMES_MARKER_KEYS = new Set([
  "runtimeagent",
  "runtimeagentname",
  "runtimepreference",
  "runtimestate",
  "harness",
  "hermesruntime",
  "hermessessionid",
  "hermescheckpoint",
  "hermeshigherlevelstate",
  "providerbridge",
  "externalruntime",
]);

const HERMES_VALUE_KEYS = new Set([
  "runtime",
  "runtimeagent",
  "runtimeagentname",
  "runtimepreference",
  "runtimestate",
  "harness",
  "agent",
  "agentname",
  "providertype",
  "modelid",
  "modelkey",
]);

const RUNTIME_METADATA_KEYS = new Set([
  "runtime",
  "runtimeagent",
  "runtimeagentname",
  "runtimepreference",
  "runtimestate",
  "harness",
  "hermesruntime",
  "hermessessionid",
  "hermescheckpoint",
  "hermeshigherlevelstate",
  "providerbridge",
  "acp",
  "acpx",
]);

const CONTENT_KEYS = new Set([
  "message",
  "content",
  "summary",
  "semanticsummary",
  "resultsummary",
  "outputsummary",
  "reason",
]);

const PURE_RUNTIME_EVENT_TYPES = new Set([
  "executing",
  "progress_update",
  "llm_streaming",
  "llm_retry",
  "log",
  "timeline_step_updated",
  "timeline_step_finished",
  "timeline_group_started",
  "timeline_group_finished",
  "task_paused",
  "task_resumed",
  "hermes_runtime_checkpoint",
  "hermes_runtime_update",
  "hermes_runtime_transport",
  "hermes_runtime_retry",
  "hermes_runtime_session_warm",
  "hermes_runtime_session_reused",
  "hermes_runtime_session_closed",
]);

const SUBSTANTIVE_EVENT_TYPES = new Set([
  "user_message",
  "assistant_message",
  "task_completed",
  "follow_up_completed",
  "follow_up_failed",
  "task_failed",
  "task_cancelled",
  "task_interrupted",
  "task_status",
  "task_paused",
  "task_resumed",
  "error",
  "timeline_error",
  "llm_error",
  "step_failed",
  "verification_failed",
  "verification_pending_user_action",
  "tool_call",
  "tool_result",
  "tool_error",
  "tool_warning",
  "tool_blocked",
  "error",
  "llm_error",
  "timeline_error",
  "task_failed",
  "follow_up_failed",
  "task_status",
  "task_cancelled",
  "artifact_created",
  "timeline_artifact_emitted",
  "file_created",
  "file_modified",
  "file_deleted",
]);

const NEUTRAL_COMPLETION_TEXT = "Task completed without a final response.";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function keyName(key: string): string {
  return key.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isHermesValue(value: unknown): boolean {
  const text = stringValue(value);
  return HERMES_TOKEN_PATTERN.test(text) || HERMES_ERROR_PATTERN.test(text);
}

function hasHermesMarker(value: unknown, depth = 0): boolean {
  if (depth > 3) return false;
  const record = asRecord(value);
  if (!record) return false;

  for (const [rawKey, child] of Object.entries(record)) {
    const key = keyName(rawKey);
    const text = stringValue(child);

    if (HERMES_MARKER_KEYS.has(key) && (isHermesValue(child) || key.startsWith("hermes"))) {
      return true;
    }
    if (
      (key === "phase" || key === "metric" || key === "errorcode" || key === "eventtype") &&
      (HERMES_TYPE_PATTERN.test(text) || HERMES_ERROR_PATTERN.test(text))
    ) {
      return true;
    }
    if (
      HERMES_VALUE_KEYS.has(key) &&
      (isHermesValue(child) || HERMES_TYPE_PATTERN.test(text))
    ) {
      return true;
    }

    // Runtime envelopes are sometimes nested under result/details/metadata.
    // Recurse only through objects; message/content strings are intentionally
    // never inspected here, which keeps user-authored text untouched.
    if (asRecord(child) && hasHermesMarker(child, depth + 1)) return true;
  }

  return false;
}

/** Return true when a structured payload identifies the Hermes runtime. */
export function isHermesRuntimePayload(value: unknown): boolean {
  return hasHermesMarker(value);
}

function eventTypeCandidates(event: TaskEvent): string[] {
  return [String(event.type || ""), String(event.legacyType || "")]
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Return true for an event whose primary purpose is runtime telemetry.  A
 * substantive message/tool/result event carrying runtime metadata is kept so
 * the actual conversation and task result remain available to the user.
 */
export function isHermesRuntimeEvent(event: TaskEvent): boolean {
  // Failure/lifecycle events and projected conversation content must survive
  // regardless of which runtime produced them. Use the shared timeline-v2
  // resolver so payload.legacyType and failed step statuses are honored too.
  const effectiveType = getEffectiveTaskEventType(event).trim().toLowerCase();
  if (SUBSTANTIVE_EVENT_TYPES.has(effectiveType)) return false;
  const candidates = eventTypeCandidates(event);
  if (candidates.some((type) => HERMES_TYPE_PATTERN.test(type))) return true;

  const payloadHasHermes = isHermesRuntimePayload(event.payload);
  if (!payloadHasHermes) {
    const actor = typeof event.actor === "string" ? event.actor : "";
    return (
      PURE_RUNTIME_EVENT_TYPES.has(effectiveType) &&
      HERMES_TOKEN_PATTERN.test(actor)
    );
  }

  if (PURE_RUNTIME_EVENT_TYPES.has(effectiveType)) return true;

  // Unknown events carrying an explicit Hermes phase/metric are internal by
  // convention.  Keep unrelated future event types inspectable.
  const payload = asRecord(event.payload);
  const phase = stringValue(payload?.phase);
  const metric = stringValue(payload?.metric);
  const errorCode = stringValue(payload?.errorCode);
  return (
    HERMES_TYPE_PATTERN.test(phase) ||
    HERMES_TYPE_PATTERN.test(metric) ||
    HERMES_ERROR_PATTERN.test(errorCode)
  );
}

function knownHermesFallback(text: string): string {
  const normalized = text.trim();
  if (!normalized) return text;

  // Covers the old persisted summaries as well as the ACP adapter's dynamic
  // `${runtimeAgentName} via ACP ...` wording.
  if (
    /^(?:(?:hermes(?:\s+agent)?|[^\n]{1,80}\s+via\s+acp(?:x)?)\s+)?(?:follow[- ]?up\s+|resumed\s+)?completed\s+without\s+a\s+final\s+(?:assistant\s+)?message\.?$/i.test(
      normalized,
    ) &&
    (/\bhermes\b/i.test(normalized) || /\bvia\s+acp(?:x)?\b/i.test(normalized))
  ) {
    return NEUTRAL_COMPLETION_TEXT;
  }
  if (
    /^(?:hermes(?:\s+agent)?|[^\n]{1,80}\s+via\s+acp(?:x)?)\s+resumed\s+without\s+a\s+final\s+(?:assistant\s+)?message\.?$/i.test(
      normalized,
    )
  ) {
    return NEUTRAL_COMPLETION_TEXT;
  }
  return text;
}

function hasTechnicalHermesContext(text: string): boolean {
  return /\b(?:runtime|harness|acp|acpx|provider|checkpoint|session|unavailable|error|failed|failure|retry(?:ing)?|fallback|resum(?:e|ed|ing)|delegat(?:e|ing)|transport|returned|in[- ]progress)\b/i.test(
    text,
  );
}

/**
 * Replace implementation-specific runtime wording in technical display text.
 * Ordinary prose containing only the product name is left unchanged.
 */
export function sanitizeHermesText(value: unknown): string {
  // Older translation guards exposed the runtime-specific tool alias in Chinese.
  // Remove only that exact implementation note, preserving ordinary Hermes prose.
  const text = (typeof value === "string" ? value : String(value ?? ""))
    .replace(/[（(]Hermes\s*中为\s*mcp_neoworker_[a-z_]+[）)]/gi, "");
  if (!text) return "";
  const fallback = knownHermesFallback(text);
  if (fallback !== text) return fallback;
  const hasHermesReference =
    HERMES_TOKEN_PATTERN.test(text) || HERMES_ERROR_PATTERN.test(text);
  if (!hasHermesReference || !hasTechnicalHermesContext(text)) {
    return text;
  }

  return text
    .replace(/\bhermes[-_]mcp\b/gi, "execution-service-tool")
    .replace(/\bHermes\s+Harness\b/gi, "the execution service")
    .replace(/\bHermes(?:\s+Agent)?(?:\s+Runtime)?\b/gi, "the execution service")
    .replace(/\bvia\s+ACP(?:X)?\b/gi, "via the execution service")
    .replace(/\bACP(?:X)?\s+runtime\b/gi, "execution service")
    .replace(/\bACP(?:X)?\b/gi, "runtime")
    .replace(/\bHERMES[_-][A-Z0-9_-]+\b/gi, "execution service error")
    .replace(/\s{2,}/g, " ");
}

function shouldDropKey(
  rawKey: string,
  value: unknown,
  hermesContext: boolean,
): boolean {
  const key = keyName(rawKey);
  if (RUNTIME_METADATA_KEYS.has(key)) return true;
  if (key === "errorcode" && isHermesValue(value)) return true;
  if (key === "phase" && HERMES_TYPE_PATTERN.test(stringValue(value))) return true;
  if (key === "metric" && HERMES_TYPE_PATTERN.test(stringValue(value))) return true;
  if (
    hermesContext &&
    (key === "providertype" || key === "modelid" || key === "modelkey") &&
    isHermesValue(value)
  ) {
    return true;
  }
  if (
    (key === "agent" || key === "agentname") &&
    isHermesValue(value) &&
    hermesContext
  ) {
    return true;
  }
  if (
    hermesContext &&
    (key === "tooluseid" || key === "toolcallid" || key === "idempotencykey") &&
    isHermesValue(value)
  ) {
    return true;
  }
  return false;
}

function sanitizeValue(
  value: unknown,
  inheritedHermesContext: boolean,
  preserveContent = true,
): unknown {
  if (typeof value === "string") return sanitizeHermesText(value);
  if (Array.isArray(value)) {
    return value.map((child) =>
      sanitizeValue(child, inheritedHermesContext, preserveContent),
    );
  }

  const record = asRecord(value);
  if (!record) return value;

  const hermesContext = inheritedHermesContext || isHermesRuntimePayload(record);
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    if (shouldDropKey(key, child, hermesContext)) continue;

    // Preserve the user's substantive prompt/result verbatim except for the
    // known historical fallback sentence. Technical sibling fields are still
    // sanitized recursively below.
    if (
      preserveContent &&
      hermesContext &&
      CONTENT_KEYS.has(keyName(key)) &&
      typeof child === "string"
    ) {
      output[key] = knownHermesFallback(child);
      continue;
    }
    output[key] = sanitizeValue(child, hermesContext, preserveContent);
  }
  return output;
}

/** Recursively remove runtime implementation metadata from display payloads. */
export function sanitizeRuntimeDisplayValue(value: unknown): unknown {
  return sanitizeValue(value, false);
}

/**
 * Produce a renderer-safe event. Pure Hermes runtime telemetry returns null;
 * substantive events remain available with their runtime metadata removed.
 */
export function sanitizeTaskEventForDisplay(
  event: TaskEvent,
): TaskEvent | null {
  if (isHermesRuntimeEvent(event)) return null;

  const effectiveType = getEffectiveTaskEventType(event);
  const preserveContent =
    effectiveType === "user_message" || effectiveType === "assistant_message";
  const payload = sanitizeValue(event.payload, false, preserveContent);
  const inlineFrames = sanitizeRuntimeDisplayValue(event.inlineFrames);
  const actor =
    typeof event.actor === "string" &&
    HERMES_TOKEN_PATTERN.test(event.actor)
      ? "agent"
      : event.actor;

  return {
    ...event,
    payload: payload as TaskEvent["payload"],
    ...(event.inlineFrames
      ? { inlineFrames: inlineFrames as TaskEvent["inlineFrames"] }
      : {}),
    ...(actor ? { actor: actor as TaskEvent["actor"] } : {}),
  };
}
