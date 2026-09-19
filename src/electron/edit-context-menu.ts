import {
  Menu,
  type BrowserWindow,
  type ContextMenuParams,
  type MenuItemConstructorOptions,
} from "electron";

type EditContext = Pick<ContextMenuParams, "isEditable" | "selectionText" | "editFlags">;

const labels = {
  en: {
    undo: "Undo",
    redo: "Redo",
    cut: "Cut",
    copy: "Copy",
    paste: "Paste",
    pasteAndMatchStyle: "Paste and Match Style",
    delete: "Delete",
    selectAll: "Select All",
  },
  zh: {
    undo: "\u64a4\u9500",
    redo: "\u91cd\u505a",
    cut: "\u526a\u5207",
    copy: "\u590d\u5236",
    paste: "\u7c98\u8d34",
    pasteAndMatchStyle: "\u7c98\u8d34\u5e76\u5339\u914d\u6837\u5f0f",
    delete: "\u5220\u9664",
    selectAll: "\u5168\u9009",
  },
};

export function buildEditContextMenuTemplate(
  params: EditContext,
  language: string = "zh-CN",
): MenuItemConstructorOptions[] {
  const text = language.toLowerCase().startsWith("zh") ? labels.zh : labels.en;
  const flags = params.editFlags;
  const item = (role: keyof typeof text, enabled: boolean): MenuItemConstructorOptions => ({
    role,
    label: text[role],
    enabled,
  });

  if (!params.isEditable) {
    if (!params.selectionText || !flags.canCopy) return [];
    return [item("copy", true), { type: "separator" }, item("selectAll", flags.canSelectAll)];
  }

  return [
    item("undo", flags.canUndo),
    item("redo", flags.canRedo),
    { type: "separator" },
    item("cut", flags.canCut),
    item("copy", flags.canCopy),
    item("paste", flags.canPaste),
    item("pasteAndMatchStyle", flags.canPaste),
    item("delete", flags.canDelete),
    { type: "separator" },
    item("selectAll", flags.canSelectAll),
  ];
}

export function installEditContextMenu(
  window: BrowserWindow,
  getLanguage: () => string | undefined,
): void {
  window.webContents.on("context-menu", (event, params) => {
    if (event.defaultPrevented || window.isDestroyed() || window.webContents.isDestroyed()) return;
    const frame = params.frame;
    if (!frame || frame.isDestroyed()) return;
    const template = buildEditContextMenuTemplate(params, getLanguage());
    if (!template.length) return;

    event.preventDefault();
    // Native roles preserve selection, undo history, and the renderer's paste handling.
    Menu.buildFromTemplate(template).popup({
      window,
      frame,
      sourceType: params.menuSourceType,
    });
  });
}
