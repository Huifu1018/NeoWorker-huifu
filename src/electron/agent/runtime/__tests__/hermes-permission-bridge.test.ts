import { describe, expect, it, vi } from "vitest";
import { createHermesPermissionHandler, HermesPermissionBridge } from "../hermes-permission-bridge";

const request = () => ({
  sessionId: "s1",
  toolCall: { toolCallId: "call-1", title: "Write file", rawInput: { path: "C:\\工作区\\a.txt" } },
  options: [
    { optionId: "yes", kind: "allow_once", name: "Allow once" },
    { optionId: "no", kind: "reject_once", name: "Reject once" },
  ],
});
const context = () => ({ signal: new AbortController().signal });
const cancelled = { outcome: { outcome: "cancelled" } };

describe("Hermes permission mediation", () => {
  it.each(["yes", "no"])("returns the selected option %s and preserves operation details", async (optionId) => {
    const handler = vi.fn(async () => optionId);
    expect(await new HermesPermissionBridge(handler).request(request(), "s1", context()))
      .toEqual({ outcome: { outcome: "selected", optionId } });
    expect(handler.mock.calls[0][0]).toEqual(request());
  });
  it("never opens approval for a foreign or inactive session", async () => {
    const handler = vi.fn(async () => "yes");
    const bridge = new HermesPermissionBridge(handler);
    expect(await bridge.request(request(), "other", context())).toEqual(cancelled);
    expect(await bridge.request(request(), undefined, context())).toEqual(cancelled);
    expect(handler).not.toHaveBeenCalled();
  });
  it("denies malformed and duplicate option IDs before invoking the host", async () => {
    const handler = vi.fn(async () => "yes");
    const bridge = new HermesPermissionBridge(handler);
    const payload = request();
    payload.options.push({ ...payload.options[0] });
    expect(await bridge.request(payload, "s1", context())).toEqual(cancelled);
    expect(await bridge.request({ ...request(), toolCall: {} }, "s1", context())).toEqual(cancelled);
    expect(handler).not.toHaveBeenCalled();
  });
  it("denies missing handlers, unknown selections and host failures", async () => {
    expect(await new HermesPermissionBridge().request(request(), "s1", context())).toEqual(cancelled);
    expect(await new HermesPermissionBridge(async () => "invented").request(request(), "s1", context())).toEqual(cancelled);
    expect(await new HermesPermissionBridge(async () => { throw new Error("UI closed"); }).request(request(), "s1", context())).toEqual(cancelled);
  });
  it("times out a host that never responds and signals it to close the dialog", async () => {
    let signal: AbortSignal | undefined;
    const bridge = new HermesPermissionBridge(async (_, ctx) => {
      signal = ctx.signal;
      return new Promise(() => {});
    }, 20);
    expect(await bridge.request(request(), "s1", context())).toEqual(cancelled);
    expect(signal?.aborted).toBe(true);
  });
  it("cancels pending approvals without waiting for a late allow response", async () => {
    let allow!: (id: string) => void;
    const bridge = new HermesPermissionBridge(() => new Promise(resolve => { allow = resolve; }));
    const pending = bridge.request(request(), "s1", context());
    await Promise.resolve();
    bridge.cancelPending();
    allow("yes");
    expect(await pending).toEqual(cancelled);
    // Cancellation does not poison the next explicit turn.
    const next = bridge.request(request(), "s1", context());
    await Promise.resolve();
    allow("yes");
    expect(await next).toEqual({ outcome: { outcome: "selected", optionId: "yes" } });
  });
  it("propagates transport closure to the pending host approval", async () => {
    const controller = new AbortController();
    const bridge = new HermesPermissionBridge(() => new Promise(() => {}));
    const pending = bridge.request(request(), "s1", { signal: controller.signal });
    controller.abort();
    expect(await pending).toEqual(cancelled);
  });
  it("adapts NeoWorker boolean approval to a safe allow option", async () => {
    const approval = vi.fn(async () => true);
    const handler = createHermesPermissionHandler(approval, "task-1");
    expect(await handler({ ...request(), sessionId: "s1" }, context())).toBe("yes");
    expect(approval).toHaveBeenCalledWith("task-1", "hermes_tool", "Write file", expect.objectContaining({ hermesSessionId: "s1" }), { allowAutoApprove: true });
  });
});
