import { afterEach, describe, expect, it } from "vitest";
import { applyPersistedLanguage } from "../../i18n";
import { localizeErrorText } from "../localized-error-text";

describe("localizeErrorText", () => {
  afterEach(() => {
    applyPersistedLanguage("en");
  });

  it("keeps the original message when English is selected", () => {
    applyPersistedLanguage("en");
    const message =
      "Iteration limit exceeded: 100/100 iterations. Task stopped to prevent runaway execution.";

    expect(localizeErrorText(message)).toBe(message);
  });

  it("localizes iteration guardrail errors when Chinese is selected", () => {
    applyPersistedLanguage("zh-CN");

    expect(
      localizeErrorText(
        "Iteration limit exceeded: 100/100 iterations. Task stopped to prevent runaway execution.",
      ),
    ).toBe("已达到迭代次数上限：100/100 次。为防止任务失控，任务已停止。");
  });

  it("localizes budget and provider errors", () => {
    applyPersistedLanguage("zh-CN");

    expect(
      localizeErrorText(
        "Token budget exceeded: 12,500/10,000 tokens. Estimated cost: $1.25",
      ),
    ).toBe("已超出 Token 预算：12,500/10,000。预估费用：$1.25");
    expect(
      localizeErrorText("Rate limit exceeded. Will retry automatically."),
    ).toBe("请求频率已超出限制，系统将自动重试。");
  });

  it("localizes app-authored wrappers but preserves unknown diagnostics", () => {
    applyPersistedLanguage("zh-CN");

    expect(localizeErrorText("Error")).toBe("错误");
    expect(localizeErrorText("Task execution failed: socket hang up")).toBe(
      "任务执行失败：socket hang up",
    );
    expect(localizeErrorText("ECONNRESET from upstream.example")).toBe(
      "ECONNRESET from upstream.example",
    );
  });

  it("localizes execution-service failures, including persisted follow-up text", () => {
    applyPersistedLanguage("zh-CN");

    expect(
      localizeErrorText(
        "Task execution service unavailable. Automatic fallback is disabled for this task.",
      ),
    ).toBe(
      "任务执行服务暂时不可用，并且该任务已禁用自动回退。请重新打开应用后重试。",
    );
    expect(
      localizeErrorText(
        "Task execution service unavailable for follow-up. Automatic fallback is disabled for this task.",
      ),
    ).toBe(
      "任务执行服务暂时不可用，并且该任务已禁用自动回退。请重新打开应用后重试。",
    );
    expect(
      localizeErrorText(
        "Preferred execution service unavailable; automatic fallback is unavailable.",
      ),
    ).toBe("首选执行服务暂时不可用，当前无法自动切换到备用执行方式。");
  });

  it("localizes common tool and Office validation failures", () => {
    applyPersistedLanguage("zh-CN");

    expect(localizeErrorText("Tool web_fetch timed out after 30s")).toBe(
      "工具 web_fetch 执行超时（30 秒）。",
    );
    expect(
      localizeErrorText(
        "Tool run_command blocked by policy: Workspace shell capability is disabled.",
      ),
    ).toBe("工具 run_command 被权限策略拦截：当前工作区未启用 Shell。");
    expect(
      localizeErrorText("Unsupported presentation field at slides[0].0"),
    ).toBe("演示文稿参数格式不受支持：slides[0].0。");
    expect(localizeErrorText("At least one worksheet is required.")).toBe(
      "表格参数无效：至少需要一个工作表。",
    );
    expect(
      localizeErrorText(
        "Multi-format Office requests require one shared contentSnapshot before generating DOCX, PPTX, or XLSX.",
      ),
    ).toBe(
      "生成多种 Office 文件前，必须先提供一份共享内容快照（contentSnapshot）。",
    );
    expect(
      localizeErrorText(
        "Completion blocked: requested output was not generated (.pdf).",
      ),
    ).toBe("任务未完成：没有生成请求的输出文件（.pdf）。");
    expect(localizeErrorText("Tool execution failed")).toBe("工具执行失败。");
    expect(localizeErrorText("[object Object]")).toBe("工具执行失败。");
    expect(localizeErrorText("Command exited with code 1")).toBe(
      "命令执行失败（退出码 1）。",
    );
    expect(localizeErrorText("net::ERR_CONNECTION_CLOSED")).toBe(
      "网页连接被对方服务器中断，NeoWorker 将改用其他来源。",
    );
    expect(localizeErrorText("HTTP 432")).toBe(
      "该网站拒绝了访问请求（HTTP 432），NeoWorker 将改用其他来源。",
    );
  });

  it("localizes background WeChat errors without leaking Chinese in English mode", () => {
    const error = "WeChat attachment exceeds the 25MB limit";
    applyPersistedLanguage("en");
    expect(localizeErrorText(error)).toBe(error);

    applyPersistedLanguage("zh-CN");
    expect(localizeErrorText(error)).toBe("微信附件超过 25MB 限制");
    expect(
      localizeErrorText(
        "WeChat login has expired. Scan the QR code to reconnect.",
      ),
    ).toBe("微信登录已失效，请重新扫码连接。");
  });
});
