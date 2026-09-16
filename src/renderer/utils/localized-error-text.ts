import { getCurrentLanguage, translate } from "../i18n";

const ZH_EXACT_ERROR_KEYS: Record<string, [key: string, fallback: string]> = {
  "an error occurred": ["error.generic", "An error occurred"],
  "direct answer missing": [
    "error.directAnswerMissing",
    "Direct answer missing",
  ],
  error: ["common.error", "Error"],
  "execution evidence missing": [
    "error.executionEvidenceMissing",
    "Execution evidence missing",
  ],
  "output artifact missing": [
    "error.outputArtifactMissing",
    "Output artifact missing",
  ],
  "provider error": ["error.provider", "Provider error"],
  "required tool evidence missing": [
    "error.requiredToolEvidenceMissing",
    "Required tool evidence missing",
  ],
  "step failed": ["error.stepFailed", "Step failed"],
  "task encountered an error": [
    "error.taskEncountered",
    "Task encountered an error",
  ],
  "tool execution failed": [
    "error.tool.executionFailed",
    "Tool execution failed",
  ],
  "timeline error": ["error.timeline", "Timeline error"],
  "verification evidence missing": [
    "error.verificationEvidenceMissing",
    "Verification evidence missing",
  ],
  "invalid wechat service url": [
    "error.wechat.invalidServiceUrl",
    "Invalid WeChat service URL",
  ],
  "wechat service did not return a login qr code": [
    "error.wechat.missingLoginQrCode",
    "WeChat service did not return a login QR code",
  ],
  "qr code identifier is required": [
    "error.wechat.qrCodeRequired",
    "QR code identifier is required",
  ],
  "invalid wechat media aes key": [
    "error.wechat.invalidMediaKey",
    "Invalid WeChat media AES key",
  ],
  "invalid wechat media download url": [
    "error.wechat.invalidMediaUrl",
    "Invalid WeChat media download URL",
  ],
  "wechat media message is missing a download url": [
    "error.wechat.missingMediaUrl",
    "WeChat media message is missing a download URL",
  ],
  "wechat login information is incomplete scan the qr code again": [
    "error.wechat.incompleteLogin",
    "WeChat login information is incomplete. Scan the QR code again.",
  ],
  "send a message to the assistant from wechat before replying": [
    "error.wechat.messageFirst",
    "Send a message to the assistant from WeChat before replying.",
  ],
  "wechat login has expired scan the qr code to reconnect": [
    "error.wechat.loginExpired",
    "WeChat login has expired. Scan the QR code to reconnect.",
  ],
  "wechat file is missing a decryption key": [
    "error.wechat.fileKeyMissing",
    "WeChat file is missing a decryption key",
  ],
  "wechat video is missing a decryption key": [
    "error.wechat.videoKeyMissing",
    "WeChat video is missing a decryption key",
  ],
  "wechat voice message is missing a decryption key": [
    "error.wechat.voiceKeyMissing",
    "WeChat voice message is missing a decryption key",
  ],
  "a wechat channel is already configured disconnect or remove the existing connection first":
    [
      "error.wechat.alreadyConfigured",
      "A WeChat channel is already configured. Disconnect or remove the existing connection first.",
    ],
  "no project is available to archive": [
    "error.project.noArchiveTarget",
    "No project is available to archive.",
  ],
  "at least one worksheet is required": [
    "error.office.worksheetRequired",
    "At least one worksheet is required.",
  ],
  "at least one slide is required": [
    "error.office.slideRequired",
    "At least one slide is required.",
  ],
  "multi-format office requests require one shared contentsnapshot before generating docx pptx or xlsx":
    [
      "error.office.sharedContentSnapshotRequired",
      "Multi-format Office requests require one shared contentSnapshot before generating DOCX, PPTX, or XLSX.",
    ],
  "preferred execution service unavailable automatic fallback is unavailable": [
    "error.executionService.preferredUnavailableNoFallback",
    "Preferred execution service unavailable; automatic fallback is unavailable.",
  ],
  "preferred execution service unavailable continuing with available execution":
    [
      "error.executionService.preferredUnavailableFallback",
      "Preferred execution service unavailable; continuing with available execution.",
    ],
  "preferred execution service unavailable for follow-up continuing with available execution":
    [
      "error.executionService.preferredUnavailableFallback",
      "Preferred execution service unavailable; continuing with available execution.",
    ],
  "task completed without a final response": [
    "error.taskCompletedWithoutFinalResponse",
    "Task completed without a final response.",
  ],
  "task execution service unavailable automatic fallback is disabled for this task":
    [
      "error.executionService.unavailableNoFallback",
      "Task execution service unavailable. Automatic fallback is disabled for this task.",
    ],
  "task execution service unavailable for follow-up automatic fallback is disabled for this task":
    [
      "error.executionService.unavailableNoFallback",
      "Task execution service unavailable. Automatic fallback is disabled for this task.",
    ],
  "the task execution service encountered an error this turn has ended and your context was preserved please try again":
    [
      "error.executionService.turnFailed",
      "The task execution service encountered an error. This turn has ended and your context was preserved. Please try again.",
    ],
};

function canonicalizeErrorText(text: string): string {
  return text
    .trim()
    .replace(/[.。,:;；，!?！？]+/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .trim();
}

/**
 * Localize stable, app-authored errors and common tool validation failures.
 * Unknown provider diagnostics remain untouched, while persisted task errors
 * update immediately when the user changes UI language.
 */
export function localizeErrorText(text: string): string {
  if (getCurrentLanguage() !== "zh-CN") return text;

  const trimmed = String(text || "").trim();
  if (!trimmed) return text;

  if (/^\[object Object\]$/i.test(trimmed)) {
    return translate("error.tool.executionFailed", "Tool execution failed.");
  }

  const exact = ZH_EXACT_ERROR_KEYS[canonicalizeErrorText(trimmed)];
  if (exact) return translate(exact[0], exact[1]);

  let match = trimmed.match(/^Command exited with code\s+(\d+)\.?$/i);
  if (match) {
    return translate(
      "error.tool.commandExitCode",
      "Command exited with code {code}.",
      { code: match[1] },
    );
  }

  match = trimmed.match(
    /^Iteration limit exceeded:\s*([\d,]+)\/([\d,]+) iterations?\.\s*Task stopped to prevent runaway execution\.?$/i,
  );
  if (match) {
    return translate("error.iterationLimitExceeded", trimmed, {
      used: match[1],
      limit: match[2],
    });
  }

  match = trimmed.match(
    /^Lifetime turn limit exceeded:\s*([\d,]+)\/([\d,]+) turns?\.\s*Task stopped to prevent runaway execution\.?$/i,
  );
  if (match) {
    return translate("error.lifetimeTurnLimitExceeded", trimmed, {
      used: match[1],
      limit: match[2],
    });
  }

  match = trimmed.match(
    /^Global turn limit exceeded:\s*([\d,]+)\/([\d,]+) turns?\.\s*Task stopped to prevent infinite loops\.\s*Consider breaking this task into smaller parts\.?$/i,
  );
  if (match) {
    return translate("error.globalTurnLimitExceeded", trimmed, {
      used: match[1],
      limit: match[2],
    });
  }

  match = trimmed.match(
    /^Emergency turn fuse exceeded:\s*([\d,]+)\/([\d,]+) turns?\.\s*Task stopped by safety policy to prevent runaway execution\.?$/i,
  );
  if (match) {
    return translate("error.emergencyTurnFuseExceeded", trimmed, {
      used: match[1],
      limit: match[2],
    });
  }

  match = trimmed.match(
    /^Token budget exceeded:\s*([\d,]+)\/([\d,]+) tokens?\.\s*Estimated cost:\s*(.+)$/i,
  );
  if (match) {
    return translate("error.tokenBudgetExceeded", trimmed, {
      used: match[1],
      limit: match[2],
      cost: match[3],
    });
  }

  match = trimmed.match(
    /^Cost budget exceeded:\s*(.+?)\/(.+?)\.\s*Total tokens used:\s*([\d,]+)\.?$/i,
  );
  if (match) {
    return translate("error.costBudgetExceeded", trimmed, {
      used: match[1],
      limit: match[2],
      tokens: match[3],
    });
  }

  if (/^Rate limit exceeded\. Will retry automatically\.?$/i.test(trimmed)) {
    return translate("error.rateLimit.autoRetry", trimmed);
  }
  if (/^Rate limit exceeded\. Free tier has strict limits\b/i.test(trimmed)) {
    return translate("error.rateLimit.freeTier", trimmed);
  }
  if (/^Rate limit exceeded\. Wait a minute and try again\b/i.test(trimmed)) {
    return translate("error.rateLimit.tryAgain", trimmed);
  }

  if (/^net::ERR_CONNECTION_CLOSED$/i.test(trimmed)) {
    return translate("error.web.connectionClosed", trimmed);
  }

  match = trimmed.match(/^HTTP\s+(\d{3})(?::.*)?$/i);
  if (match) {
    return translate("error.web.httpStatus", trimmed, {
      status: match[1],
    });
  }

  match = trimmed.match(
    /^Tool\s+["']?([^"']+?)["']?\s+blocked by policy:\s*Workspace shell capability is disabled\.?$/i,
  );
  if (match) {
    return translate("error.tool.workspaceShellDisabled", trimmed, {
      tool: match[1].trim(),
    });
  }

  match = trimmed.match(
    /^Tool\s+["']?([^"']+?)["']?\s+timed out after\s*([\d.]+)\s*(ms|s|seconds?|minutes?)\.?$/i,
  );
  if (match) {
    const unit = match[3].toLowerCase();
    const duration =
      unit === "ms"
        ? `${match[2]} 毫秒`
        : unit.startsWith("minute")
          ? `${match[2]} 分钟`
          : `${match[2]} 秒`;
    return translate("error.tool.timedOut", trimmed, {
      tool: match[1].trim(),
      duration,
    });
  }

  match = trimmed.match(/^Unsupported presentation field at\s+(.+)\.?$/i);
  if (match) {
    return translate("error.office.unsupportedPresentationField", trimmed, {
      field: match[1].replace(/\.$/, ""),
    });
  }

  match = trimmed.match(
    /^Completion blocked:\s*requested output was not generated\s*\(([^)]+)\)\.?$/i,
  );
  if (match) {
    return translate("error.output.requestedFormatMissing", trimmed, {
      formats: match[1],
    });
  }

  match = trimmed.match(/^WeChat attachment exceeds the (\d+)MB limit\.?$/i);
  if (match) {
    return translate("error.wechat.attachmentTooLarge", trimmed, {
      limit: match[1],
    });
  }

  match = trimmed.match(
    /^WeChat (service request|media download) failed \((.+)\)\.?$/i,
  );
  if (match) {
    return translate(
      match[1].toLowerCase() === "service request"
        ? "error.wechat.serviceRequestFailed"
        : "error.wechat.mediaDownloadFailed",
      trimmed,
      { status: match[2] },
    );
  }

  match = trimmed.match(
    /^Failed to (send|sync) WeChat messages? \((.+)\)\.?$/i,
  );
  if (match) {
    return translate(
      match[1].toLowerCase() === "send"
        ? "error.wechat.sendFailed"
        : "error.wechat.syncFailed",
      trimmed,
      { status: match[2] },
    );
  }

  match = trimmed.match(/^Task execution failed:\s*(.+)$/is);
  if (match) {
    return translate("error.taskExecutionFailed", trimmed, {
      error: localizeErrorText(match[1]),
    });
  }

  match = trimmed.match(/^Error:\s*(.+)$/is);
  if (match) {
    return translate("error.withDetails", trimmed, {
      error: localizeErrorText(match[1]),
    });
  }

  return text;
}
