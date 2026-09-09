import type {
  ToolPolicyTrace,
  ToolResultEnvelope,
  ToolResultEnvelopeStatus,
  ToolResultEvidence,
} from "../../../shared/types";

export interface BuildToolResultEnvelopeParams {
  toolUseId: string;
  toolName: string;
  status: ToolResultEnvelopeStatus;
  result?: unknown;
  error?: unknown;
  retryable?: boolean;
  policyTrace?: ToolPolicyTrace;
  evidence?: ToolResultEvidence[];
  userSummary?: string;
  modelReminder?: string;
  uiHints?: Record<string, unknown>;
  telemetry?: Record<string, unknown>;
}

// Keep model context bounded while retaining the complete structured result in
// the task log and on the envelope's structuredData field.
const MAX_MODEL_PAYLOAD_CHARS = 200_000;
const MODEL_PAYLOAD_TRUNCATION_MARKER = "\n[Tool result truncated by NeoWorker]\n";

function stringifyJsonResult(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return JSON.stringify({ value: String(value ?? "") });
  }
}

function stringifyPayloadWithReminder(
  value: unknown,
  reminder: string,
  stringField: "content" | "error",
): string {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return stringifyJsonResult({
      ...(value as Record<string, unknown>),
      _modelReminder: reminder,
    });
  }
  return stringifyJsonResult({
    [stringField]: typeof value === "string" ? value : String(value ?? ""),
    _modelReminder: reminder,
  });
}

function stringifyModelPayload(params: BuildToolResultEnvelopeParams): string {
  const reminder =
    typeof params.modelReminder === "string" && params.modelReminder.trim().length > 0
      ? params.modelReminder.trim()
      : "";
  let payload: string;
  if (params.error) {
    const message = String((params.error as { message?: string })?.message || params.error || "");
    payload = reminder
      ? stringifyPayloadWithReminder(message || "Tool execution failed", reminder, "error")
      : JSON.stringify({ error: message || "Tool execution failed" });
  } else if (typeof params.result === "string") {
    payload = reminder
      ? stringifyPayloadWithReminder(params.result, reminder, "content")
      : params.result;
  } else {
    payload = reminder
      ? stringifyPayloadWithReminder(params.result, reminder, "content")
      : stringifyJsonResult(params.result);
  }
  if (payload.length <= MAX_MODEL_PAYLOAD_CHARS) return payload;
  // Preserve valid JSON for structured payloads; plain text is capped directly.
  if (typeof params.result === "string" && !params.error) {
    return `${payload.slice(0, MAX_MODEL_PAYLOAD_CHARS - MODEL_PAYLOAD_TRUNCATION_MARKER.length)}${MODEL_PAYLOAD_TRUNCATION_MARKER}`;
  }
  return JSON.stringify({
    // Leave room for the JSON wrapper itself as well as the marker.
    content: payload.slice(0, MAX_MODEL_PAYLOAD_CHARS - MODEL_PAYLOAD_TRUNCATION_MARKER.length - 1_000),
    truncated: true,
    _modelReminder: MODEL_PAYLOAD_TRUNCATION_MARKER.trim(),
  });
}

function buildUserSummary(params: BuildToolResultEnvelopeParams): string {
  if (params.userSummary) return params.userSummary;
  if (params.error) {
    return `${params.toolName} failed`;
  }
  return `${params.toolName} completed`;
}

function buildDefaultEvidence(params: BuildToolResultEnvelopeParams): ToolResultEvidence[] {
  const result =
    params.result && typeof params.result === "object" && !Array.isArray(params.result)
      ? (params.result as Record<string, unknown>)
      : {};
  const evidence: ToolResultEvidence[] = [];
  const push = (entry: ToolResultEvidence | null) => {
    if (entry) evidence.push(entry);
  };

  const stringValue = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

  if (params.toolName === "read_file" || params.toolName === "write_file" || params.toolName === "edit_file") {
    const path = stringValue(result.path) || stringValue(result.filePath) || stringValue(result.file);
    if (path) {
      push({
        type: "file",
        label: "File",
        value: path,
        extra: {
          operation:
            params.toolName === "read_file"
              ? "read"
              : params.toolName === "write_file"
                ? "write"
                : "edit",
        },
      });
    }
  }

  if (params.toolName === "delete_file") {
    const path = stringValue(result.path) || stringValue(result.filePath) || stringValue(result.file);
    if (path) {
      push({
        type: "file",
        label: "File",
        value: path,
        extra: { operation: "delete" },
      });
    }
  }

  if (params.toolName === "run_command") {
    const command = stringValue(result.command);
    if (command) {
      push({
        type: "command",
        label: "Shell command",
        value: command,
        extra: { output: stringValue(result.stdout) || stringValue(result.output) },
      });
    }
  }

  if (params.toolName === "web_fetch") {
    const url = stringValue(result.url);
    if (url) {
      push({ type: "url", label: "Fetched URL", value: url });
    }
  }

  if (params.toolName === "web_search") {
    const results = Array.isArray(result.results) ? result.results : [];
    for (const item of results.slice(0, 3)) {
      const record = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
      const url = stringValue(record.url);
      const title = stringValue(record.title) || "Search result";
      if (url) {
        push({ type: "url", label: title, value: url });
      }
    }
  }

  const artifactPath =
    stringValue(result.path) || stringValue(result.filepath) || stringValue(result.filename);
  const artifactTool =
    params.toolName === "generate_image" ||
    params.toolName === "generate_video" ||
    params.toolName === "compile_latex" ||
    params.toolName === "generate_document" ||
    params.toolName === "generate_presentation" ||
    params.toolName === "generate_spreadsheet" ||
    params.toolName === "create_document" ||
    params.toolName === "create_presentation" ||
    params.toolName === "create_spreadsheet" ||
    params.toolName === "generate_epub" ||
    params.toolName === "generate_narration_audio";
  if (artifactTool && artifactPath) {
    push({
      type: "artifact",
      label: "Artifact",
      value: artifactPath,
      extra: { mimeType: stringValue(result.mimeType) },
    });
  }

  if (params.policyTrace) {
    const finalDecision = params.policyTrace.finalDecision;
    push({
      type: "runtime_log",
      label: "Policy",
      value: `final decision: ${finalDecision}`,
      extra: { source: params.policyTrace.toolName },
    });
  }

  return evidence;
}

export function buildToolResultEnvelope(
  params: BuildToolResultEnvelopeParams,
): ToolResultEnvelope {
  return {
    toolUseId: params.toolUseId,
    toolName: params.toolName,
    status: params.status,
    modelPayload: stringifyModelPayload(params),
    userSummary: buildUserSummary(params),
    structuredData: params.result,
    evidence: params.evidence || buildDefaultEvidence(params),
    retryable: Boolean(params.retryable),
    policyTrace: params.policyTrace,
    contextMutation: null,
    uiHints: params.uiHints,
    telemetry: params.telemetry,
  };
}
