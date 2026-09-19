// Real bundled Hermes + MCP + document tools; deterministic local model replies.
// No provider credentials, external model requests, or user task mutations.
const { app } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const PptxGenJS = require("pptxgenjs");
app.on("window-all-closed", () => {});

(async () => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), "neoworker-translation-follow-up-"));
  process.env.NEOWORKER_USER_DATA_DIR = path.join(output, "profile");
  app.setPath("userData", process.env.NEOWORKER_USER_DATA_DIR);
  await app.whenReady();
  const load = (name) => require(path.join(__dirname, "../../dist/electron/electron", name));
  const { TaskExecutor } = load("agent/executor.js");
  const { ToolRegistry } = load("agent/tools/registry.js");
  const { DatabaseManager } = load("database/schema.js");
  const { HermesRuntimeAdapter } = load("agent/runtime/hermes-runtime-adapter.js");
  const { resolveHermesHostLauncher } = load("agent/runtime/hermes-host-launcher.js");
  const { buildHermesProviderBridgeEnvironment } = load("agent/runtime/hermes-provider-bridge.js");
  const { buildHermesInitialPrompt, buildHermesFollowUpPrompt } = load("agent/runtime/hermes-task-prompt.js");
  const { ToolExecutionCoordinator } = load("agent/runtime/ToolExecutionCoordinator.js");
  const { NeoWorkerToolHost, createToolHostRequest } = load("agent/runtime/tool-host-protocol.js");
  const db = new (require("better-sqlite3"))(":memory:");
  DatabaseManager.getInstance = () => ({ getDatabase: () => db });
  const workspace = { id: "translation-follow-up-qa", path: output, name: "Translation QA", createdAt: Date.now(), permissions: { read: true, write: true, delete: false, shell: false, network: false } };
  const taskId = "translation-follow-up-qa";
  const artifacts = [];
  const daemon = { logEvent() {}, requestApproval: async () => true, registerArtifact: (...args) => artifacts.push(args) };
  let registry = new ToolRegistry(workspace, daemon, taskId);
  let host = new NeoWorkerToolHost(new ToolExecutionCoordinator(registry));
  const executor = Object.assign(Object.create(TaskExecutor.prototype), {
    task: { id: taskId, title: "首尔旅行地图", prompt: "生成 HTML 旅行地图" }, workspace, toolRegistry: registry,
    getAvailableTools: () => registry.getTools().filter((tool) => ["write_file", "read_file"].includes(tool.name)),
    applyAgentPolicyToolFilter: (tools) => tools, isToolRestrictedByPolicy: () => false,
  });
  const sourcePath = ".neoworker/uploads/fixture/source.pptx";
  await fs.mkdir(path.dirname(path.join(output, sourcePath)), { recursive: true });
  const pptx = new PptxGenJS();
  const slide = pptx.addSlide();
  for (const [index, text] of ["模型性能", "开源模型", "推理效率"].entries()) slide.addText(text, { x: 1, y: 1 + index, w: 6, h: 0.7, fontSize: 24 });
  const source = Buffer.from(await pptx.write({ outputType: "nodebuffer" }));
  await fs.writeFile(path.join(output, sourcePath), source);
  const dictionary = { "模型性能": "모델 성능", "开源模型": "오픈 소스 모델", "推理效率": "추론 효율", "Click to edit Master text styles": "마스터 텍스트 스타일 편집", "Second level": "두 번째 수준", "Third level": "세 번째 수준", "Fourth level": "네 번째 수준", "Fifth level": "다섯 번째 수준" };
  let phase = "map", requestCount = 0, latest, partialId, qaError;
  const calls = [], requests = [], stageProgress = [];
  const phaseCalls = () => calls.filter((call) => call.phase === phase);
  const fn = (name, input) => ({ role: "assistant", content: null, tool_calls: [{ id: `call_${requestCount}`, type: "function", function: { name: `mcp_neoworker_${name}`, arguments: JSON.stringify(input) } }] });
  const final = (content) => ({ role: "assistant", content });
  function reply(body) {
    // Hermes may request a session title without tools using the same local endpoint.
    if (!body.tools?.length) return final("Translation follow-up QA");
    requestCount++;
    if (qaError || requestCount > 20) return final("QA stopped: " + (qaError?.message || "unexpected repeated calls"));
    const names = (body.tools || []).map((tool) => tool.function?.name);
    requests.push({ phase, tools: names });
    assert(names.includes("mcp_neoworker_office_translation"), "Translation must be visible in the FIRST map turn, before MCP caches tools/list");
    const done = phaseCalls();
    if (phase === "map") return done.length ? final("地图已保存。") : fn("write_file", { path: "map.html", content: "<!doctype html><html><body>Seoul map fixture</body></html>" });
    if (phase === "translate" && !done.length) return fn("create_spreadsheet", { filename: "tmp-check", sheets: [{ name: "s", headers: ["a"], rows: [["b"]] }] });
    if (phase === "translate" && done.length === 1) {
      const feedback = body.messages.filter((message) => message.role === "tool").at(-1)?.content || "";
      assert(feedback.includes("mcp_neoworker_office_translation"));
      assert(!feedback.includes("Use create_presentation"));
    }
    if (!done.some((call) => call.action === "inspect")) return fn("office_translation", { action: "inspect", sourcePath, targetLanguage: "ko" });
    if (phase === "reopen") return final("已恢复已完成的翻译进度。 ");
    if (phase === "translate") {
      if (done.some((call) => call.action === "stage")) return final("已保存第一段，等待继续。");
      const unit = latest.nextUnits[0];
      return fn("office_translation", { action: "stage", translationId: latest.translationId, units: [{ id: unit.id, text: dictionary[unit.text] }] });
    }
    if (latest.remaining > 0) return fn("office_translation", { action: "stage", translationId: latest.translationId, batchId: latest.batchId, translations: latest.nextUnits.map((unit) => ({ key: unit.key, text: dictionary[unit.text] })) });
    if (!done.some((call) => call.action === "apply")) return fn("office_translation", { action: "apply", translationId: latest.translationId, filename: "translated-ko.pptx" });
    return final("韩文译本已生成并通过原文件保真与文字适配检查。");
  }
  const server = http.createServer(async (req, res) => {
    try {
      let raw = ""; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      const message = reply(body);
      const base = { id: `chatcmpl-qa-${requestCount}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: "qa-model" };
      const reason = message.tool_calls ? "tool_calls" : "stop";
      if (body.stream) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        const delta = { ...message, ...(message.tool_calls ? { tool_calls: message.tool_calls.map((call, index) => ({ index, ...call })) } : {}) };
        res.write(`data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
        res.end(`data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: reason }] })}\n\ndata: [DONE]\n\n`);
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ...base, choices: [{ index: 0, message, finish_reason: reason }], usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } }));
      }
    } catch (error) { res.writeHead(500); res.end(String(error)); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const options = {
    ...resolveHermesHostLauncher(), cwd: output, timeoutMs: 90_000, firstByteTimeoutMs: 30_000,
    env: {
      ...Object.fromEntries(Object.keys(process.env).filter((key) => /API_KEY|TOKEN|BASE_URL|ANTHROPIC|OPENAI|GOOGLE|GEMINI|OPENROUTER/.test(key)).map((key) => [key, ""])),
      OPENAI_API_KEY: "local-qa-only", OPENAI_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
      ...buildHermesProviderBridgeEnvironment({ provider: "openai-compatible", model: "qa-model", apiMode: "chat_completions", apiKey: "local-qa-only", baseUrl: `http://127.0.0.1:${server.address().port}/v1` }, path.join(output, "hermes")),
    },
    hostToolBridge: {
      taskId, getTools: () => executor.getHermesHostTools(), requestTimeoutMs: 90_000,
      execute: async ({ toolName, toolCallId, input, signal }) => {
        calls.push({ phase, tool: toolName, action: input.action });
        try {
        const request = createToolHostRequest({ taskId, toolName, toolCallId, input });
        const blocked = executor.applyPreToolUsePolicyHook({ toolName, input }).blockedResult;
        if (blocked) {
          assert(blocked.error.includes("mcp_neoworker_office_translation"));
          assert(!blocked.error.includes("Use create_presentation"));
          return { requestId: request.requestId, toolCallId, schemaVersion: request.schemaVersion, status: "error", error: { message: blocked.error } };
        }
        const execution = await host.execute(request, { taskId, phase: "step", signal, emitEvent() {}, beginHeartbeat() {}, timeoutMsResolver: () => 90_000 });
        assert.equal(execution.response.status, "success", JSON.stringify(execution.response));
        if (toolName === "office_translation") {
          latest = execution.response.result;
          assert.equal(latest.success, true, JSON.stringify(latest));
          if (input.action === "stage") stageProgress.push({ completed: latest.completed, remaining: latest.remaining });
        }
        return execution.response;
        } catch (error) { qaError = error; throw error; }
      },
    },
  };
  let runtime = new HermesRuntimeAdapter(options);
  try {
    registry.setDocumentTaskContext("生成首尔 HTML 旅行地图");
    await runtime.prompt(buildHermesInitialPrompt({ taskPrompt: "生成首尔 HTML 旅行地图", workspacePath: output }));
    const request = `翻译成韩文\n\nAttached files:\n- source.pptx (${sourcePath})`;
    registry.setDocumentTaskContext(request);
    executor.activeFollowUpCompletionContract = { requiresArtifactEvidence: true, requiredArtifactExtensions: [".pptx"] };
    phase = "translate";
    await runtime.prompt(buildHermesFollowUpPrompt({ message: request + "\n" + registry.getDocumentTranslationGuidance(), workspacePath: output }));
    partialId = latest.translationId;
    assert(latest.completed > 0 && latest.remaining > 0);
    registry.setDocumentTaskContext("继续"); phase = "continue";
    await runtime.prompt(buildHermesFollowUpPrompt({ message: "继续\n" + registry.getDocumentTranslationGuidance(), workspacePath: output }));
    if (qaError) throw qaError;
    assert.equal(latest.sourceFidelity.verified, true);
    assert.equal(latest.textFit.status, "passed");
    assert.equal(registry.getDocumentTranslationDeliveryError([latest.path]), null);
    const checkpoint = runtime.getCheckpoint();
    assert.equal(checkpoint.toolProgress.unknownToolCallIds.length, 0);
    await runtime.close();
    registry = new ToolRegistry(workspace, daemon, taskId);
    host = new NeoWorkerToolHost(new ToolExecutionCoordinator(registry));
    executor.toolRegistry = registry;
    executor.restoreDocumentTaskContextFromEvents([
      { timestamp: 1, type: "user_message", payload: { message: request } },
      { timestamp: 2, type: "user_message", payload: { message: "继续" } },
    ]);
    assert(registry.getDocumentTranslationToolError("create_presentation"));
    assert(registry.getDocumentTaskContext().includes(sourcePath));
    runtime = new HermesRuntimeAdapter({ ...options, checkpoint });
    phase = "reopen";
    await runtime.prompt(buildHermesFollowUpPrompt({ message: "继续，检查保存的翻译进度。", workspacePath: output }));
    assert.equal(latest.translationId, partialId);
    assert.equal(latest.remaining, 0);
    assert.deepEqual(await fs.readFile(path.join(output, sourcePath)), source);
    const report = { passed: true, output, model: "deterministic local responses, no live provider", runtime: options.command, requestCount, calls, stageProgress, sourceSha256: createHash("sha256").update(source).digest("hex"), preservedSource: true, resumedTranslationId: true, textFit: "passed", fidelity: "verified" };
    await fs.writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally { await runtime.close(); await new Promise((resolve) => server.close(resolve)); db.close(); }
})().then(() => app.exit(0), (error) => { console.error(error); app.exit(1); });
