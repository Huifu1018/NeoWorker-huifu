import { describe, expect, it } from "vitest";
import { buildToolResultEnvelope } from "../tool-result-envelope";

describe("buildToolResultEnvelope", () => {
  it("derives file and policy evidence from structured results", () => {
    const envelope = buildToolResultEnvelope({
      toolUseId: "tool-1",
      toolName: "write_file",
      status: "success",
      result: {
        path: "src/example.ts",
        success: true,
      },
      policyTrace: {
        toolName: "write_file",
        finalDecision: "allow",
        entries: [],
      },
    });

    expect(envelope.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "file",
          value: "src/example.ts",
        }),
        expect.objectContaining({
          type: "runtime_log",
          value: "final decision: allow",
        }),
      ]),
    );
  });

  it("keeps the model payload valid JSON when a model reminder is present", () => {
    const envelope = buildToolResultEnvelope({
      toolUseId: "tool-2",
      toolName: "task_list_update",
      status: "success",
      result: {
        items: [],
        updatedAt: 1,
        verificationNudgeNeeded: true,
        nudgeReason: "Add a verification item before finishing.",
      },
      modelReminder: "CHECKLIST REMINDER:\n- Add a verification item before finishing.",
    });

    expect(JSON.parse(envelope.modelPayload)).toMatchObject({
      verificationNudgeNeeded: true,
      _modelReminder:
        "CHECKLIST REMINDER:\n- Add a verification item before finishing.",
    });
  });

  it("exposes native Office creation results as artifact evidence", () => {
    const envelope = buildToolResultEnvelope({
      toolUseId: "tool-office",
      toolName: "create_spreadsheet",
      status: "success",
      result: {
        path: "经营复盘.xlsx",
        success: true,
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    });

    expect(envelope.evidence).toEqual([
      expect.objectContaining({
        type: "artifact",
        value: "经营复盘.xlsx",
        extra: {
          mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        },
      }),
    ]);
  });

  it("bounds oversized model payloads while keeping JSON parseable", () => {
    const envelope = buildToolResultEnvelope({
      toolUseId: "tool-large",
      toolName: "run_command",
      status: "success",
      result: { stdout: "x".repeat(250_000), command: "build" },
    });
    expect(envelope.modelPayload.length).toBeLessThanOrEqual(200_000);
    expect(JSON.parse(envelope.modelPayload)).toMatchObject({ truncated: true });
    expect((envelope.structuredData as { stdout: string }).stdout).toHaveLength(250_000);
  });

  it.each(['\\\\\\"\n\t\u0000', '中文😀'])('bounds JSON after escaping %j', fragment => {
    const result = { stdout: fragment.repeat(100_000), exitCode: 1 };
    const envelope = buildToolResultEnvelope({toolUseId:'escaped',toolName:'run_command',status:'success',result});
    expect(envelope.modelPayload.length).toBeLessThanOrEqual(200_000);
    expect(JSON.parse(envelope.modelPayload).truncated).toBe(true);
    expect(envelope.structuredData).toBe(result);
  });

  it('preserves valid JSON and the reminder for oversized text', () => {
    const envelope = buildToolResultEnvelope({
      toolUseId:'reminder',toolName:'read_file',status:'success',
      result:'x'.repeat(250_000),modelReminder:'Read the omitted part before editing.',
    });
    expect(envelope.modelPayload.length).toBeLessThanOrEqual(200_000);
    expect(JSON.parse(envelope.modelPayload)).toMatchObject({
      truncated:true,_modelReminder:'Read the omitted part before editing.',
    });
  });

  it('retains shell diagnostic tails and exit status', () => {
    const envelope = buildToolResultEnvelope({
      toolUseId:'build',toolName:'run_command',status:'success',
      result:{stdout:'log\n'.repeat(80_000)+'BUILD FAILED',stderr:'trace\n'.repeat(80_000)+'MISSING MODULE',exitCode:1,success:false},
    });
    const payload = JSON.parse(envelope.modelPayload);
    expect(payload.stdout).toContain('BUILD FAILED');
    expect(payload.stderr).toContain('MISSING MODULE');
    expect(payload).toMatchObject({exitCode:1,success:false,truncated:true});
    expect(envelope.modelPayload.length).toBeLessThanOrEqual(200_000);
  });

  it('retains the error field and reminder when a diagnostic is oversized', () => {
    const envelope = buildToolResultEnvelope({
      toolUseId:'error',toolName:'run_command',status:'error',
      error:new Error('stack\n'.repeat(90_000)+'FINAL CAUSE'),modelReminder:'Do not replay this command.',
    });
    const payload = JSON.parse(envelope.modelPayload);
    expect(payload.error).toContain('FINAL CAUSE');
    expect(payload._modelReminder).toBe('Do not replay this command.');
    expect(envelope.modelPayload.length).toBeLessThanOrEqual(200_000);
  });

  it('bounds non-shell structured previews after JSON escaping', () => {
    const envelope = buildToolResultEnvelope({
      toolUseId:'json',toolName:'read_file',status:'success',
      result:{data:['\\"\n\t'.repeat(120_000)]},
    });
    expect(envelope.modelPayload.length).toBeLessThanOrEqual(200_000);
    expect(JSON.parse(envelope.modelPayload)).toMatchObject({truncated:true,contentFormat:'json_preview'});
  });

  it('keeps plain text bounded without splitting a surrogate pair', () => {
    const envelope = buildToolResultEnvelope({
      toolUseId:'unicode',toolName:'read_file',status:'success',result:'😀'.repeat(120_000),
    });
    const prefix = envelope.modelPayload.split('\n[Tool result truncated')[0];
    expect(prefix.endsWith('😀')).toBe(true);
    expect(envelope.modelPayload.length).toBeLessThanOrEqual(200_000);
  });
});
