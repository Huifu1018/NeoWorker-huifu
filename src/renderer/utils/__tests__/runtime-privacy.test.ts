import { describe, expect, it } from "vitest";
import type { TaskEvent } from "../../../shared/types";
import {
  isHermesRuntimeEvent,
  isHermesRuntimePayload,
  sanitizeHermesText,
  sanitizeRuntimeDisplayValue,
  sanitizeTaskEventForDisplay,
} from "../runtime-privacy";
import {
  filterProvidersForDisplay,
  sanitizeModelsForDisplay,
} from "../provider-privacy";

function event(overrides: Partial<TaskEvent> = {}): TaskEvent {
  return {
    id: "event-1",
    taskId: "task-1",
    timestamp: 1,
    type: "progress_update",
    payload: {},
    schemaVersion: 2,
    ...overrides,
  } as TaskEvent;
}

describe("runtime privacy display boundary", () => {
  it("removes the persisted Chinese translation runtime alias without hiding the error", () => {
    expect(sanitizeHermesText('请调用 office_translation（Hermes 中为 mcp_neoworker_office_translation），先传 action="inspect"。'))
      .toBe('请调用 office_translation，先传 action="inspect"。');
    expect(sanitizeHermesText("介绍 Hermes 品牌")).toBe("介绍 Hermes 品牌");
  });
  it("recognizes structured Hermes metadata without scanning user prose", () => {
    expect(
      isHermesRuntimePayload({
        runtimeAgent: "hermes",
        message: "Please explain Hermes to me.",
      }),
    ).toBe(true);
    expect(
      isHermesRuntimePayload({
        message: "Please explain Hermes to me.",
      }),
    ).toBe(false);
  });

  it("identifies pure runtime events while retaining substantive result events", () => {
    expect(
      isHermesRuntimeEvent(
        event({
          type: "progress_update",
          payload: { phase: "hermes_runtime", runtimeAgent: "hermes" },
        }),
      ),
    ).toBe(true);
    expect(
      isHermesRuntimeEvent(
        event({
          type: "task_completed",
          payload: {
            resultSummary: "The requested file is ready.",
            runtimeAgent: "hermes",
          },
        }),
      ),
    ).toBe(false);
    expect(
      isHermesRuntimeEvent(
        event({
          type: "hermes_runtime_transport" as TaskEvent["type"],
          payload: { message: "internal" },
        }),
      ),
    ).toBe(true);
  });

  it("normalizes persisted Hermes completion fallbacks", () => {
    expect(
      sanitizeHermesText(
        "Hermes Agent completed without a final assistant message.",
      ),
    ).toBe("Task completed without a final response.");
    expect(
      sanitizeHermesText(
        "Hermes Agent follow-up completed without a final assistant message.",
      ),
    ).toBe("Task completed without a final response.");
    expect(
      sanitizeHermesText("Hermes Agent resumed without a final assistant message."),
    ).toBe("Task completed without a final response.");
  });

  it("removes runtime metadata recursively while preserving the user's message", () => {
    const payload = {
      message: "I want to learn about Hermes.",
      runtime: "acpx",
      runtimeAgent: "hermes",
      harness: "hermes",
      errorCode: "HERMES_UNAVAILABLE",
      nested: {
        runtimeState: "active",
        runtimeAgent: "hermes",
        resultSummary: "The result is complete.",
      },
    };

    expect(sanitizeRuntimeDisplayValue(payload)).toEqual({
      message: "I want to learn about Hermes.",
      nested: {
        resultSummary: "The result is complete.",
      },
    });
  });

  it("returns null for telemetry and a sanitized copy for result events", () => {
    expect(
      sanitizeTaskEventForDisplay(
        event({
          payload: { phase: "runtime", runtimeAgent: "hermes" },
        }),
      ),
    ).toBeNull();

    const result = sanitizeTaskEventForDisplay(
      event({
        type: "task_completed",
        payload: {
          resultSummary: "The requested file is ready.",
          runtimeAgent: "hermes",
        },
      }),
    );
    expect(result?.payload).toEqual({
      resultSummary: "The requested file is ready.",
    });
  });

  it("keeps runtime failures visible with neutralized text", () => {
    const result = sanitizeTaskEventForDisplay(
      event({
        type: "follow_up_failed" as TaskEvent["type"],
        payload: {
          error: "Hermes ACP session/prompt timed out",
          errorCode: "HERMES_TIMEOUT",
          runtime: "acpx",
          runtimeAgent: "hermes",
        },
      }),
    );
    expect(result).not.toBeNull();
    expect(result?.payload).toEqual({
      error: "the execution service runtime session/prompt timed out",
    });
  });

  it("keeps hidden provider keys functional while neutralizing labels", () => {
    const providers = filterProvidersForDisplay([
      { type: "hermes", name: "Hermes Agent", configured: true },
      { type: "anthropic", name: "Claude", configured: true },
    ] as any, { keepSelectedType: "hermes" });
    expect(providers.map((provider) => provider.type)).toEqual([
      "hermes",
      "anthropic",
    ]);
    expect(providers[0].name).toBe("Configured provider");
    expect(
      sanitizeModelsForDisplay(
        [{ key: "hermes-agent", displayName: "Hermes Agent", description: "" }],
        "hermes",
      )[0],
    ).toMatchObject({ key: "hermes-agent", displayName: "Configured model" });
  });
});
