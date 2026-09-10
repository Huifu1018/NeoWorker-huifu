import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const distRoot = path.join(repoRoot, "dist", "electron", "electron");
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "neoworker-hermes-live-user-data-"));
const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "neoworker-hermes-live-workspace-"));
process.env.NEOWORKER_USER_DATA_DIR = userDataDir;

function load(relativePath) {
  return require(path.join(distRoot, relativePath));
}

const { HermesRuntimeAdapter } = load("agent/runtime/hermes-runtime-adapter.js");
const { resolveHermesHostLauncher } = load("agent/runtime/hermes-host-launcher.js");
const { DatabaseManager } = load("database/schema.js");
const { ToolRegistry } = load("agent/tools/registry.js");
const { ShellSessionManager } = load("agent/tools/shell-session-manager.js");
const { ToolExecutionCoordinator } = load("agent/runtime/ToolExecutionCoordinator.js");
const {
  NeoWorkerToolHost,
  createToolHostRequest,
} = load("agent/runtime/tool-host-protocol.js");

const runToken = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const taskId = `hermes-live-task-${runToken}`;
const workspaceId = `hermes-live-workspace-${runToken}`;
const events = [];
const approvals = [];
const calls = [];
const transport = [];
const db = new (require(path.join(repoRoot, "node_modules", "better-sqlite3")))(":memory:");
DatabaseManager.getInstance = () => ({ getDatabase: () => db });

const daemon = {
  requestApproval: async (...args) => {
    approvals.push(args);
    return true;
  },
  logEvent: (...args) => {
    events.push(args);
  },
  registerArtifact: (...args) => {
    events.push(["artifact_created", ...args]);
  },
};

const workspace = {
  id: workspaceId,
  name: "Hermes live validation",
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

let runtime;
let passed = false;

try {
  const registry = new ToolRegistry(workspace, daemon, taskId);
  const tools = registry
    .getTools()
    .filter((tool) => ["read_file", "write_file", "run_command"].includes(tool.name));
  const coordinator = new ToolExecutionCoordinator(registry);
  const host = new NeoWorkerToolHost(coordinator);
  const launcher = resolveHermesHostLauncher();

  runtime = new HermesRuntimeAdapter({
    cwd: workspacePath,
    ...launcher,
    timeoutMs: 240_000,
    firstByteTimeoutMs: 30_000,
    onUpdate: () => undefined,
    onTransportEvent: (event) => {
      transport.push({
        phase: event.phase,
        method: event.method,
        code: event.code,
      });
    },
    hostToolBridge: {
      taskId,
      requestTimeoutMs: 120_000,
      getTools: () => tools,
      execute: async ({
        toolName,
        toolCallId,
        input,
        signal,
        checkpoint,
      }) => {
        calls.push({ toolName, toolCallId });
        const execution = await host.execute(
          createToolHostRequest({
            taskId,
            toolName,
            toolCallId,
            input,
            checkpoint,
          }),
          {
            taskId,
            phase: "live-validation",
            signal,
            emitEvent: (type, payload) => events.push([type, payload]),
            beginHeartbeat: () => undefined,
            timeoutMsResolver: (name) => (name === "run_command" ? 60_000 : 30_000),
          },
        );
        return execution.response;
      },
    },
  });

  const result = await runtime.prompt(
    'Use the available NeoWorker tools to complete this exact multi-step task: first write a file named hermes-real.txt with the exact content "hello from real Hermes" in the workspace, then run a shell command that reads that file and prints its contents, then reply with a concise confirmation including the printed content. Do not use any tool more than once unless a tool fails.',
  );
  const filePath = path.join(workspacePath, "hermes-real.txt");
  const content = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null;
  const checkpoint = runtime.getCheckpoint();
  const metrics = events
    .filter((entry) => entry[1]?.metric)
    .map((entry) => ({
      metric: entry[1].metric,
      status: entry[1].status,
      tool: entry[1].tool,
      responseStatus: entry[1].responseStatus,
    }));

  const expectedCalls = ["write_file", "run_command"];
  passed =
    result.stopReason === "end_turn" &&
    content === "hello from real Hermes" &&
    calls.length === expectedCalls.length &&
    calls.every((call, index) => call.toolName === expectedCalls[index]) &&
    approvals.length >= 1 &&
    checkpoint?.toolOwnership === "neoworker" &&
    checkpoint?.toolProgress?.unknownToolCallIds?.length === 0 &&
    metrics.some((entry) => entry.metric === "tool_host_lifecycle" && entry.status === "response") &&
    metrics.some((entry) => entry.metric === "tool_lifecycle" && entry.status === "result");

  console.log(
    JSON.stringify(
      {
        ok: passed,
        stopReason: result.stopReason,
        tools: tools.map((tool) => tool.name),
        calls: calls.map((call) => call.toolName),
        approvalCount: approvals.length,
        fileContent: content,
        checkpoint: {
          toolOwnership: checkpoint?.toolOwnership,
          unknownToolCallCount: checkpoint?.toolProgress?.unknownToolCallIds?.length ?? null,
        },
        lifecycleMetrics: metrics,
        transportPhases: transport.map((event) => event.phase),
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: {
          name: error?.name,
          code: error?.code,
          message: error?.message,
        },
        calls: calls.map((call) => call.toolName),
      },
      null,
      2,
    ),
  );
} finally {
  if (runtime) await runtime.close();
  await ShellSessionManager.getInstance().closeSession(taskId, workspaceId);
  db.close();
  fs.rmSync(workspacePath, { recursive: true, force: true });
  fs.rmSync(userDataDir, { recursive: true, force: true });
}

if (!passed) process.exitCode = 1;
