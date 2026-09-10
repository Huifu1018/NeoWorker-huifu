const readline = require("node:readline");

const send = (message) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
let shutdownTimer;

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({
      id: message.id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: "hermes-agent", version: "fixture-delayed" },
        agentCapabilities: { loadSession: true },
      },
    });
    return;
  }
  if (message.method === "session/new") {
    send({ id: message.id, result: { sessionId: "fixture-delayed-session" } });
    return;
  }
  if (message.method === "session/prompt") {
    send({ id: message.id, result: { stopReason: "end_turn" } });
  }
});

const scheduleShutdown = () => {
  if (!shutdownTimer) {
    shutdownTimer = setTimeout(() => process.exit(0), 250);
  }
};

process.stdin.on("end", scheduleShutdown);
process.on("SIGTERM", scheduleShutdown);

process.on("exit", () => {
  if (shutdownTimer) clearTimeout(shutdownTimer);
});
