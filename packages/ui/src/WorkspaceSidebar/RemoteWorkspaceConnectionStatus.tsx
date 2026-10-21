import { LoaderCircle } from "lucide-react";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import type { RemoteTarget } from "@lcode/shared";
import type { RemoteConnectionLogEntry } from "@/hooks/useRemoteConnectionLogs.js";
import { ReconnectingRemoteWorkspaceLogTooltip } from "./ReconnectingRemoteWorkspaceLogTooltip.js";
import { cn } from "@/components/lib/utils.js";

export function RemoteWorkspaceConnectionStatus({
  target,
  connected,
  connecting,
  failed,
  logs,
}: {
  target?: RemoteTarget;
  connected: boolean;
  connecting: boolean;
  failed: boolean;
  logs: RemoteConnectionLogEntry[];
}) {
  const { intl } = useLCodeIntl();
  // tab 中的 sessionId 可能是恢复占位；只用 resolver 的当前 rpcReady 证明已连接。
  const state = connected ? "connected" : connecting ? "connecting" : failed ? "failed" : "idle";
  const messageId = {
    connected: "workspaceSidebar.connected",
    connecting: "workspaceSidebar.connecting",
    failed: "workspaceSidebar.connectionFailed",
    idle: "workspaceSidebar.notConnected",
  }[state];
  const status = (
    <span
      role="status"
      tabIndex={connecting ? 0 : undefined}
      data-remote-connection-state={state}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-ui-xs",
        state === "connected"
          ? "text-success"
          : state === "failed"
            ? "text-destructive"
            : "text-foreground-subtle",
      )}
    >
      {connecting ? (
        <LoaderCircle
          aria-hidden="true"
          className="size-3 animate-spin motion-reduce:animate-none"
        />
      ) : null}
      {target ? (
        <span>{target.kind === "docker" ? "Docker" : target.kind.toUpperCase()} · </span>
      ) : null}
      {intl.formatMessage({ id: messageId })}
    </span>
  );
  return connecting ? (
    <ReconnectingRemoteWorkspaceLogTooltip logs={logs}>
      {status}
    </ReconnectingRemoteWorkspaceLogTooltip>
  ) : (
    status
  );
}
