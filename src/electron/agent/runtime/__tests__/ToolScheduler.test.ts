import { describe, expect, it, vi } from "vitest";

import { ToolScheduler } from "../ToolScheduler";

describe("ToolScheduler", () => {
  it("batches consecutive read_parallel calls and preserves result order", async () => {
    const scheduler = new ToolScheduler();
    const finalizeOrder: string[] = [];

    const outcome = await scheduler.executeBatch({
      calls: [
        {
          index: 0,
          toolUse: { type: "tool_use", id: "1", name: "read_file", input: {} },
        },
        {
          index: 1,
          toolUse: { type: "tool_use", id: "2", name: "glob", input: {} },
        },
      ],
      maxParallel: 2,
      prepareCall: async (call) => ({
        status: "scheduled",
        call: {
          ...call,
          toolName: call.toolUse.name,
          input: call.toolUse.input,
          spec: {
            concurrencyClass: "read_parallel",
            readOnly: true,
            idempotent: true,
          },
          run: async () => {
            if (call.toolUse.id === "1") {
              await new Promise((resolve) => setTimeout(resolve, 20));
            }
            return {
              result: { ok: call.toolUse.id },
              resultJson: JSON.stringify({ ok: call.toolUse.id }),
            };
          },
          finalize: async (rawOutcome) => {
            finalizeOrder.push(call.toolUse.id);
            return {
              toolResult: {
                type: "tool_result",
                tool_use_id: call.toolUse.id,
                content: rawOutcome.resultJson || "",
              },
            };
          },
        },
      }),
    });

    expect(outcome.batches).toHaveLength(1);
    expect(outcome.batches[0]?.mode).toBe("parallel");
    expect(finalizeOrder).toEqual(["1", "2"]);
    expect(outcome.toolResults.map((entry) => entry.tool_use_id)).toEqual(["1", "2"]);
  });

  it("splits read and write calls into separate batches", async () => {
    const scheduler = new ToolScheduler();

    const outcome = await scheduler.executeBatch({
      calls: [
        {
          index: 0,
          toolUse: { type: "tool_use", id: "1", name: "read_file", input: {} },
        },
        {
          index: 1,
          toolUse: { type: "tool_use", id: "2", name: "write_file", input: {} },
        },
      ],
      prepareCall: async (call) => ({
        status: "scheduled",
        call: {
          ...call,
          toolName: call.toolUse.name,
          input: call.toolUse.input,
          spec:
            call.toolUse.name === "read_file"
              ? {
                  concurrencyClass: "read_parallel",
                  readOnly: true,
                  idempotent: true,
                }
              : {
                  concurrencyClass: "exclusive",
                  readOnly: false,
                  idempotent: false,
                },
          run: async () => ({
            resultJson: JSON.stringify({ ok: call.toolUse.id }),
          }),
          finalize: async (rawOutcome) => ({
            toolResult: {
              type: "tool_result",
              tool_use_id: call.toolUse.id,
              content: rawOutcome.resultJson || "",
            },
          }),
        },
      }),
    });

    expect(outcome.batches).toHaveLength(2);
    expect(outcome.batches.map((batch) => batch.mode)).toEqual(["parallel", "serial"]);
  });

  it("runs post execution effects in model order after parallel completion", async () => {
    const scheduler = new ToolScheduler();
    const effectOrder: string[] = [];
    const effectSpy = vi.fn((toolName: string) => effectOrder.push(toolName));

    await scheduler.executeBatch({
      calls: [
        {
          index: 0,
          toolUse: { type: "tool_use", id: "1", name: "read_file", input: {} },
        },
        {
          index: 1,
          toolUse: { type: "tool_use", id: "2", name: "read_file", input: {} },
        },
      ],
      maxParallel: 2,
      prepareCall: async (call) => ({
        status: "scheduled",
        call: {
          ...call,
          toolName: call.toolUse.name,
          input: call.toolUse.input,
          spec: {
            concurrencyClass: "read_parallel",
            readOnly: true,
            idempotent: true,
            postExecutionEffect: async ({ toolName }) => {
              effectSpy(toolName);
            },
          },
          run: async () => {
            if (call.toolUse.id === "1") {
              await new Promise((resolve) => setTimeout(resolve, 20));
            }
            return { resultJson: call.toolUse.id };
          },
          finalize: async (rawOutcome) => ({
            toolResult: {
              type: "tool_result",
              tool_use_id: call.toolUse.id,
              content: String(rawOutcome.resultJson || ""),
            },
          }),
        },
      }),
    });

    expect(effectSpy).toHaveBeenCalledTimes(2);
    expect(effectOrder).toEqual(["read_file", "read_file"]);
  });

  it("reuses one successful result for duplicate idempotent reads", async () => {
    const scheduler = new ToolScheduler();
    const runSpy = vi.fn(async () => ({ result: { value: "same" }, resultJson: "same" }));
    const cacheHitSpy = vi.fn();

    const outcome = await scheduler.executeBatch({
      calls: [
        { index: 0, toolUse: { type: "tool_use", id: "1", name: "read_file", input: { path: "a.txt" } } },
        { index: 1, toolUse: { type: "tool_use", id: "2", name: "read_file", input: { path: "a.txt" } } },
      ],
      maxParallel: 2,
      onCacheHit: cacheHitSpy,
      prepareCall: async (call) => ({
        status: "scheduled",
        call: {
          ...call,
          toolName: call.toolUse.name,
          input: call.toolUse.input,
          spec: { concurrencyClass: "read_parallel", readOnly: true, idempotent: true },
          run: runSpy,
          finalize: async (rawOutcome) => ({
            toolResult: {
              type: "tool_result",
              tool_use_id: call.toolUse.id,
              content: String(rawOutcome.resultJson || ""),
            },
            metadata: rawOutcome.metadata,
          }),
        },
      }),
    });

    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(cacheHitSpy).toHaveBeenCalledTimes(1);
    expect(cacheHitSpy.mock.calls[0]?.[0].toolUse.id).toBe("2");
    expect(outcome.toolResults.map((result) => result.tool_use_id)).toEqual(["1", "2"]);
    expect(outcome.callReports[1]?.metadata).toEqual({ cacheHit: true });
  });

  it("marks queued calls cancelled instead of launching them after cancellation", async () => {
    const scheduler = new ToolScheduler();
    let keepRunning = true;
    const runSpy = vi.fn(async (id: string) => {
      if (id === "1") {
        keepRunning = false;
      }
      return { resultJson: id };
    });
    const finalized: Array<{ id: string; cancelled: boolean }> = [];

    const outcome = await scheduler.executeBatch({
      calls: [
        {
          index: 0,
          toolUse: { type: "tool_use", id: "1", name: "generate_image", input: {} },
        },
        {
          index: 1,
          toolUse: { type: "tool_use", id: "2", name: "generate_image", input: {} },
        },
      ],
      maxParallel: 1,
      shouldContinue: () => keepRunning,
      prepareCall: async (call) => ({
        status: "scheduled",
        call: {
          ...call,
          toolName: call.toolUse.name,
          input: call.toolUse.input,
          spec: {
            concurrencyClass: "side_effect_parallel",
            readOnly: false,
            idempotent: true,
          },
          run: async () => runSpy(call.toolUse.id),
          finalize: async (rawOutcome) => {
            finalized.push({
              id: call.toolUse.id,
              cancelled: rawOutcome.metadata?.cancelled === true,
            });
            return {
              toolResult: {
                type: "tool_result",
                tool_use_id: call.toolUse.id,
                content: rawOutcome.metadata?.cancelled === true ? "cancelled" : "ok",
                is_error: rawOutcome.metadata?.cancelled === true,
              },
            };
          },
        },
      }),
    });

    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(runSpy).toHaveBeenCalledWith("1");
    expect(finalized).toEqual([
      { id: "1", cancelled: false },
      { id: "2", cancelled: true },
    ]);
    expect(outcome.toolResults.map((entry) => entry.tool_use_id)).toEqual(["1", "2"]);
    expect(outcome.toolResults[1]?.is_error).toBe(true);
  });

  it("invalidates cached reads across a mutation", async () => {
    const scheduler = new ToolScheduler();
    let file = "before";
    const reads = vi.fn(() => file);
    const outcome = await scheduler.executeBatch({
      calls: ["read_file", "write_file", "read_file"].map((name, index) => ({
        index,
        toolUse: { type: "tool_use" as const, id: String(index), name, input: { path: "a.txt" } },
      })),
      prepareCall: (call) => ({
        status: "scheduled",
        call: {
          ...call,
          toolName: call.toolUse.name,
          input: call.toolUse.input,
          spec: call.toolUse.name === "read_file"
            ? { concurrencyClass: "read_parallel", readOnly: true, idempotent: true }
            : { concurrencyClass: "exclusive", readOnly: false, idempotent: false },
          run: async () => {
            if (call.toolUse.name === "write_file") {
              file = "after";
              return { resultJson: "written" };
            }
            return { resultJson: reads() };
          },
          finalize: (raw) => ({ toolResult: {
            type: "tool_result", tool_use_id: call.toolUse.id, content: raw.resultJson || "",
          } }),
        },
      }),
    });
    expect(reads).toHaveBeenCalledTimes(2);
    expect(outcome.toolResults.map((result) => result.content)).toEqual(["before", "written", "after"]);
  });
});
