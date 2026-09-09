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

// Bound the model projection without changing structuredData. Persistence and
// retention of the full result are the caller's responsibility.
const MAX_MODEL_PAYLOAD_CHARS = 200_000;
const MODEL_PAYLOAD_TRUNCATION_MARKER = "\n[Tool result truncated by NeoWorker]\n";

function truncateText(text: string, retained: number, tail: boolean): string {
  if (text.length <= retained) return text;
  // Avoid cutting a UTF-16 surrogate pair in half, including in plain text.
  let boundary = tail ? text.length - retained : retained;
  if (boundary > 0 && boundary < text.length &&
      /[\uD800-\uDBFF]/.test(text[boundary - 1]) && /[\uDC00-\uDFFF]/.test(text[boundary])) {
    boundary += tail ? 1 : -1;
  }
  return tail
    ? MODEL_PAYLOAD_TRUNCATION_MARKER + text.slice(boundary)
    : text.slice(0, boundary) + MODEL_PAYLOAD_TRUNCATION_MARKER;
}

function boundModelPayload(payload: string, params: BuildToolResultEnvelopeParams, reminder: string): string {
  if (payload.length <= MAX_MODEL_PAYLOAD_CHARS) return payload;
  const shell = params.toolName === 'run_command';
  if (typeof params.result === 'string' && !params.error && !reminder) {
    return truncateText(payload, MAX_MODEL_PAYLOAD_CHARS - MODEL_PAYLOAD_TRUNCATION_MARKER.length, shell);
  }

  const parsed = JSON.parse(payload);
  const record = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  const base: Record<string, unknown> = {
    truncated: true,
    originalChars: payload.length,
    _truncation: MODEL_PAYLOAD_TRUNCATION_MARKER.trim(),
  };
  if (reminder) base._modelReminder = truncateText(reminder, 8_000, false);
  const fields: Record<string, string> = {};
  if (params.error) {
    fields.error = String(record.error ?? 'Tool execution failed');
  } else if (shell && ['stdout', 'stderr', 'output'].some(key => typeof record[key] === 'string')) {
    // Keep the diagnostic end of build logs and each stream separately; status
    // must remain visible even if stdout consumed most of the original result.
    for (const key of ['exitCode', 'success', 'killed', 'timedOut', 'terminationReason', 'signal']) {
      const value = record[key];
      if (typeof value === 'boolean' || typeof value === 'number' || value === null) base[key] = value;
      else if (typeof value === 'string') base[key] = truncateText(value, 256, false);
    }
    for (const key of ['stdout', 'stderr', 'output']) {
      if (typeof record[key] === 'string') fields[key] = record[key];
    }
    if (typeof record.command === 'string') base.command = truncateText(record.command, 4_000, false);
  } else {
    fields.content = typeof params.result === 'string' ? params.result : payload;
    base.contentFormat = typeof params.result === 'string' ? 'text' : 'json_preview';
  }

  const serialize = (retained: number): string => JSON.stringify({
    ...base,
    ...Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, truncateText(value, retained, shell)])),
  });
  // Escaping can expand each source character by up to six characters. Measure
  // the actual serialized envelope instead of guessing JSON wrapper overhead.
  let low = 0;
  let high = MAX_MODEL_PAYLOAD_CHARS;
  let best = serialize(0);
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = serialize(mid);
    if (candidate.length <= MAX_MODEL_PAYLOAD_CHARS) {
      best = candidate;
      low = mid + 1;
    } else high = mid - 1;
  }
  return best;
}

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
  return boundModelPayload(payload, params, reminder);
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
