import { describe, expect, it, vi } from "vitest";

import { ToolScheduler } from "../ToolScheduler";

describe("Hermes runtime fault injection", () => {
  it("completes a long read batch within the concurrency bound and preserves order", async () => {
    const scheduler = new ToolScheduler();
    let active = 0;
    let peak = 0;
    const calls = Array.from({ length: 32 }, (_, index) => ({
      index,
      toolUse: {
        type: "tool_use" as const,
        id: String(index),
        name: "read_file",
        input: { path: `task-${index}.txt` },
      },
    }));

    const outcome = await scheduler.executeBatch({
      calls,
      maxParallel: 4,
      prepareCall: async (call) => ({
        status: "scheduled" as const,
        call: {
          ...call,
          toolName: "read_file",
          input: call.toolUse.input,
          spec: { concurrencyClass: "read_parallel" as const, readOnly: true, idempotent: true },
          run: async () => {
            active += 1;
            peak = Math.max(peak, active);
            await new Promise((resolve) => setTimeout(resolve, 2));
            active -= 1;
            return { resultJson: call.toolUse.id };
          },
          finalize: async (raw) => ({
            toolResult: {
              type: "tool_result" as const,
              tool_use_id: call.toolUse.id,
              content: raw.resultJson || "",
            },
          }),
        },
      }),
    });

    expect(peak).toBeLessThanOrEqual(4);
    expect(outcome.toolResults.map((result) => result.content)).toEqual(
      calls.map((call) => String(call.index)),
    );
    expect(outcome.batches).toHaveLength(1);
    expect(outcome.batches[0]?.mode).toBe("parallel");
  });

  it("does not cache a failed read, so a retry can recover", async () => {
    const scheduler = new ToolScheduler();
    const run = vi.fn()
      .mockResolvedValueOnce({ error: new Error("transient read failure") })
      .mockResolvedValueOnce({ result: { content: "recovered" }, resultJson: "recovered" });
    const calls = [
      { index: 0, toolUse: { type: "tool_use" as const, id: "0", name: "read_file", input: { path: "task.txt" } } },
      { index: 1, toolUse: { type: "tool_use" as const, id: "1", name: "read_file", input: { path: "task.txt" } } },
    ];

    const outcome = await scheduler.executeBatch({
      calls,
      maxParallel: 2,
      prepareCall: async (call) => ({
        status: "scheduled" as const,
        call: {
          ...call,
          toolName: "read_file",
          input: call.toolUse.input,
          spec: { concurrencyClass: "read_parallel" as const, readOnly: true, idempotent: true },
          run,
          finalize: async (raw) => ({
            toolResult: {
              type: "tool_result" as const,
              tool_use_id: call.toolUse.id,
              content: raw.resultJson || "failed",
              ...(raw.error ? { is_error: true } : {}),
            },
          }),
        },
      }),
    });

    expect(run).toHaveBeenCalledTimes(2);
    expect(outcome.toolResults.map((result) => result.is_error)).toEqual([true, undefined]);
    expect(outcome.toolResults[1]?.content).toBe("recovered");
  });

  it("keeps side-effect calls serial even when the caller allows parallel work", async () => {
    const scheduler = new ToolScheduler();
    let active = 0;
    let peak = 0;
    const calls = Array.from({ length: 4 }, (_, index) => ({
      index,
      toolUse: { type: "tool_use" as const, id: String(index), name: "write_file", input: { path: `out-${index}.txt` } },
    }));

    const outcome = await scheduler.executeBatch({
      calls,
      maxParallel: 8,
      prepareCall: async (call) => ({
        status: "scheduled" as const,
        call: {
          ...call,
          toolName: "write_file",
          input: call.toolUse.input,
          spec: { concurrencyClass: "exclusive" as const, readOnly: false, idempotent: false },
          run: async () => {
            active += 1;
            peak = Math.max(peak, active);
            await new Promise((resolve) => setTimeout(resolve, 1));
            active -= 1;
            return { resultJson: call.toolUse.id };
          },
          finalize: async (raw) => ({
            toolResult: {
              type: "tool_result" as const,
              tool_use_id: call.toolUse.id,
              content: raw.resultJson || "",
            },
          }),
        },
      }),
    });

    expect(peak).toBe(1);
    expect(outcome.batches.map((batch) => batch.mode)).toEqual(["serial", "serial", "serial", "serial"]);
    expect(outcome.toolResults.map((result) => result.content)).toEqual(["0", "1", "2", "3"]);
  });
});
