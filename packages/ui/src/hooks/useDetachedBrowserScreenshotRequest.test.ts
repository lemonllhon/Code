import assert from "node:assert/strict";
import test from "node:test";
import { matchesDetachedBrowserScreenshot } from "./useDetachedBrowserScreenshotRequest.js";

test("独立浏览器截图按原身份与当前 guest 匹配，不能被主窗口另一项目或迟到 guest 接管", () => {
  const request = {
    requestId: "capture",
    workspaceKey: "owner-a",
    sessionId: "chat-a",
    remoteSessionId: "attachment-a",
    tabId: "browser-a",
    browserId: "agent-a",
    browserGeneration: 4,
    webContentsId: 12,
    viewport: { width: 800, height: 600 },
  };
  const target = {
    workspaceKey: "owner-a",
    sessionId: "chat-a",
    remoteSessionId: "attachment-a",
    tabId: "browser-a",
    webContentsId: 12,
  };
  assert.equal(matchesDetachedBrowserScreenshot(request, target), true);
  for (const patch of [
    { workspaceKey: "owner-b" },
    { sessionId: "chat-b" },
    { remoteSessionId: "attachment-b" },
    { tabId: "browser-b" },
    { webContentsId: 11 },
    { webContentsId: 0 },
  ])
    assert.equal(matchesDetachedBrowserScreenshot(request, { ...target, ...patch }), false);
});
