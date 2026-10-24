import { app, ipcMain, type BrowserWindow } from "electron";
import { PlatformChannels } from "@lcode/shared";

type ToolWindowEntry = { window: BrowserWindow; closing: boolean };
const owners = new Map<number, Map<string, ToolWindowEntry>>();
let registered = false;

export function configureDesktopToolWindows(
  win: BrowserWindow,
  configureChild: (child: BrowserWindow) => void,
) {
  const children = new Map<string, ToolWindowEntry>();
  const ownerId = win.webContents.id;
  owners.set(ownerId, children);
  if (!registered) {
    registered = true;
    app.on("before-quit", (event) => {
      if (event.defaultPrevented) return;
      for (const children of owners.values())
        for (const entry of children.values()) entry.closing = true;
    });
    ipcMain.on(PlatformChannels.CloseToolWindow, (event, id: unknown) => {
      if (typeof id !== "string") return;
      const entry = owners.get(event.sender.id)?.get(id);
      if (!entry || entry.window.isDestroyed()) return;
      entry.closing = true;
      entry.window.close();
    });
  }
  win.webContents.setWindowOpenHandler(({ url, frameName }) => {
    if (url !== "about:blank" || !/^lcode-tool-[0-9a-f-]{36}$/u.test(frameName))
      return { action: "deny" };
    return {
      action: "allow",
      overrideBrowserWindowOptions: {
        minWidth: 360,
        minHeight: 240,
        autoHideMenuBar: true,
        frame: true,
        titleBarStyle: "default",
        resizable: true,
        webPreferences: {
          preload: "",
          contextIsolation: true,
          nodeIntegration: false,
          webviewTag: true,
          webSecurity: true,
          zoomFactor: win.webContents.getZoomFactor(),
        },
      },
    };
  });
  win.webContents.on("did-create-window", (child, details) => {
    const id = details.frameName.slice("lcode-tool-".length);
    const entry = { window: child, closing: false };
    children.set(id, entry);
    configureChild(child);
    child.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    child.webContents.on("will-navigate", (event) => event.preventDefault());
    child.on("close", (event) => {
      if (entry.closing) return;
      event.preventDefault();
      // 系统 × 与工具内 × 都由原 Renderer 裁决和释放业务资源，Main 只转发窗口意图。
      void child.webContents
        .executeJavaScript('window.dispatchEvent(new Event("lcode-tool-window-close-requested"))')
        .catch(() => {});
    });
    child.once("closed", () => children.delete(id));
  });
  win.once("closed", () => {
    owners.delete(ownerId);
    for (const { window: child } of children.values()) if (!child.isDestroyed()) child.destroy();
  });
}
