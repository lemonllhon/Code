import { useEffect, useRef, useState } from "react";
import type { BrowserViewScreenshotSurfacePreparePayload } from "@lcode/shared";
import { usePlatform } from "./usePlatform.js";
import { safeWebviewCall } from "../embeddedBrowserHelpers.js";

interface DetachedBrowserTarget {
  tabId: string;
  workspaceKey?: string;
  sessionId?: string;
  remoteSessionId?: string;
  webContentsId: number;
}

export function matchesDetachedBrowserScreenshot(
  request: BrowserViewScreenshotSurfacePreparePayload,
  target: DetachedBrowserTarget,
): boolean {
  return (
    target.webContentsId > 0 &&
    request.webContentsId === target.webContentsId &&
    request.tabId === target.tabId &&
    request.workspaceKey === target.workspaceKey &&
    request.sessionId === target.sessionId &&
    request.remoteSessionId === target.remoteSessionId
  );
}

/** native window 固定在原 workspace；截图握手不能跟随主窗口当前的标签列表。 */
export function useDetachedBrowserScreenshotRequest({
  enabled,
  tabId,
  workspaceKey,
  sessionId,
  remoteSessionId,
  webview,
}: Omit<DetachedBrowserTarget, "webContentsId"> & {
  enabled: boolean;
  webview: ElectronWebviewTag | null;
}) {
  const platform = usePlatform();
  const [request, setRequest] = useState<BrowserViewScreenshotSurfacePreparePayload | null>(null);
  const latest = useRef({ tabId, workspaceKey, sessionId, remoteSessionId, webview });
  latest.current = { tabId, workspaceKey, sessionId, remoteSessionId, webview };
  useEffect(() => {
    if (!enabled) {
      setRequest(null);
      return;
    }
    const prepare = platform.onBrowserViewScreenshotSurfacePrepare?.((payload) => {
      const target = latest.current;
      const webContentsId = target.webview
        ? safeWebviewCall(() => target.webview!.getWebContentsId(), 0)
        : 0;
      if (matchesDetachedBrowserScreenshot(payload, { ...target, webContentsId }))
        setRequest((current) =>
          current && current.requestId !== payload.requestId ? current : payload,
        );
    });
    const release = platform.onBrowserViewScreenshotSurfaceRelease?.((payload) => {
      setRequest((current) =>
        current &&
        current.requestId === payload.requestId &&
        current.webContentsId === payload.webContentsId &&
        current.workspaceKey === payload.workspaceKey &&
        current.sessionId === payload.sessionId &&
        current.remoteSessionId === payload.remoteSessionId &&
        current.tabId === payload.tabId &&
        current.browserId === payload.browserId &&
        current.browserGeneration === payload.browserGeneration
          ? null
          : current,
      );
    });
    return () => {
      prepare?.();
      release?.();
    };
  }, [enabled, platform]);
  return request;
}
