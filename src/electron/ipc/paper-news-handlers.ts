import { app, ipcMain, type IpcMainInvokeEvent } from "electron";
import * as path from "node:path";
import { IPC_CHANNELS } from "../../shared/types";
import { PaperNewsService } from "../paper-news/service";
import { fetchWithSystemProxy } from "../utils/network-fetch";

export function setupPaperNewsHandlers(isTrusted: (event: IpcMainInvokeEvent) => boolean): void {
  const service = new PaperNewsService(
    path.join(app.getPath("userData"), "paper-news.json"),
    fetchWithSystemProxy,
  );
  const handle = (channel: string, run: (...args: unknown[]) => unknown) => {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      if (!isTrusted(event) || event.senderFrame !== event.sender.mainFrame)
        throw new Error("Paper news access is restricted to the main app window");
      return run(...args);
    });
  };
  handle(IPC_CHANNELS.PAPER_NEWS_GET, () => service.snapshot());
  handle(IPC_CHANNELS.PAPER_NEWS_REFRESH, () => service.refresh());
  handle(IPC_CHANNELS.PAPER_NEWS_CONFIG, (config: unknown) => service.saveConfig(config));
  handle(IPC_CHANNELS.PAPER_NEWS_SAVE, (id: unknown, saved: unknown) =>
    service.setSaved(id, saved),
  );
}
