// Run after build:electron: node scripts/qa/edit-context-menu.cjs
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const assert = require("node:assert/strict");

if (process.versions.electron) {
  const { app, BrowserWindow, Menu } = require("electron");
  const { installEditContextMenu } = require("../../dist/electron/electron/edit-context-menu.js");
  app.whenReady().then(async () => {
    const window = new BrowserWindow({
      width: 800,
      height: 600,
      webPreferences: { sandbox: true },
    });
    global.qaMenus = [];
    const build = Menu.buildFromTemplate.bind(Menu);
    Menu.buildFromTemplate = (template) => {
      const menu = build(template);
      global.qaMenus.push(menu);
      return menu;
    };
    installEditContextMenu(window, () => "zh-CN");
    await window.loadURL(
      `data:text/html,${encodeURIComponent(`<!doctype html>
      <style>body{padding:30px}textarea,[contenteditable],p,button{display:block;margin:20px 0;width:500px;min-height:40px}</style>
      <textarea id="composer"></textarea>
      <div id="rich" contenteditable="true">Rich input</div>
      <p id="message">Assistant message for copying</p>
      <button id="custom">Existing custom menu</button>
      <script>
        window.pastes = [];
        document.addEventListener('paste', e => window.pastes.push(e.clipboardData.getData('text/plain')));
        document.querySelector('#custom').oncontextmenu = e => { e.preventDefault(); window.customOpened = true; };
      </script>`)}`,
    );
    window.show();
    window.focus();
  });
} else {
  const { _electron } = require("playwright");
  (async () => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "neoworker-context-menu-qa-"));
    let electron;
    let clipboardSnapshot;
    try {
      electron = await _electron.launch({
        args: [__filename, `--user-data-dir=${profile}`],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "" },
      });
      const page = await electron.firstWindow();
      await page.waitForSelector("#composer");
      clipboardSnapshot = await electron.evaluate(({ clipboard }) =>
        clipboard
          .availableFormats()
          .map((format) => [format, clipboard.readBuffer(format).toString("base64")]),
      );
      await electron.evaluate(({ clipboard }) => clipboard.writeText("clipboard paste test"));
      const menus = () => electron.evaluate(() => global.qaMenus.length);
      async function open(selector) {
        const count = await menus();
        await page.locator(selector).click({ button: "right", position: { x: 12, y: 10 } });
        await page.waitForTimeout(200);
        assert.equal(await menus(), count + 1, `Missing native menu on ${selector}`);
        return electron.evaluate(({ BrowserWindow }) => {
          const menu = global.qaMenus.at(-1);
          menu.closePopup(BrowserWindow.getAllWindows()[0]);
          return menu.items
            .filter((item) => item.type !== "separator")
            .map((item) => ({ role: item.role, enabled: item.enabled, label: item.label }));
        });
      }
      async function invoke(role) {
        await electron.evaluate(({ BrowserWindow, Menu }, role) => {
          const window = BrowserWindow.getAllWindows()[0];
          const item = global.qaMenus.at(-1).items.find((item) => item.role === role);
          if (!item?.enabled) throw new Error(`Unavailable menu command: ${role}`);
          // macOS native roles use Cocoa's responder chain, not MenuItem.click.
          if (process.platform === "darwin") Menu.sendActionToFirstResponder(`${role}:`);
          else item.click(undefined, window, window.webContents);
        }, role);
        await page.waitForTimeout(100);
      }

      const empty = await open("#composer");
      assert(empty.find((item) => item.role === "paste" && item.enabled));
      assert(!empty.find((item) => item.role === "copy").enabled);
      assert.equal(empty.find((item) => item.role === "paste").label, "\u7c98\u8d34");
      await invoke("paste");
      assert.equal(await page.locator("#composer").inputValue(), "clipboard paste test");
      assert.deepEqual(await page.evaluate(() => window.pastes), ["clipboard paste test"]);
      await open("#composer");
      await invoke("undo");
      assert.equal(await page.locator("#composer").inputValue(), "");
      await open("#composer");
      await invoke("redo");
      assert.equal(await page.locator("#composer").inputValue(), "clipboard paste test");
      await page.locator("#composer").selectText();
      await open("#composer");
      await invoke("cut");
      assert.equal(await page.locator("#composer").inputValue(), "");
      assert.equal(
        await electron.evaluate(({ clipboard }) => clipboard.readText()),
        "clipboard paste test",
      );
      await page.locator("#message").selectText();
      const readonly = await open("#message");
      assert.deepEqual(
        readonly.map((item) => item.role),
        ["copy", "selectall"],
      );
      await invoke("copy");
      assert.equal(
        await electron.evaluate(({ clipboard }) => clipboard.readText()),
        "Assistant message for copying",
      );
      await open("#rich");
      await invoke("paste");
      assert((await page.locator("#rich").innerText()).includes("Assistant message for copying"));
      const count = await menus();
      await page.locator("#custom").click({ button: "right" });
      await page.waitForTimeout(200);
      assert.equal(await menus(), count, "Native menu replaced a custom context menu");
      assert.equal(await page.evaluate(() => window.customOpened), true);
      await page.evaluate(() => window.getSelection().removeAllRanges());
      await page.mouse.click(750, 550, { button: "right" });
      await page.waitForTimeout(200);
      assert.equal(await menus(), count, "Unexpected menu on blank space");
      console.log(
        "PASS: native menus, localized labels, paste event, undo/redo, cut/copy, rich input, custom menu, blank space",
      );
    } finally {
      if (electron) {
        if (clipboardSnapshot)
          await electron.evaluate(({ clipboard }, entries) => {
            clipboard.clear();
            for (const [format, data] of entries)
              clipboard.writeBuffer(format, Buffer.from(data, "base64"));
          }, clipboardSnapshot);
        await electron.close();
      }
      fs.rmSync(profile, { recursive: true, force: true });
    }
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
