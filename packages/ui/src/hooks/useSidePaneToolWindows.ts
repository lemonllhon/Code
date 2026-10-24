import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import type { DragEvent } from "react";
import type { IPlatformService } from "@lcode/shared";
import { usePlatform } from "./usePlatform.js";
import { useLCodeIntl } from "../i18n/IntlProvider.js";
import { toast } from "../components/ui/toast.js";
import { logger } from "../logger.js";
import type { ToolWindowMoveGuard } from "./useToolWindowMove.js";
import { synchronizeToolWindowDocument } from "../app-shell/toolWindowDocument.js";
import { toolWindowWorkspaceKey, type SidePaneToolWindowOwner } from "../lib/sidePaneToolWindow.js";
import { retainTaskSidePaneMemory } from "../lib/taskSidePaneMemory.js";
import { subscribeTaskLifecycle } from "../lib/taskLifecycleEvents.js";

type NativeToolWindow = NonNullable<ReturnType<NonNullable<IPlatformService["openToolWindow"]>>>;
export type ToolWindowSurface = {
  host: HTMLDivElement;
  anchor: HTMLDivElement;
  guards: Set<ToolWindowMoveGuard>;
  tabId?: string;
  owner?: SidePaneToolWindowOwner;
  canDock?: () => boolean;
  onClose?: () => void | boolean | Promise<void | boolean>;
};
type WindowEntry = { handle: NativeToolWindow; dispose: () => void; token: string };
const MIME = "application/x-lcode-tool-window";

/** 唯一持有 native handle 的呈现控制器。标签事实和资源关闭始终交给 useAppPanels。 */
export function useSidePaneToolWindows({
  enabled,
  onCloseTab,
  onActivateTab,
  onLocateOwner,
  isTabOpen,
  openWorkspaceKeys,
}: {
  enabled: boolean;
  onCloseTab: (id: string) => void | boolean | Promise<void | boolean>;
  onActivateTab: (id: string) => void;
  onLocateOwner?: (owner: SidePaneToolWindowOwner) => void;
  isTabOpen?: (workspaceKey: string, tabId: string) => boolean;
  openWorkspaceKeys?: readonly string[];
}) {
  const platform = usePlatform();
  const { intl } = useLCodeIntl();
  const [version, invalidate] = useReducer((value: number) => value + 1, 0);
  const [dockDragOwner, setDockDragOwner] = useState<string | null>(null);
  const surfaces = useRef(new Map<string, ToolWindowSurface>());
  const windows = useRef(new Map<string, WindowEntry>());
  const transitions = useRef(new Set<string>());
  const pendingClose = useRef(new Set<string>());
  const dockWaiters = useRef(
    new Map<string, { promise: Promise<boolean>; resolve: (ready: boolean) => void }>(),
  );
  const callbacks = useRef({ onCloseTab, onActivateTab, onLocateOwner, isTabOpen });
  callbacks.current = { onCloseTab, onActivateTab, onLocateOwner, isTabOpen };
  const available = enabled && Boolean(platform.openToolWindow);
  const fail = useCallback(
    (error?: unknown) => {
      logger.warn("[side-pane] 工具窗口迁移失败，保留当前标签", {
        error: String(error ?? "unavailable"),
      });
      toast(intl.formatMessage({ id: "sidePane.windowMoveFailed" }), { variant: "warning" });
    },
    [intl],
  );
  const release = useCallback((id: string) => {
    const entry = windows.current.get(id);
    if (!entry) return;
    windows.current.delete(id);
    pendingClose.current.delete(id);
    dockWaiters.current.get(id)?.resolve(false);
    dockWaiters.current.delete(id);
    entry.dispose();
    entry.handle.close();
    invalidate();
  }, []);
  const prepare = useCallback(async (id: string, surface: ToolWindowSurface) => {
    for (const guard of surface.guards) {
      if (!(await guard.prepare())) return false;
      if (surfaces.current.get(id) !== surface) return false;
    }
    return surfaces.current.get(id) === surface;
  }, []);
  const requestClose = useCallback(
    async (id: string) => {
      if (transitions.current.has(id)) {
        pendingClose.current.add(id);
        return;
      }
      const surface = surfaces.current.get(id);
      if (!surface) return;
      transitions.current.add(id);
      try {
        // 关闭交给原标签的资源 authority；移动守卫不能阻止用户关闭正在运行的工具。
        const closed = await (surface.onClose
          ? surface.onClose()
          : callbacks.current.onCloseTab(surface.tabId ?? id));
        if (closed === false) fail();
        else release(id);
      } catch (error) {
        fail(error);
      } finally {
        transitions.current.delete(id);
      }
    },
    [fail, release],
  );
  const locate = useCallback((id: string) => {
    const owner = surfaces.current.get(id)?.owner;
    if (owner) callbacks.current.onLocateOwner?.(owner);
  }, []);
  const waitForDock = useCallback(
    (id: string) => {
      const surface = surfaces.current.get(id);
      if (!surface?.canDock || surface.canDock()) return Promise.resolve(true);
      const existing = dockWaiters.current.get(id);
      if (existing) return existing.promise;
      let resolve!: (ready: boolean) => void;
      const promise = new Promise<boolean>((done) => {
        resolve = done;
      });
      dockWaiters.current.set(id, { promise, resolve });
      locate(id);
      return promise;
    },
    [locate],
  );
  useLayoutEffect(() => {
    for (const [id, waiter] of dockWaiters.current) {
      if (!surfaces.current.get(id)?.canDock?.()) continue;
      dockWaiters.current.delete(id);
      waiter.resolve(true);
    }
  });
  const detach = useCallback(
    async (id: string, position?: { left: number; top: number }) => {
      const existing = windows.current.get(id);
      if (existing) {
        existing.handle.focus();
        return;
      }
      const surface = surfaces.current.get(id);
      if (!available || !surface || transitions.current.has(id)) return;
      transitions.current.add(id);
      let handle: NativeToolWindow | null = null;
      let cleanup: Array<() => void> = [];
      try {
        const token = crypto.randomUUID();
        const bounds = surface.anchor.getBoundingClientRect();
        handle = platform.openToolWindow!({
          id: token,
          width: Math.max(480, bounds.width),
          height: Math.max(360, bounds.height),
          ...position,
        });
        if (!handle) throw new Error("window creation failed");
        cleanup.push(
          handle.onCloseRequested(() => {
            void requestClose(id);
          }),
        );
        if (!(await prepare(id, surface))) {
          for (const dispose of cleanup) dispose();
          cleanup = [];
          handle.close();
          fail();
          return;
        }
        const target = handle.document as Document;
        const disposeStyles = synchronizeToolWindowDocument(surface.host.ownerDocument, target);
        cleanup.push(disposeStyles);
        const releaseMemory = surface.owner
          ? retainTaskSidePaneMemory(toolWindowWorkspaceKey(surface.owner))
          : () => {};
        cleanup.push(releaseMemory);
        surface.host.remove();
        for (const guard of surface.guards) guard.reconnect?.();
        target.body.append(surface.host);
        const disposers = cleanup;
        windows.current.set(id, {
          handle,
          token,
          dispose: () => {
            for (const dispose of disposers) dispose();
          },
        });
        cleanup = [];
        invalidate();
        handle.focus();
      } catch (error) {
        for (const dispose of cleanup) dispose();
        handle?.close();
        fail(error);
      } finally {
        transitions.current.delete(id);
        if (pendingClose.current.delete(id) && windows.current.has(id)) void requestClose(id);
      }
    },
    [available, fail, platform, prepare, requestClose],
  );
  const dock = useCallback(
    async (id: string, activate = true) => {
      const surface = surfaces.current.get(id);
      if (!surface || !windows.current.has(id) || transitions.current.has(id)) return;
      const entry = windows.current.get(id);
      if (
        !(await waitForDock(id)) ||
        windows.current.get(id) !== entry ||
        transitions.current.has(id)
      )
        return;
      transitions.current.add(id);
      try {
        if (!(await prepare(id, surface))) {
          fail();
          return;
        }
        // 先把仍挂载的 DOM 移回 opener，再销毁 native window，避免组件被随窗口释放。
        surface.host.remove();
        for (const guard of surface.guards) guard.reconnect?.();
        surface.anchor.append(surface.host);
        release(id);
        if (activate) callbacks.current.onActivateTab(surface.tabId ?? id);
      } catch (error) {
        fail(error);
      } finally {
        transitions.current.delete(id);
        if (pendingClose.current.delete(id) && windows.current.has(id)) void requestClose(id);
      }
    },
    [fail, prepare, release, requestClose, waitForDock],
  );
  const runInOwner = useCallback(
    async (id: string, command: () => void) => {
      if (await waitForDock(id)) command();
    },
    [waitForDock],
  );
  const register = useCallback(
    (id: string, surface: ToolWindowSurface) => {
      surfaces.current.set(id, surface);
      return () => {
        if (surfaces.current.get(id) !== surface) return;
        surfaces.current.delete(id);
        release(id);
      };
    },
    [release],
  );
  useEffect(
    () => () => {
      for (const entry of windows.current.values()) {
        entry.dispose();
        entry.handle.close();
      }
      windows.current.clear();
      for (const waiter of dockWaiters.current.values()) waiter.resolve(false);
      dockWaiters.current.clear();
    },
    [],
  );
  useEffect(() => {
    for (const id of windows.current.keys()) {
      const surface = surfaces.current.get(id);
      if (!surface?.owner) continue;
      const key = toolWindowWorkspaceKey(surface.owner);
      if (openWorkspaceKeys && !openWorkspaceKeys.includes(key)) {
        void requestClose(id);
        continue;
      }
      if (callbacks.current.isTabOpen?.(key, surface.tabId ?? id) === false) release(id);
    }
  });
  const readDrop = (event: DragEvent) => {
    const token = event.dataTransfer.getData(MIME);
    return [...windows.current].find(([, entry]) => entry.token === token)?.[0];
  };
  useEffect(
    () =>
      subscribeTaskLifecycle((event) => {
        if (event.type !== "deleted") return;
        for (const id of windows.current.keys()) {
          const owner = surfaces.current.get(id)?.owner;
          if (
            owner?.sessionId === event.taskId &&
            toolWindowWorkspaceKey(owner) === event.workspaceKey
          )
            void requestClose(id);
        }
      }),
    [requestClose],
  );
  return {
    available,
    dockDragOwner,
    endDockDrag: () => setDockDragOwner(null),
    version,
    refreshSurfaces: invalidate,
    register,
    detach,
    dock,
    requestClose,
    locate,
    runInOwner,
    isDetached: (id: string) => windows.current.has(id),
    documentFor: (id: string) => windows.current.get(id)?.handle.document as Document | undefined,
    focus: (id: string) => windows.current.get(id)?.handle.focus(),
    startDockDrag: (event: DragEvent, id: string) => {
      const entry = windows.current.get(id);
      if (entry) {
        const owner = surfaces.current.get(id)?.owner;
        setDockDragOwner(owner ? `${owner.projectName} · ${owner.sessionTitle}` : "");
        event.dataTransfer.setData(MIME, entry.token);
        event.dataTransfer.effectAllowed = "move";
      }
    },
    dropProps: {
      onDragOver: (event: DragEvent) => {
        if (event.dataTransfer.types.includes(MIME)) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
        }
      },
      onDrop: (event: DragEvent) => {
        const id = readDrop(event);
        if (id) {
          setDockDragOwner(null);
          event.preventDefault();
          event.stopPropagation();
          void dock(id);
        }
      },
    },
  };
}

export type SidePaneToolWindows = ReturnType<typeof useSidePaneToolWindows>;
