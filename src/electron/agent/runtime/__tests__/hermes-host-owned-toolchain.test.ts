import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";

const sandboxMocks = vi.hoisted(() => ({
  createSandbox: vi.fn(),
  executions: [] as Array<{
    command: string;
    cwd?: string;
    allowNetwork?: boolean;
  }>,
}));

vi.mock("../../sandbox/sandbox-factory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../sandbox/sandbox-factory")>();
  return {
    ...actual,
    createSandbox: sandboxMocks.createSandbox,
  };
});

vi.mock("../../../admin/policies", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../admin/policies")>();
  return {
    ...actual,
    loadPolicies: vi.fn(() => {
      const policies = actual.loadPolicies();
      return {
        ...policies,
        runtime: {
          ...policies.runtime,
          allowedSandboxTypes: ["macos", "docker", "windows-restricted"],
          requireSandboxForShell: true,
          allowUnsandboxedShell: false,
          network: {
            ...policies.runtime.network,
            allowShellNetwork: false,
          },
        },
      };
    }),
  };
});

vi.mock("../../tools/mention-tools", () => ({
  MentionTools: class {
    static getToolDefinitions = vi.fn(() => []);
    listAgentRoles = vi.fn(async () => ({ agents: [] }));
    mentionAgent = vi.fn(async () => ({ success: true }));
    getPendingMentions = vi.fn(async () => ({ mentions: [] }));
    acknowledgeMention = vi.fn(async () => ({ success: true }));
    completeMention = vi.fn(async () => ({ success: true }));
    setContext = vi.fn();
  },
}));

import type { Workspace } from "../../../../shared/types";
import { GuardrailManager } from "../../../guardrails/guardrail-manager";
import { BuiltinToolsSettingsManager } from "../../tools/builtin-settings";
import { ToolRegistry } from "../../tools/registry";
import {
  HermesRuntimeAdapter,
  type HermesSessionCheckpoint,
} from "../hermes-runtime-adapter";
import { ToolExecutionCoordinator } from "../ToolExecutionCoordinator";
import {
  createToolHostRequest,
  NeoWorkerToolHost,
} from "../tool-host-protocol";

const fixture = path.join(__dirname, "fixtures", "hermes-acp-fixture.cjs");

function createLocalSandbox(workspace: Workspace) {
  return {
    type: "macos" as const,
    initialize: vi.fn(async () => undefined),
    cleanup: vi.fn(),
    execute: vi.fn(
      (
        command: string,
        _args: string[] = [],
        options: {
          cwd?: string;
          timeout?: number;
          allowNetwork?: boolean;
          env?: Record<string, string>;
          onProcess?: (child: ReturnType<typeof spawn>) => void;
        } = {},
      ) =>
        new Promise((resolve) => {
          sandboxMocks.executions.push({
            command,
            cwd: options.cwd,
            allowNetwork: options.allowNetwork,
          });
          const shell = process.platform === "win32"
            ? process.env.ComSpec || "cmd.exe"
            : "/bin/sh";
          const shellArgs = process.platform === "win32"
            ? ["/d", "/s", "/c", command]
            : ["-c", command];
          const child = spawn(shell, shellArgs, {
            cwd: options.cwd || workspace.path,
            env: { ...process.env, ...options.env },
            stdio: ["ignore", "pipe", "pipe"],
          });
          options.onProcess?.(child);
          let stdout = "";
          let stderr = "";
          let settled = false;
          const finish = (result: {
            exitCode: number;
            stdout: string;
            stderr: string;
            killed: boolean;
            timedOut: boolean;
            error?: string;
          }) => {
            if (settled) return;
            settled = true;
            resolve(result);
          };
          const timeout = setTimeout(() => {
            child.kill("SIGTERM");
            finish({
              exitCode: 1,
              stdout,
              stderr,
              killed: true,
              timedOut: true,
              error: "Command timed out",
            });
          }, options.timeout ?? 5_000);
          child.stdout?.on("data", (chunk: Buffer) => {
            stdout += chunk.toString("utf8");
          });
          child.stderr?.on("data", (chunk: Buffer) => {
            stderr += chunk.toString("utf8");
          });
          child.once("error", (error) => {
            clearTimeout(timeout);
            finish({
              exitCode: 1,
              stdout,
              stderr: error.message,
              killed: false,
              timedOut: false,
              error: error.message,
            });
          });
          child.once("close", (code, signal) => {
            clearTimeout(timeout);
            finish({
              exitCode: code ?? 1,
              stdout,
              stderr,
              killed: false,
              timedOut: false,
              ...(signal ? { error: `Process terminated by signal ${signal}` } : {}),
            });
          });
        }),
    ),
    executeCode: vi.fn(),
  };
}

type HostHarness = {
  runtime: HermesRuntimeAdapter;
  workspacePath: string;
  daemon: Any;
  events: Array<{ taskId?: string; type: string; payload?: Any }>;
  approvalStarted: Promise<void>;
  releaseApproval: (approved: boolean) => void;
};

const runtimes: HermesRuntimeAdapter[] = [];
const workspaces: string[] = [];

async function createHostHarness(options: {
  approval?: boolean;
  pendingApproval?: boolean;
  checkpoint?: Omit<HermesSessionCheckpoint, "cwd">;
} = {}): Promise<HostHarness> {
  const workspacePath = await mkdtemp(
    path.join(os.tmpdir(), "neoworker-hermes-toolchain-"),
  );
  const workspace: Workspace = {
    id: "workspace-hermes-e2e",
    name: "Hermes E2E",
    path: workspacePath,
    createdAt: Date.now(),
    permissions: {
      read: true,
      write: true,
      delete: false,
      network: false,
      shell: true,
      sandboxType: "macos",
    },
  };
  const events: Array<{ taskId?: string; type: string; payload?: Any }> = [];
  let approvalStartedResolve!: () => void;
  const approvalStarted = new Promise<void>((resolve) => {
    approvalStartedResolve = resolve;
  });
  let releaseApproval!: (approved: boolean) => void;
  const pendingApproval = new Promise<boolean>((resolve) => {
    releaseApproval = resolve;
  });
  const daemon = {
    requestApproval: vi.fn(async () => {
      approvalStartedResolve();
      return options.pendingApproval
        ? pendingApproval
        : options.approval ?? true;
    }),
    logEvent: vi.fn((taskId: string, type: string, payload?: Any) => {
      events.push({ taskId, type, payload });
    }),
    registerArtifact: vi.fn(),
  } as Any;

  sandboxMocks.createSandbox.mockImplementation(async () =>
    createLocalSandbox(workspace),
  );
  vi.spyOn(GuardrailManager, "isCommandBlocked").mockReturnValue({
    blocked: false,
  });
  vi.spyOn(GuardrailManager, "isCommandTrusted").mockReturnValue({
    trusted: false,
  });
  vi.spyOn(BuiltinToolsSettingsManager, "getToolAutoApprove").mockReturnValue(
    false,
  );
  vi.spyOn(BuiltinToolsSettingsManager, "getRunCommandApprovalMode").mockReturnValue(
    "per_command",
  );

  const registry = new ToolRegistry(workspace, daemon, "task-hermes-e2e");
  const coordinator = new ToolExecutionCoordinator(registry);
  const host = new NeoWorkerToolHost(coordinator);
  const runtime = new HermesRuntimeAdapter({
    command: process.execPath,
    args: [fixture],
    cwd: workspacePath,
    timeoutMs: 5_000,
    ...(options.checkpoint
      ? {
          checkpoint: {
            ...options.checkpoint,
            cwd: workspacePath,
          },
        }
      : {}),
    hostToolBridge: {
      taskId: "task-hermes-e2e",
      requestTimeoutMs: 5_000,
      getTools: () =>
        registry
          .getTools()
          .filter((tool) => tool.name === "write_file" || tool.name === "run_command"),
      execute: async ({ toolName, toolCallId, input, signal }) => {
        const execution = await host.execute(
          createToolHostRequest({
            taskId: "task-hermes-e2e",
            toolName,
            toolCallId,
            input,
          }),
          {
            taskId: "task-hermes-e2e",
            phase: "step",
            signal,
            emitEvent: (type, payload) => {
              events.push({ taskId: "task-hermes-e2e", type, payload });
            },
            beginHeartbeat: () => undefined,
            timeoutMsResolver: (name) => (name === "run_command" ? 5_000 : 2_000),
          },
        );
        return execution.response;
      },
    },
  });
  runtimes.push(runtime);
  workspaces.push(workspacePath);

  return {
    runtime,
    workspacePath,
    daemon,
    events,
    approvalStarted,
    releaseApproval,
  };
}

describe("Hermes host-owned NeoWorker toolchain", () => {
  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
    await Promise.all(
      workspaces.splice(0).map((workspace) =>
        rm(workspace, { recursive: true, force: true }),
      ),
    );
    sandboxMocks.createSandbox.mockReset();
    sandboxMocks.executions.length = 0;
    vi.restoreAllMocks();
  });

  it("routes ACP file and shell calls through real registry, approval, sandbox, and lifecycle logs", async () => {
    const { runtime, workspacePath, daemon, events } = await createHostHarness();
    const result = await runtime.prompt("host-multi-tool");
    const outputPath = path.join(workspacePath, "hermes-host.txt");
    expect(await readFile(outputPath, "utf8")).toBe("hello from Hermes");
    expect(result).toMatchObject({
      stopReason: "end_turn",
      sessionId: "fixture-session",
    });

    expect(daemon.requestApproval).toHaveBeenCalledTimes(1);
    expect(daemon.requestApproval).toHaveBeenCalledWith(
      "task-hermes-e2e",
      "run_command",
      expect.any(String),
      expect.objectContaining({
        command: expect.stringContaining("hello from Hermes"),
        cwd: workspacePath,
      }),
    );
    expect(sandboxMocks.createSandbox).toHaveBeenCalledTimes(1);
    expect(sandboxMocks.executions).toEqual([
      expect.objectContaining({
        command: expect.stringContaining("hello from Hermes"),
        cwd: workspacePath,
        allowNetwork: false,
      }),
    ]);

    const hostLifecycle = events
      .map((event) => event.payload)
      .filter((payload) => payload?.metric === "tool_host_lifecycle");
    expect(hostLifecycle.filter((payload) => payload.status === "request")).toHaveLength(2);
    expect(hostLifecycle.filter((payload) => payload.status === "response")).toHaveLength(2);
    expect(hostLifecycle.every((payload) => payload.schemaVersion === undefined || payload.schemaVersion === "neoworker_tool_host_v1")).toBe(true);

    const toolLifecycle = events
      .map((event) => event.payload)
      .filter((payload) => payload?.metric === "tool_lifecycle");
    expect(toolLifecycle).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tool: "write_file", status: "running" }),
        expect.objectContaining({ tool: "write_file", status: "result" }),
        expect.objectContaining({ tool: "run_command", status: "running" }),
        expect.objectContaining({ tool: "run_command", status: "result" }),
      ]),
    );
    expect(events.some((event) => event.type === "file_created")).toBe(true);
    expect(events.some((event) => event.type === "tool_call")).toBe(true);
    expect(events.some((event) => event.type === "tool_result")).toBe(true);

    const assistant = JSON.parse(result.assistantText) as {
      write: { result?: { content?: Array<{ text?: string }> } };
      shell: { result?: { content?: Array<{ text?: string }> } };
    };
    const writePayload = JSON.parse(assistant.write.result?.content?.[0]?.text || "{}");
    const shellPayload = JSON.parse(assistant.shell.result?.content?.[0]?.text || "{}");
    expect(writePayload).toMatchObject({ success: true, path: "hermes-host.txt" });
    expect(shellPayload).toMatchObject({
      success: true,
      stdout: "hello from Hermes",
      exitCode: 0,
      terminationReason: "normal",
    });
    expect(runtime.getCheckpoint()).toMatchObject({ toolOwnership: "neoworker" });
  });

  it("returns a structured host error when NeoWorker denies the shell approval", async () => {
    const { runtime, workspacePath, daemon } = await createHostHarness({
      approval: false,
    });

    const result = await runtime.prompt("host-multi-tool");
    const assistant = JSON.parse(result.assistantText) as {
      write: { result?: { content?: Array<{ text?: string }> } };
      shell: { result?: { content?: Array<{ text?: string }> } };
    };
    const writePayload = JSON.parse(assistant.write.result?.content?.[0]?.text || "{}");
    const shellPayload = JSON.parse(assistant.shell.result?.content?.[0]?.text || "{}");

    expect(result.stopReason).toBe("end_turn");
    expect(writePayload).toMatchObject({ success: true, path: "hermes-host.txt" });
    expect(shellPayload).toMatchObject({
      error: "User denied command execution",
    });
    expect(daemon.requestApproval).toHaveBeenCalledTimes(1);
    expect(sandboxMocks.createSandbox).not.toHaveBeenCalled();
    await expect(readFile(path.join(workspacePath, "hermes-host.txt"), "utf8"))
      .resolves.toBe("hello from Hermes");
  });

  it("cancels a pending host approval without starting Shell and resumes the checkpoint", async () => {
    const harness = await createHostHarness({ pendingApproval: true });
    const pending = harness.runtime.prompt("host-multi-tool");
    await harness.approvalStarted;

    await harness.runtime.pause();
    harness.releaseApproval(false);

    expect(await pending).toMatchObject({ stopReason: "cancelled" });
    expect(harness.runtime.isPaused()).toBe(true);
    expect(sandboxMocks.createSandbox).not.toHaveBeenCalled();
    expect(harness.daemon.requestApproval).toHaveBeenCalledTimes(1);
    await expect(
      readFile(path.join(harness.workspacePath, "hermes-host.txt"), "utf8"),
    ).resolves.toBe("hello from Hermes");

    const resumed = await harness.runtime.resume("next");
    expect(resumed).toMatchObject({
      assistantText: "你好 OK",
      stopReason: "end_turn",
      sessionId: "fixture-session",
    });
    expect(harness.runtime.getCheckpoint()).toMatchObject({
      toolOwnership: "neoworker",
    });
  });

  it("rejects a legacy Hermes-owned checkpoint when a NeoWorker host bridge is attached", async () => {
    const { runtime } = await createHostHarness({
      checkpoint: {
        schema: "neoworker_hermes_acp_v1",
        sessionId: "fixture-session",
        agentVersion: "fixture",
        toolOwnership: "hermes",
      },
    });

    await expect(runtime.connect()).rejects.toThrow(
      "tool ownership does not match",
    );
  });
});
