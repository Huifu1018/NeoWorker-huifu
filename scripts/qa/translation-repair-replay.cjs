// Replay saved translations through the actual Executor -> MCP -> native tool
// boundary. Inputs are copied; no user database, model API or source is mutated.
// electron scripts/qa/translation-repair-replay.cjs SOURCE MANIFEST REPAIRS_JSON [LANGUAGE] [--dual-output]
const { app } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
app.on("window-all-closed", () => {});
(async () => {
  const [sourceFile, manifestFile, repairFile, language = "Korean"] = process.argv.slice(2);
  assert(sourceFile && manifestFile && repairFile, "Provide source, saved translations and repairs JSON paths");
  const dualOutput = process.argv.includes("--dual-output");
  const output = await fs.mkdtemp(path.join(os.tmpdir(), "neoworker-translation-repair-replay-"));
  app.setPath("userData", path.join(output, "profile"));
  await app.whenReady();
  const load = name => require(path.join(__dirname, "../../dist/electron/electron", name));
  const { TaskExecutor } = load("agent/executor.js");
  const { DocumentTools } = load("agent/tools/document-tools.js");
  const { ToolExecutionCoordinator } = load("agent/runtime/ToolExecutionCoordinator.js");
  const { NeoWorkerToolHost, createToolHostRequest } = load("agent/runtime/tool-host-protocol.js");
  const { HermesToolHostMcpServer } = load("agent/runtime/hermes-tool-host-mcp.js");
  const { verifyOfficeTranslationFidelity } = load("documents/office-translation.js");
  const taskId = "translation-repair-replay";
  const artifacts = [], events = [], calls = [];
  const source = await fs.readFile(sourceFile);
  await fs.writeFile(path.join(output, "source.pptx"), source);
  const manifest = JSON.parse(await fs.readFile(manifestFile, "utf8"));
  const repairs = JSON.parse(await fs.readFile(repairFile, "utf8"));
  const translations = new Map(manifest.units.map(unit => [unit.id, unit.text]));
  const tools = new DocumentTools(output, taskId, (...args) => artifacts.push(args));
  const definitions = DocumentTools.getToolDefinitions().filter(tool => tool.name === "office_translation" || (dualOutput && tool.name === "generate_document"));
  const registry = { getTools: () => definitions, executeTool: (name, input) => name === "generate_document" ? tools.generateDocument(input) : tools.officeTranslation(input) };
  const host = new NeoWorkerToolHost(new ToolExecutionCoordinator(registry));
  const executor = Object.assign(Object.create(TaskExecutor.prototype), {
    task: { id: taskId, prompt: dualOutput ? "翻译成德语，输出已发PPT，此外，再进行分析输出一份PDF文档" : `Translate the attached PPTX to ${language}` }, workspace: { path: output },
    toolRegistry: registry, getAvailableTools: () => definitions,
    applyAgentPolicyToolFilter: items => items, isToolRestrictedByPolicy: () => false,
    emitEvent: (type, payload) => events.push({ type, payload }), enforceToolBudget() {},
    totalToolCallCount: 0, toolUsageCounts: new Map(), successfulToolUsageCounts: new Map(),
    toolResultMemory: [], webEvidenceMemory: [], taskHadAnyToolSuccess: false,
    daemon: { getTaskEvents: () => [], logEvent() {}, createHermesPermissionHandler: () => async () => null },
    getToolTimeoutMs: () => 90_000,
    executeToolWithHeartbeat: async (toolName, input, _timeout, toolCallId, signal) => {
      const outcome = await host.execute(createToolHostRequest({ taskId, toolName, input, toolCallId }),
        { taskId, phase: "step", signal, emitEvent() {}, timeoutMsResolver: () => 90_000 });
      return { ...outcome.outcome, toolHostResponse: outcome.response };
    },
  });
  const runtime = executor.createHermesRuntimeAdapter();
  const server = new HermesToolHostMcpServer(runtime.options.hostToolBridge);
  try {
    const endpoint = await server.start();
    let id = 0, sessionId;
    const post = async (method, params) => {
      const response = await fetch(`http://127.0.0.1:${server.getPort()}/mcp`, {
        method: "POST", headers: { authorization: endpoint.headers[0].value, "content-type": "application/json",
          ...(sessionId ? { "mcp-session-id": sessionId } : {}) },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      });
      sessionId ||= response.headers.get("mcp-session-id");
      assert.equal(response.status, 200);
      return response.json();
    };
    await post("initialize", {});
    const call = async input => {
      const wire = await post("tools/call", { name: "office_translation", arguments: input });
      const result = JSON.parse(wire.result.content[0].text);
      calls.push({ action: input.action, isError: wire.result.isError, result });
      return result;
    };
    let progress = await call({ action: "inspect", sourcePath: "source.pptx", targetLanguage: language });
    assert.equal(progress.success, true, JSON.stringify(progress));
    const translationId = progress.translationId;
    while (progress.remaining) {
      progress = await call({ action: "stage", translationId, batchId: progress.batchId,
        translations: progress.nextUnits.map(unit => { assert(translations.has(unit.id)); return { key: unit.key, text: translations.get(unit.id) }; }) });
      assert.equal(progress.success, true, JSON.stringify(progress));
    }
    const failure = await call({ action: "apply", translationId, filename: "translated.pptx" });
    assert.equal(failure.success, false, "The complete first translation must exercise the repair branch");
    assert.equal(failure.retryable, true);
    assert.equal(failure.error, failure.message);
    assert.equal(failure.textFit.status, "needs_repair");
    await fs.writeFile(path.join(output, "initial-repair.json"), JSON.stringify(failure, null, 2));
    assert(failure.nextUnits.length > 0 && failure.nextUnits.every(unit => unit.previousTranslation));
    assert.equal(artifacts.length, 0, "No invalid artifact can be published");
    let delivered = failure;
    let repairRounds = 0;
    const repairedIds = new Set();
    while (!delivered.success && repairRounds < 3) {
      assert.equal(delivered.retryable, true, JSON.stringify(delivered));
      await fs.writeFile(path.join(output, `repair-${repairRounds + 1}.json`), JSON.stringify(delivered, null, 2));
      progress = await call({ action: "stage", translationId, batchId: delivered.batchId,
        translations: delivered.nextUnits.map(unit => {
          assert(repairs[unit.id], "Missing repair for " + unit.id);
          repairedIds.add(unit.id);
          return { key: unit.key, text: repairs[unit.id] };
        }) });
      assert.equal(progress.remaining, 0, JSON.stringify(progress));
      delivered = await call({ action: "apply", translationId, filename: "translated.pptx" });
      repairRounds++;
    }
    assert.equal(delivered.success, true, JSON.stringify(delivered));
    assert.equal(delivered.textFit.status, "passed");
    assert.equal(artifacts.length, 1);
    const deliveredPath = path.resolve(output, delivered.path);
    await verifyOfficeTranslationFidelity(source, await fs.readFile(deliveredPath), true);
    assert.deepEqual(await fs.readFile(path.join(output, "source.pptx")), source);
    assert.deepEqual(await fs.readFile(sourceFile), source);
    let pdfPath;
    if (dualOutput) {
      const { buildCompletionContract, hasArtifactEvidence } = load("agent/executor-completion-utils.js");
      const contract = buildCompletionContract({ taskTitle: "", taskPrompt: executor.task.prompt,
        requiresDirectAnswer: false, requiresDecisionSignal: false, isWatchSkipRecommendationTask: false });
      assert.deepEqual(new Set(contract.requiredArtifactExtensions), new Set([".pptx", ".pdf"]));
      assert.equal(hasArtifactEvidence({ contract, createdFiles: [deliveredPath] }), false);
      const wire = await post("tools/call", { name: "generate_document", arguments: {
        filename: "analysis-regression.pdf", title: "Translation delivery regression",
        markdown: "This PDF is a test fixture for the PPTX + PDF delivery path. It is not an analysis of the source deck." } });
      const pdf = JSON.parse(wire.result.content[0].text);
      assert.equal(pdf.success, true, JSON.stringify(pdf));
      pdfPath = path.resolve(output, pdf.path);
      const bytes = await fs.readFile(pdfPath);
      assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
      const { PDFDocument } = require("pdf-lib");
      assert((await PDFDocument.load(bytes)).getPageCount() > 0);
      assert.equal(hasArtifactEvidence({ contract, createdFiles: [pdfPath] }), false);
      assert.equal(hasArtifactEvidence({ contract, createdFiles: [deliveredPath, pdfPath] }), true);
      assert.equal(artifacts.length, 2);
    }
    const report = { passed: true, output, dualOutput, pdfPath, total: progress.total, repairedUnits: repairedIds.size, repairRounds,
      sourceSha256: createHash("sha256").update(source).digest("hex"), preservedSource: true,
      textFit: delivered.textFit, path: deliveredPath, fidelity: "verified", model: "saved translations replayed through MCP; no live provider" };
    await fs.writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
    await fs.writeFile(path.join(output, "calls.json"), JSON.stringify(calls, null, 2));
    await fs.writeFile(path.join(output, "events.json"), JSON.stringify(events, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally { await server.stop(); await runtime.close(); }
})().then(() => app.exit(0), error => { console.error(error); app.exit(1); });
