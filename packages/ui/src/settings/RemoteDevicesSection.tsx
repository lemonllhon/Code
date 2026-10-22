import { useRef, useState } from "react";
import {
  Boxes,
  ChevronRight,
  FolderOpen,
  LoaderCircle,
  Pencil,
  Plus,
  Server,
  Terminal,
} from "lucide-react";
import type { RemoteDevice } from "@/lib/remoteDevices.js";
import type { RemoteDeviceManagement } from "@/hooks/useRemoteDeviceManagement.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import {
  buildWorkspaceSessionKey,
  formatRemoteWorkspaceHeaderHostLabel,
  formatRemoteWorkspaceTargetSubtitle,
} from "@/lib/remoteWorkspaceHistory.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";

export function RemoteDevicesSection({ management }: { management?: RemoteDeviceManagement }) {
  const { intl } = useLCodeIntl();
  const confirm = useConfirmDialog();
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState<string[]>([]);
  const [error, setError] = useState("");
  const pending = useRef(new Set<string>());
  const text = (key: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id: `settings.remoteDevices.${key}` }, values);
  const run = async (
    device: RemoteDevice,
    action: "configure" | "reconnect" | "disconnect" | "remove",
  ) => {
    if (!management || pending.current.has(device.key)) return;
    pending.current.add(device.key);
    setBusy([...pending.current]);
    setError("");
    try {
      if (
        (action === "remove" || action === "disconnect") &&
        !(await confirm({
          title: text(`${action}Title`),
          description: text(`${action}Description`, { count: device.projects.length }),
          confirmLabel: text(action),
          cancelLabel: intl.formatMessage({ id: "common.cancel" }),
        }))
      )
        return;
      if (action === "configure") await management.onConfigure(device);
      else if (action === "reconnect") await management.onReconnect(device);
      else if (action === "disconnect") await management.onDisconnect(device);
      else await management.onRemove(device);
    } catch (cause) {
      setError(getErrorMessage(cause));
    } finally {
      pending.current.delete(device.key);
      setBusy([...pending.current]);
    }
  };
  const devices = (management?.devices ?? []).filter((device) =>
    `${formatRemoteWorkspaceTargetSubtitle(device.target)} ${device.projects.map((project) => project.workspacePath).join(" ")}`
      .toLowerCase()
      .includes(search.trim().toLowerCase()),
  );
  return (
    <div data-testid="remote-devices-settings" className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-prose text-ui-base text-foreground-subtle">{text("description")}</p>
        <Button onClick={() => management?.onNew()} disabled={!management} className="shrink-0">
          <Plus className="size-4" />
          {text("new")}
        </Button>
      </div>
      <Input
        aria-label={text("search")}
        placeholder={text("search")}
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        className="max-w-md"
      />
      {error ? (
        <p role="alert" className="break-words text-ui-base text-destructive">
          {error}
        </p>
      ) : null}
      <p className="text-ui-sm text-foreground-subtle">
        {text("count", { count: devices.length })}
      </p>
      {devices.length ? (
        <div className="space-y-3">
          {devices.map((device) => {
            const keys = device.projects.map(buildWorkspaceSessionKey);
            const connecting = keys.some((key) => management!.connectingKeys.includes(key));
            const failed =
              !device.connected &&
              !connecting &&
              device.projects.some((project) => project.lastConnectionError);
            const state = device.connected
              ? "connected"
              : connecting
                ? "connecting"
                : failed
                  ? "failed"
                  : "offline";
            const Icon =
              device.target.kind === "ssh"
                ? Server
                : device.target.kind === "wsl"
                  ? Terminal
                  : Boxes;
            const name =
              device.profile?.name ??
              (device.target.kind === "wsl"
                ? [device.target.distro || "WSL", device.target.user].filter(Boolean).join(" · ")
                : device.target.kind === "docker"
                  ? device.target.container
                  : formatRemoteWorkspaceHeaderHostLabel(device.target));
            const disabled = busy.includes(device.key);
            const logs = keys.flatMap((key) => management!.logs[key] ?? []);
            return (
              <article
                key={device.key}
                data-testid="remote-device-card"
                className="overflow-hidden rounded-xl border border-border bg-surface"
              >
                <div className="space-y-4 p-4 sm:p-5">
                  <div className="flex flex-wrap items-start gap-3">
                    <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-background-alt text-foreground-subtle">
                      <Icon className="size-5" />
                    </div>
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="break-all text-ui-base font-medium">{name}</h3>
                        <span
                          data-device-state={state}
                          className={`inline-flex items-center gap-1 rounded-md border border-current px-2 py-0.5 text-ui-xs ${device.connected ? "text-success" : failed ? "text-destructive" : "text-foreground-subtle"}`}
                        >
                          {connecting ? (
                            <LoaderCircle className="size-3 animate-spin motion-reduce:animate-none" />
                          ) : (
                            <span className="size-1.5 rounded-full bg-current" />
                          )}
                          {text(state)}
                        </span>
                      </div>
                      <p className="break-all text-ui-sm text-foreground-subtle">
                        {formatRemoteWorkspaceTargetSubtitle(device.target)}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      variant={device.connected ? "secondary" : "default"}
                      disabled={disabled || connecting}
                      onClick={() =>
                        void run(device, device.connected ? "disconnect" : "reconnect")
                      }
                    >
                      {disabled ? (
                        <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" />
                      ) : null}
                      {text(device.connected ? "disconnect" : "reconnect")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={disabled || connecting}
                      onClick={() => void run(device, "configure")}
                    >
                      <Pencil className="size-3.5" />
                      {text("configure")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={disabled}
                      onClick={() => void run(device, "remove")}
                      className="text-foreground-subtle hover:text-destructive"
                    >
                      {text("remove")}
                    </Button>
                  </div>
                  <details className="group text-ui-sm">
                    <summary className="flex cursor-pointer list-none items-center gap-1 text-foreground-subtle">
                      <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />
                      {text("projects", { count: device.projects.length })}
                    </summary>
                    <div className="mt-2 space-y-1">
                      {device.projects.map((project) => (
                        <Button
                          key={buildWorkspaceSessionKey(project)}
                          size="sm"
                          variant="ghost"
                          disabled={disabled || connecting}
                          className="h-auto w-full justify-start whitespace-normal break-all text-left"
                          onClick={() => {
                            setError("");
                            void management!
                              .onOpenProject(buildWorkspaceSessionKey(project))
                              .catch((cause) => setError(getErrorMessage(cause)));
                          }}
                        >
                          <FolderOpen className="size-3.5 shrink-0" />
                          {project.workspacePath}
                        </Button>
                      ))}
                    </div>
                  </details>
                  {failed ? (
                    <p className="break-words text-ui-sm text-destructive">
                      {
                        device.projects.find((project) => project.lastConnectionError)
                          ?.lastConnectionError
                      }
                    </p>
                  ) : null}
                </div>
                <details className="group border-t border-border px-4 py-3 text-ui-sm sm:px-5">
                  <summary className="flex cursor-pointer list-none items-center gap-1 text-foreground-subtle">
                    <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />
                    {text("logs", { count: logs.length })}
                  </summary>
                  <div className="mt-3 max-h-52 space-y-1 overflow-auto font-mono text-ui-sm text-foreground-subtle">
                    {logs.length ? (
                      logs.map((log, index) => (
                        <p key={`${log.id}:${index}`} className="break-words">
                          {log.timestamp} {log.message}
                        </p>
                      ))
                    ) : (
                      <p>{text("noLogs")}</p>
                    )}
                  </div>
                </details>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-border px-6 py-12 text-center text-ui-base text-foreground-subtle">
          <Server className="mx-auto mb-3 size-7" />
          <p>{text(search ? "noMatches" : "empty")}</p>
        </div>
      )}
      <p className="text-ui-sm text-foreground-subtlest">{text("manualReconnect")}</p>
    </div>
  );
}
