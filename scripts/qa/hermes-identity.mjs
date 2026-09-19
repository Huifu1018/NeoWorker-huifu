// Real embedded runtime and SQLite session restore, with a local fake model.
// Requires build:electron, build:hermes-runtime and Node with node:sqlite.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const require = createRequire(import.meta.url);
const { HermesAcpClient } = require("../../dist/electron/electron/agent/runtime/hermes-acp-client.js");
const { buildHermesInitialPrompt, buildHermesFollowUpPrompt, buildHermesRecoveryPrompt } = require("../../dist/electron/electron/agent/runtime/hermes-task-prompt.js");
const root = mkdtempSync(path.join(tmpdir(), "neoworker-identity-qa-"));
const home = path.join(root, "runtime");
const workspace = path.join(root, "workspace");
mkdirSync(home); mkdirSync(workspace);
const requests = [];
const server = createServer(async (req, res) => {
  if (req.url !== "/v1/chat/completions") {
    res.writeHead(404).end(); return;
  }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  requests.push(body);
  const content = "Offline identity probe completed.";
  const base = { id: "identity-probe", model: body.model, created: 1 };
  if (body.stream) {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const choice of [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }, { index: 0, delta: {}, finish_reason: "stop" }]) {
      res.write(`data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [choice] })}\n\n`);
    }
    res.end("data: [DONE]\n\n");
  } else {
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
      ...base, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
    }));
  }
});
let client;
let db;
try {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
  const start = async () => {
    client = new HermesAcpClient();
    await client.start({
      command: path.resolve("build/hermes-runtime/hermes-acp-neoworker-host" + (process.platform === "win32" ? ".exe" : "")),
      args: [], cwd: workspace, timeoutMs: 30_000, firstByteTimeoutMs: 30_000,
      env: {
        HERMES_HOME: home, HOME: root, USERPROFILE: root,
        NEOWORKER_HERMES_PROVIDER: "openai", NEOWORKER_HERMES_MODEL: "gpt-4o-mini",
        NEOWORKER_HERMES_API_MODE: "chat_completions", NEOWORKER_HERMES_BASE_URL: endpoint,
        NEOWORKER_HERMES_API_KEY: "local-test-key", OPENAI_API_KEY: "local-test-key", OPENAI_BASE_URL: endpoint,
        HERMES_NO_AUTO_UPDATE: "1", NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost",
      },
    });
    await client.initialize();
  };
  const check = () => {
    const request = requests.at(-1);
    assert.ok(request, "The real runtime must reach the local model");
    const system = request.messages.filter(message => message.role === "system").map(message => typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n");
    assert.match(system, /You are NeoWorker/);
    assert.doesNotMatch(system, /You are Hermes Agent, an intelligent/);
    assert.ok(system.includes(home));
    assert.match(system, /does not prove a directory exists/);
  };
  await start();
  const { sessionId } = await client.newSession(workspace);
  assert.equal(typeof sessionId, "string");
  await client.prompt(sessionId, buildHermesInitialPrompt({ taskPrompt: "Hello, who are you?", workspacePath: workspace }), 30_000);
  check();
  await client.prompt(sessionId, buildHermesFollowUpPrompt({ message: "Where is your runtime directory?", workspacePath: workspace }), 30_000);
  check();
  await client.stop();

  // Seed a pre-fix system prompt only in this test's isolated session DB.
  db = new DatabaseSync(path.join(home, "state.db"));
  const historyBefore = db.prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY id").all(sessionId);
  assert.ok(historyBefore.length > 0);
  db.prepare("UPDATE sessions SET system_prompt = ? WHERE id = ?").run("You are Hermes Agent, an intelligent AI assistant created by Nous Research.", sessionId);
  db.close(); db = undefined;
  await start();
  await client.loadSession(sessionId, workspace);
  await client.prompt(sessionId, buildHermesRecoveryPrompt({ taskPrompt: "Continue; state your identity.", workspacePath: workspace }), 30_000);
  check();
  await client.stop();
  db = new DatabaseSync(path.join(home, "state.db"));
  assert.match(db.prepare("SELECT system_prompt FROM sessions WHERE id = ?").get(sessionId).system_prompt, /You are NeoWorker/);
  const historyAfter = db.prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY id").all(sessionId);
  // Hermes re-inserts loaded rows during persistence; compare every payload
  // field and timestamp, excluding only the SQLite auto-increment row ID.
  const payloads = rows => rows.map(({ id, ...payload }) => payload);
  assert.deepEqual(payloads(historyAfter.slice(0, historyBefore.length)), payloads(historyBefore));
  assert.ok(requests.length >= 3);
  console.log("Embedded identity checks passed: initial, follow-up, persisted-session migration, history preserved. Local fake model only.");
} finally {
  await client?.stop();
  db?.close();
  await new Promise(resolve => server.close(resolve));
  rmSync(root, { recursive: true, force: true });
}
