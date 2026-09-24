import { describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, Function>(),
  get: vi.fn(),
  refresh: vi.fn(),
  config: vi.fn(),
  save: vi.fn(),
}));
vi.mock("electron", () => ({
  app: { getPath: () => "/test-profile" },
  ipcMain: { handle: (channel: string, fn: Function) => mocks.handlers.set(channel, fn) },
}));
vi.mock("../paper-news/service", () => ({
  PaperNewsService: class {
    snapshot = mocks.get;
    refresh = mocks.refresh;
    saveConfig = mocks.config;
    setSaved = mocks.save;
  },
}));
vi.mock("../utils/network-fetch", () => ({ fetchWithSystemProxy: vi.fn() }));
import { setupPaperNewsHandlers } from "./paper-news-handlers";
import { IPC_CHANNELS } from "../../shared/types";

describe("Paper News IPC boundary", () => {
  it("rejects every operation from foreign windows and subframes", () => {
    const mainFrame = {},
      sender = { mainFrame };
    setupPaperNewsHandlers((event) => event.sender === sender);
    expect(mocks.handlers.size).toBe(4);
    for (const handler of mocks.handlers.values()) {
      expect(() => handler({ sender: {}, senderFrame: mainFrame })).toThrow("restricted");
      expect(() => handler({ sender, senderFrame: {} })).toThrow("restricted");
    }
    mocks.handlers.get(IPC_CHANNELS.PAPER_NEWS_SAVE)!(
      { sender, senderFrame: mainFrame },
      "arxiv:123",
      true,
    );
    expect(mocks.save).toHaveBeenCalledWith("arxiv:123", true);
    mocks.handlers.get(IPC_CHANNELS.PAPER_NEWS_REFRESH)!({ sender, senderFrame: mainFrame });
    expect(mocks.refresh).toHaveBeenCalledOnce();
    mocks.handlers.get(IPC_CHANNELS.PAPER_NEWS_REFRESH)!(
      { sender, senderFrame: mainFrame },
      "github",
    );
    expect(mocks.refresh).toHaveBeenLastCalledWith("github");
    expect(() =>
      mocks.handlers.get(IPC_CHANNELS.PAPER_NEWS_REFRESH)!(
        { sender, senderFrame: mainFrame },
        "https://evil.example",
      ),
    ).toThrow("Invalid paper news source");
  });
});
