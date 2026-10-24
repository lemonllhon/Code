import assert from "node:assert/strict";
import test from "node:test";
import { DesktopBrowserScreenshotSurfaceCoordinator } from "./browserScreenshotSurfaceCoordinator.js";
import type {
  BrowserViewScreenshotSurfacePreparePayload,
  BrowserViewScreenshotSurfaceReleasePayload,
} from "@lcode/shared";

test("截图握手贯穿 attachment 身份，旧远程连接的 ready 不得释放新连接请求", async () => {
  const prepare: BrowserViewScreenshotSurfacePreparePayload[] = [];
  const release: BrowserViewScreenshotSurfaceReleasePayload[] = [];
  const coordinator = new DesktopBrowserScreenshotSurfaceCoordinator({
    sendPrepare: (_, payload) => {
      prepare.push(payload);
      return true;
    },
    sendRelease: (_, payload) => {
      release.push(payload);
    },
  });
  try {
    const pending = coordinator.prepare({
      requestId: "request",
      windowId: 1,
      workspaceKey: "scope",
      remoteSessionId: "new-attachment",
      sessionId: "chat",
      browserId: "browser",
      browserGeneration: 2,
      tabId: "tab",
      webContentsId: 12,
      viewport: { width: 640, height: 400 },
      signal: new AbortController().signal,
    });
    assert.equal(prepare[0]?.remoteSessionId, "new-attachment");
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    coordinator.handleReady({
      windowId: 1,
      senderWebContentsId: 11,
      payload: { ...prepare[0]!, remoteSessionId: "old-attachment", surfaceScale: 1 },
    });
    await Promise.resolve();
    assert.equal(settled, false);
    coordinator.handleReady({
      windowId: 1,
      senderWebContentsId: 11,
      payload: { ...prepare[0]!, surfaceScale: 1 },
    });
    const lease = await pending;
    lease.release();
    assert.equal(release[0]?.remoteSessionId, "new-attachment");
  } finally {
    coordinator.dispose();
  }
});
