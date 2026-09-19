// Replay saved translations against a disposable source copy. No model/API calls.
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { DocumentTools } = require("../../dist/electron/electron/agent/tools/document-tools.js");
const { inspectOfficeTranslation, verifyOfficeTranslationFidelity } = require("../../dist/electron/electron/documents/office-translation.js");
const { translationTextIssue } = require("../../dist/electron/electron/documents/translation-text.js");

(async () => {
  const [sourcePath, savedCheckpoint] = process.argv.slice(2);
  assert(sourcePath && savedCheckpoint, "Pass source PPTX and saved translation checkpoint");
  const source = await fs.readFile(sourcePath);
  const originalCheckpoint = await fs.readFile(savedCheckpoint);
  const saved = JSON.parse(originalCheckpoint);
  assert.equal(saved.sourceSha256, createHash("sha256").update(source).digest("hex"));
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "neoworker-translation-recovery-qa-"));
  const sourceName = `source${path.extname(sourcePath)}`;
  await fs.writeFile(path.join(directory, sourceName), source);
  const answers = new Map(saved.units.map((unit) => [unit.id, unit.text]));
  const published = [];
  const makeTools = () => new DocumentTools(directory, "offline-replay", (...args) => published.push(args));
  let tools = makeTools();
  const started = Date.now();
  let progress = await tools.officeTranslation({ action: "inspect", sourcePath: sourceName, targetLanguage: saved.targetLanguage });
  let stageCalls = 0;
  let repairCalls = 0;
  let withheldOnce = false;
  const repaired = new Set();
  while (progress.remaining) {
    assert(stageCalls < 100, "Recovery failed to converge");
    const entries = progress.nextUnits.map((unit) => {
      let text = answers.get(unit.id);
      assert.equal(typeof text, "string", `Missing saved translation ${unit.id}`);
      if (translationTextIssue(text) && repaired.has(unit.id)) {
        // A deliberate test substitute, NOT a repaired user translation or a semantic quality claim.
        text = `QA repair ${unit.id}`;
      } else if (translationTextIssue(text)) repaired.add(unit.id);
      return { key: unit.key, text };
    });
    if (!withheldOnce) { entries.pop(); withheldOnce = true; }
    if (progress.repairing) repairCalls++;
    const input = stageCalls === 0
      ? { sourcePath: sourceName } // Reproduce omitted checkpoint path; host resolves exact batch.
      : { translationId: progress.translationId };
    progress = await tools.officeTranslation({ action: "stage", ...input, batchId: progress.batchId, translations: entries });
    assert.notEqual(progress.retryable, false);
    stageCalls++;
    tools = makeTools(); // Every batch also exercises restart recovery.
  }
  assert.equal(progress.completed, saved.units.length);
  const result = await tools.officeTranslation({ action: "apply", translationId: progress.translationId, filename: `qa-replay${path.extname(sourcePath)}` });
  assert.equal(result.success, true);
  assert.equal(published.length, 1);
  const output = await fs.readFile(path.join(directory, result.path));
  await verifyOfficeTranslationFidelity(source, output);
  const translated = await inspectOfficeTranslation(output);
  for (const unit of translated.units) {
    assert.equal(translationTextIssue(unit.text), undefined);
    assert.equal(unit.text, repaired.has(unit.id) ? `QA repair ${unit.id}` : answers.get(unit.id));
  }
  assert.deepEqual(await fs.readFile(sourcePath), source);
  assert.deepEqual(await fs.readFile(savedCheckpoint), originalCheckpoint);
  const report = { directory, units: progress.completed, stageCalls, repairCalls, correctedCorruptUnits: repaired.size,
    localReplayMs: Date.now() - started, sourceUnchanged: true, checkpointUnchanged: true,
    note: "Offline saved-response recovery test, NOT live translation timing or quality verification. QA output contains deliberate test substitutions." };
  await fs.writeFile(path.join(directory, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
})().catch((error) => { console.error(error); process.exitCode = 1; });
