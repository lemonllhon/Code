import { remoteAgentServiceGeneration } from "@/lib/remoteAgentServiceGeneration.js";
import { useEffect, useRef, useState } from "react";
import { Check, LoaderCircle, Monitor, Plug, Settings2 } from "lucide-react";
import {
  buildRemoteWorkspaceIdentity,
  remoteDeviceAuthorityKey,
  type ProjectMember,
} from "@lcode/shared";
import { useRemoteProjectDevices } from "@/hooks/useRemoteProjectDevices.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { DirectoryBrowser } from "@/DirectoryBrowser.js";
import { ProjectDialogContent } from "./ProjectDialogContent.js";
import { DialogHeader, DialogTitle, DialogBody, DialogFooter } from "@/components/ui/dialog.js";

export function RemoteProjectFolderPicker({
  onAdd,
  onCancel,
}: {
  onAdd(member: ProjectMember): void;
  onCancel(): void;
}) {
  const context = useRemoteProjectDevices();
  const { locale } = useLCodeIntl();
  const t = (zh: string, en: string) => (locale.startsWith("zh") ? zh : en);
  const [deviceId, setDeviceId] = useState("");
  const [path, setPath] = useState("");
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const sessions = useRemoteWorkspaceSessionStore((state) => state.sessionsById);
  const device = context?.model.devices.find((candidate) => candidate.key === deviceId);
  const session = device?.sessionIds
    .map((id) => sessions[id])
    .find(
      (item) =>
        item?.target &&
        remoteDeviceAuthorityKey(item.target) === remoteDeviceAuthorityKey(device.target),
    );
  useEffect(() => {
    generation.current++;
    setPath("");
    setError("");
    setReady(false);
    setBusy(false);
  }, [deviceId, session?.services]);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  const add = async () => {
    if (!session?.target || !device?.profile || !path || !ready || busy) return;
    const token = generation.current;
    setBusy(true);
    setError("");
    try {
      const canonical = await session.services.fileService.resolvePath({ path });
      const canonicalPath = canonical;
      if ((await session.services.fileService.stat({ path: canonicalPath })).type !== "directory")
        throw new Error(t("目标不是目录", "Target is not a directory"));
      if (
        token !== generation.current ||
        useRemoteWorkspaceSessionStore.getState().sessionsById[session.sessionId]?.services !==
          session.services
      )
        throw new Error(
          t(
            "设备连接已变化，请重新选择目录",
            "Device connection changed. Select the folder again.",
          ),
        );
      onAdd({
        id: crypto.randomUUID(),
        path: canonicalPath,
        role: "",
        label: "",
        description: "",
        enabled: true,
        source: {
          kind: "remote",
          deviceId: device.profile.id,
          workspaceIdentity: buildRemoteWorkspaceIdentity(canonicalPath, session.target),
        },
      });
    } catch (failure) {
      if (token === generation.current)
        setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (token === generation.current) setBusy(false);
    }
  };
  return (
    <ProjectDialogContent
      data-testid="remote-project-folder-picker"
      className="h-[min(38rem,calc(100dvh-2rem))] max-w-3xl"
    >
      <DialogHeader>
        <DialogTitle>{t("选择远程目录", "Choose remote folder")}</DialogTitle>
      </DialogHeader>
      <DialogBody className="flex flex-col gap-3 sm:overflow-hidden [@media(max-height:480px)]:block [@media(max-height:480px)]:space-y-3 [@media(max-height:480px)]:overflow-y-auto">
        <div className="shrink-0 space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <label htmlFor="remote-project-device" className="text-ui-sm text-foreground-subtle">
              {t("远程设备", "Remote device")}
            </label>
            <Button
              variant="ghost"
              size="sm"
              disabled={!context || busy}
              onClick={() => context?.manage()}
            >
              <Settings2 className="size-3.5" />
              {t("管理远程设备", "Manage remote devices")}
            </Button>
          </div>
          {/* 原生 select 与独立连接行导致主题不一致和错位；共享控件在同一 flex 行等高对齐。 */}
          <div className="flex items-stretch gap-2">
            <Select value={deviceId} disabled={busy} onValueChange={setDeviceId}>
              <SelectTrigger id="remote-project-device" size="lg" className="min-h-9 w-full flex-1">
                <SelectValue placeholder={t("选择设备", "Select a device")} />
              </SelectTrigger>
              <SelectContent position="popper" align="start">
                {context?.model.devices
                  .filter((item) => item.profile)
                  .map((item) => (
                    <SelectItem key={item.key} value={item.key}>
                      <Monitor className="size-4 text-foreground-subtle" />
                      <span className="min-w-0 flex-1 truncate">{item.profile!.name}</span>
                      <span className="text-ui-xs uppercase text-foreground-subtlest">
                        {item.target.kind}
                      </span>
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            <Button
              size="lg"
              className="min-h-9"
              variant={session ? "outline" : "default"}
              disabled={!device || Boolean(session) || busy}
              onClick={() => {
                if (!device || !context) return;
                const token = generation.current;
                setBusy(true);
                setError("");
                void context.model
                  .onReconnect(device)
                  .catch((failure: unknown) => {
                    if (token === generation.current) setError(String(failure));
                  })
                  .finally(() => {
                    if (token === generation.current) setBusy(false);
                  });
              }}
            >
              {session ? (
                <Check className="size-4" />
              ) : busy ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : (
                <Plug className="size-4" />
              )}
              {session
                ? t("已连接", "Connected")
                : busy
                  ? t("连接中", "Connecting")
                  : t("连接设备", "Connect device")}
            </Button>
          </div>
        </div>
        {session ? (
          <div
            key={`${deviceId}:${session.sessionId}:${remoteAgentServiceGeneration(session.services)}`}
            // 目录浏览器拥有唯一列表滚动区，外层限高再滚动会把后续目录挤到不可见区域。
            className="flex min-h-0 flex-1 flex-col [@media(max-height:480px)]:h-80 [@media(max-height:480px)]:flex-none"
          >
            <DirectoryBrowser
              services={session.services}
              embedded
              onReadyChange={setReady}
              onPathChange={setPath}
              onSelect={() => {}}
              onCancel={onCancel}
            />
          </div>
        ) : (
          <div className="flex min-h-24 flex-1 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border bg-surface px-4 py-6 text-center">
            <Monitor className="size-7 text-foreground-subtlest" />
            <p className="text-ui-base">
              {t("连接设备后选择目录", "Connect a device to browse its folders")}
            </p>
            <p className="text-ui-sm text-foreground-subtle">
              {t(
                "浏览设备上的文件夹，或粘贴目录路径",
                "Browse folders on the device, or paste a folder path",
              )}
            </p>
          </div>
        )}
        {error ? (
          <p role="alert" className="text-ui-sm text-destructive">
            {error}
          </p>
        ) : null}
      </DialogBody>
      <DialogFooter className="flex-col items-stretch sm:items-center sm:justify-between">
        <div className="min-w-0 flex-1 text-ui-sm text-foreground-subtle">
          <span>{t("当前目录", "Current folder")}</span>
          <p className="truncate font-mono text-foreground" title={path}>
            {path || "—"}
          </p>
        </div>
        <div className="flex shrink-0 justify-end gap-2">
          <Button variant="ghost" disabled={busy} onClick={onCancel}>
            {t("返回", "Back")}
          </Button>
          <Button
            data-testid="remote-folder-confirm"
            disabled={!session || !path || !ready || busy}
            onClick={() => void add()}
          >
            {t("添加目录", "Add folder")}
          </Button>
        </div>
      </DialogFooter>
    </ProjectDialogContent>
  );
}
