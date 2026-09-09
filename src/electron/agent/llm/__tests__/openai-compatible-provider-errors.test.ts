import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OpenAICompatibleProvider,
  OpenAICompatibleProviderError,
} from "../openai-compatible-provider";

function createProvider(
  extra: Partial<ConstructorParameters<typeof OpenAICompatibleProvider>[0]> = {},
): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    type: "deepseek",
    providerName: "DeepSeek",
    apiKey: "test-key",
    baseUrl: "https://api.deepseek.example/v1",
    defaultModel: "deepseek-chat",
    ...extra,
  });
}

function createRequest() {
  return {
    model: "deepseek-chat",
    maxTokens: 32,
    system: "",
    messages: [{ role: "user" as const, content: "hello" }],
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("OpenAICompatibleProvider error metadata", () => {
  it("bounds connection tests when a local gateway never responds", async () => {
    const fetchMock = vi.fn((_input: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await createProvider({ auxiliaryRequestTimeoutMs: 10 }).testConnection();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/timed out|aborted/i);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/chat/completions"),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("bounds model discovery when a local gateway never responds", async () => {
    vi.stubGlobal("fetch", vi.fn((_input: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      }),
    ));

    await expect(createProvider({ auxiliaryRequestTimeoutMs: 10 }).getAvailableModels())
      .rejects.toMatchObject({ message: expect.stringMatching(/timed out|aborted|Failed to refresh/i) });
  });

  it("parses streamed Hermes text and fragmented tool calls", async () => {
    const sse = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
    const frames = [
      sse({ choices: [{ delta: { content: "hello " } }] }),
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "run_command", arguments: "{\"command\":" } }] } }] }),
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "\"echo hi\"}" } }] }, finish_reason: "tool_calls" }] }),
      sse({ usage: { prompt_tokens: 3, completion_tokens: 4 } }),
      "data: [DONE]\n\n",
    ];
    const encoder = new TextEncoder();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      body: {
        getReader: () => ({
          read: async () => frames.length > 0
            ? { done: false, value: encoder.encode(frames.shift()!) }
            : { done: true, value: undefined },
          releaseLock: vi.fn(),
        }),
      },
    });
    vi.stubGlobal("fetch", fetchMock);
    const progress = vi.fn();
    const response = await createProvider().createMessage({ ...createRequest(), onStreamProgress: progress });
    expect(response.stopReason).toBe("tool_use");
    expect(response.content).toEqual([
      { type: "text", text: "hello " },
      { type: "tool_use", id: "call_1", name: "run_command", input: { command: "echo hi" } },
    ]);
    expect(response.usage).toMatchObject({ inputTokens: 3, outputTokens: 4 });
    expect(progress.mock.calls.at(-1)?.[0]).toMatchObject({ streaming: false, text: "hello " });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toMatchObject({ stream: true });
  });

  it("marks a disconnected stream retryable", async () => {
    const transportError = new Error("stream disconnected");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      body: { getReader: () => ({ read: async () => { throw transportError; }, releaseLock: vi.fn() }) },
    }));
    await expect(createProvider().createMessage({ ...createRequest(), onStreamProgress: vi.fn() }))
      .rejects.toMatchObject({ code: "TRANSPORT_ERROR", retryable: true });
  });
  it("sends image_url content for a DeepSeek vision model", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: vi.fn().mockResolvedValue({
        choices: [
          {
            finish_reason: "stop",
            message: { content: "A city skyline." },
          },
        ],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 4,
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await createProvider().createMessage({
      model: "deepseek-v4-flash-vision-exp",
      maxTokens: 32,
      system: "",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Where is this?" },
            {
              type: "image",
              mimeType: "image/png",
              data: "AA==",
              originalSizeBytes: 2,
            },
          ],
        },
      ],
    });

    const requestBody = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body),
    );
    expect(requestBody.model).toBe("deepseek-v4-flash-vision-exp");
    expect(requestBody.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "Where is this?" },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,AA==" },
          },
        ],
      },
    ]);
  });

  it("marks temporary HTTP failures as retryable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
        json: vi.fn().mockResolvedValue({
          error: { message: "upstream is overloaded" },
        }),
      }),
    );

    await expect(
      createProvider().createMessage(createRequest()),
    ).rejects.toMatchObject({
      name: "OpenAICompatibleProviderError",
      status: 503,
      code: "HTTP_503",
      retryable: true,
    });
  });

  it("does not retry authentication failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        json: vi.fn().mockResolvedValue({
          error: { message: "invalid api key" },
        }),
      }),
    );

    await expect(
      createProvider().createMessage(createRequest()),
    ).rejects.toMatchObject({
      status: 401,
      code: "HTTP_401",
      retryable: false,
    });
  });

  it("preserves fetch transport failures as structured retryable errors", async () => {
    const transportError = new TypeError("fetch failed");
    Object.assign(transportError, {
      cause: { code: "UND_ERR_CONNECT_TIMEOUT" },
    });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(transportError));

    let failure: unknown;
    try {
      await createProvider().createMessage(createRequest());
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(OpenAICompatibleProviderError);
    expect(failure).toMatchObject({
      code: "UND_ERR_CONNECT_TIMEOUT",
      retryable: true,
    });
  });

  it("retries a successful HTTP response with malformed JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        json: vi.fn().mockRejectedValue(new SyntaxError("Unexpected EOF")),
      }),
    );

    await expect(
      createProvider().createMessage(createRequest()),
    ).rejects.toMatchObject({
      code: "INVALID_JSON_RESPONSE",
      retryable: true,
    });
  });

  it("preserves malformed tool arguments as a retryable model-response error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        json: vi.fn().mockResolvedValue({
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "call-html",
                    type: "function",
                    function: {
                      name: "write_file",
                      arguments:
                        '{"path":"task_output.html","content":"<html><body>',
                    },
                  },
                ],
              },
            },
          ],
        }),
      }),
    );

    await expect(
      createProvider().createMessage(createRequest()),
    ).rejects.toMatchObject({
      name: "OpenAICompatibleProviderError",
      code: "MALFORMED_TOOL_ARGUMENTS",
      retryable: true,
      retryKind: "malformed_response",
    });
  });
});
