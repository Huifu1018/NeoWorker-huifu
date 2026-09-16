import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { BrowserWindow, ContextMenuParams, MenuItemConstructorOptions } from "electron";

const { build, popup } = vi.hoisted(() => ({ build: vi.fn(), popup: vi.fn() }));
vi.mock("electron", () => ({ Menu: { buildFromTemplate: build } }));
import { buildEditContextMenuTemplate, installEditContextMenu } from "../edit-context-menu";

function context(overrides: Partial<ContextMenuParams> = {}): ContextMenuParams {
  return {
    isEditable: true,
    selectionText: "selected text",
    editFlags: {
      canUndo: true,
      canRedo: false,
      canCut: true,
      canCopy: true,
      canPaste: true,
      canDelete: true,
      canSelectAll: true,
      canEditRichly: false,
    },
    frame: { isDestroyed: () => false },
    menuSourceType: "mouse",
    ...overrides,
  } as ContextMenuParams;
}

const roles = (items: MenuItemConstructorOptions[]) =>
  items.flatMap((item) => (item.role ? [item.role] : []));

describe("native edit context menu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    build.mockReturnValue({ popup });
  });

  it("offers standard native editing roles in editable controls", () => {
    const items = buildEditContextMenuTemplate(context(), "en");
    expect(roles(items)).toEqual([
      "undo",
      "redo",
      "cut",
      "copy",
      "paste",
      "pasteAndMatchStyle",
      "delete",
      "selectAll",
    ]);
    expect(items.find((item) => item.role === "redo")?.enabled).toBe(false);
    expect(items.find((item) => item.role === "paste")?.label).toBe("Paste");
    expect(items.every((item) => !item.click)).toBe(true);
  });

  it.each(["zh-CN", "zh-TW", "ZH-cn"])("localizes menu labels for %s", (language) => {
    const items = buildEditContextMenuTemplate(context(), language);
    expect(items.find((item) => item.role === "copy")?.label).toBe("\u590d\u5236");
    expect(items.find((item) => item.role === "paste")?.label).toBe("\u7c98\u8d34");
  });

  it("uses Chinese when older appearance settings have no language", () => {
    const items = buildEditContextMenuTemplate(context(), undefined);
    expect(items.find((item) => item.role === "copy")?.label).toBe("\u590d\u5236");
  });

  it("keeps paste available in an empty composer without enabling destructive actions", () => {
    const params = context({ selectionText: "" });
    Object.assign(params.editFlags, {
      canUndo: false,
      canCut: false,
      canCopy: false,
      canDelete: false,
      canSelectAll: false,
    });
    const items = buildEditContextMenuTemplate(params, "en");
    expect(items.filter((item) => item.enabled).map((item) => item.role)).toEqual([
      "paste",
      "pasteAndMatchStyle",
    ]);
  });

  it("respects Chromium capabilities for every action", () => {
    const params = context();
    for (const key of Object.keys(params.editFlags))
      params.editFlags[key as keyof typeof params.editFlags] = false;
    expect(
      buildEditContextMenuTemplate(params, "en")
        .filter((item) => item.role)
        .every((item) => item.enabled === false),
    ).toBe(true);
  });

  it.each(["message text", "  "])(
    "offers only copy and select-all for read-only selection %j",
    (selectionText) => {
      expect(
        roles(buildEditContextMenuTemplate(context({ isEditable: false, selectionText }), "en")),
      ).toEqual(["copy", "selectAll"]);
    },
  );

  it("does not open an editing menu over unselected non-editable UI", () => {
    expect(
      buildEditContextMenuTemplate(context({ isEditable: false, selectionText: "" }), "en"),
    ).toEqual([]);
  });

  it("does not copy protected read-only content", () => {
    const params = context({ isEditable: false });
    params.editFlags.canCopy = false;
    expect(buildEditContextMenuTemplate(params, "en")).toEqual([]);
  });

  function setup() {
    const contents = Object.assign(new EventEmitter(), { isDestroyed: () => false });
    const window = { webContents: contents, isDestroyed: () => false } as unknown as BrowserWindow;
    const language = vi.fn(() => "zh-CN");
    installEditContextMenu(window, language);
    const event = { defaultPrevented: false, preventDefault: vi.fn() };
    return { contents, window, language, event };
  }

  it("routes native menus to the originating window/frame and refreshes language per click", () => {
    const { contents, window, language, event } = setup();
    const params = context({ menuSourceType: "keyboard" });
    contents.emit("context-menu", event, params);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(popup).toHaveBeenCalledWith({ window, frame: params.frame, sourceType: "keyboard" });
    expect(
      build.mock.calls[0][0].find((item: MenuItemConstructorOptions) => item.role === "copy").label,
    ).toBe("\u590d\u5236");
    language.mockReturnValue("en");
    contents.emit("context-menu", event, params);
    expect(
      build.mock.calls[1][0].find((item: MenuItemConstructorOptions) => item.role === "copy").label,
    ).toBe("Copy");
  });

  it.each(["prevented", "window", "contents", "frame", "missing-frame", "blank"])(
    "does not show a stale or unwanted menu: %s",
    (state) => {
      const { contents, window, event } = setup();
      const params = context();
      if (state === "prevented") event.defaultPrevented = true;
      if (state === "window") window.isDestroyed = () => true;
      if (state === "contents") contents.isDestroyed = () => true;
      if (state === "frame") params.frame!.isDestroyed = () => true;
      if (state === "missing-frame") params.frame = null;
      if (state === "blank") {
        params.isEditable = false;
        params.selectionText = "";
      }
      contents.emit("context-menu", event, params);
      expect(popup).not.toHaveBeenCalled();
    },
  );

  it("installs the menu when the main window is created on every platform", () => {
    const main = readFileSync(new URL("../main.ts", import.meta.url), "utf8");
    expect(main).toContain(
      "installEditContextMenu(mainWindow, () => AppearanceManager.loadSettings().language)",
    );
  });
});
