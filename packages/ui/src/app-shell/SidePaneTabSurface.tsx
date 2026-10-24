import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { GripVerticalIcon, PanelRightIcon, LocateFixedIcon, XIcon } from "lucide-react";
import { Button } from "../components/ui/button.js";
import { Tabs } from "../components/ui/tabs.js";
import { OwnerDocumentProvider } from "../components/ui/owner-document.js";
import { ToolWindowMoveProvider, type ToolWindowMoveGuard } from "../hooks/useToolWindowMove.js";
import type { SidePaneToolWindows } from "../hooks/useSidePaneToolWindows.js";
import { useLCodeIntl } from "../i18n/IntlProvider.js";
import { toolWindowScopeKey, type SidePaneToolWindowOwner } from "../lib/sidePaneToolWindow.js";

/** React 容器恒定，只迁移 DOM；内容位置不再决定组件/session 生命周期。 */
export function SidePaneTabSurface({
  id,
  tabId = id,
  title,
  selected,
  owner,
  currentScopeKey,
  dockTarget,
  onClose,
  windows,
  children,
}: {
  id: string;
  tabId?: string;
  title: string;
  selected: boolean;
  owner?: SidePaneToolWindowOwner;
  currentScopeKey?: string;
  dockTarget?: HTMLDivElement | null;
  onClose?: () => void | boolean | Promise<void | boolean>;
  windows: SidePaneToolWindows;
  children: ReactNode;
}) {
  const { intl } = useLCodeIntl();
  const anchor = useRef<HTMLDivElement>(null);
  const [host] = useState(() =>
    typeof document === "undefined" ? null : document.createElement("div"),
  );
  const [guards] = useState(() => new Set<ToolWindowMoveGuard>());
  const detached = windows.isDetached(id);
  const latest = useRef({ dockTarget, currentScopeKey, onClose, owner });
  latest.current = { dockTarget, currentScopeKey, onClose, owner };
  useLayoutEffect(() => {
    if (!anchor.current || !host) return;
    host.className = "flex h-full min-h-0 w-full flex-col bg-background text-foreground";
    (dockTarget ?? anchor.current).append(host);
    const parking = anchor.current;
    return windows.register(id, {
      host,
      guards,
      tabId,
      get owner() {
        return latest.current.owner;
      },
      get anchor() {
        return latest.current.dockTarget ?? parking;
      },
      canDock: () =>
        !latest.current.owner ||
        (latest.current.currentScopeKey === toolWindowScopeKey(latest.current.owner) &&
          Boolean(latest.current.dockTarget)),
      onClose: onClose ? () => latest.current.onClose?.() : undefined,
    });
  }, [guards, host, id, tabId, windows.register]);
  useLayoutEffect(() => {
    if (!host || detached) return;
    const target = dockTarget ?? anchor.current;
    if (target && host.parentNode !== target) target.append(host);
    host.hidden = !selected;
  }, [detached, dockTarget, host, selected]);
  const ownerDocument = windows.documentFor(id) ?? host?.ownerDocument;
  const ownerLabel = owner ? `${owner.projectName} · ${owner.sessionTitle}` : "";
  useLayoutEffect(() => {
    if (detached && ownerDocument) {
      ownerDocument.title = ownerLabel ? `${ownerLabel} — ${title}` : `${title} — LCode`;
      if (host) host.hidden = false;
    }
  }, [detached, host, ownerDocument, ownerLabel, title]);
  return (
    <div
      ref={anchor}
      className={
        dockTarget !== undefined ? "hidden" : selected && !detached ? "h-full min-h-0" : "hidden"
      }
      data-side-pane-surface={tabId}
    >
      {host && ownerDocument
        ? createPortal(
            <OwnerDocumentProvider document={ownerDocument}>
              <ToolWindowMoveProvider guards={guards}>
                {detached ? (
                  <div
                    className="flex h-9 shrink-0 items-center gap-1 border-b border-border bg-panel px-2 text-ui-sm"
                    data-testid="tool-window-header"
                  >
                    <button
                      type="button"
                      draggable
                      onDragStart={(event) => windows.startDockDrag(event, id)}
                      onDragEnd={windows.endDockDrag}
                      aria-label={intl.formatMessage({ id: "sidePane.dragToDock" })}
                      title={intl.formatMessage({ id: "sidePane.dragToDock" })}
                      className="cursor-grab rounded-sm p-1 active:cursor-grabbing"
                    >
                      <GripVerticalIcon className="size-4" />
                    </button>
                    <span
                      className="min-w-0 flex-1 truncate"
                      title={ownerLabel ? `${ownerLabel} — ${title}` : title}
                    >
                      {ownerLabel ? (
                        <span data-testid="tool-window-owner" className="mr-2 font-medium">
                          {ownerLabel}
                        </span>
                      ) : null}
                      <span className="text-foreground-subtle">{title}</span>
                    </span>
                    {owner ? (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={intl.formatMessage({ id: "sidePane.locateOwner" })}
                        title={intl.formatMessage({ id: "sidePane.locateOwner" })}
                        onClick={() => windows.locate(id)}
                      >
                        <LocateFixedIcon className="size-4" />
                      </Button>
                    ) : null}
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={intl.formatMessage({ id: "sidePane.dockWindow" })}
                      title={intl.formatMessage({ id: "sidePane.dockWindow" })}
                      onClick={() => {
                        void windows.dock(id);
                      }}
                    >
                      <PanelRightIcon className="size-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={intl.formatMessage({ id: "sidePane.closeCurrentTab" })}
                      onClick={() => {
                        void windows.requestClose(id);
                      }}
                    >
                      <XIcon className="size-4" />
                    </Button>
                  </div>
                ) : null}
                <Tabs value={tabId} className="min-h-0 flex-1 gap-0">
                  {children}
                </Tabs>
              </ToolWindowMoveProvider>
            </OwnerDocumentProvider>,
            host,
          )
        : null}
    </div>
  );
}
