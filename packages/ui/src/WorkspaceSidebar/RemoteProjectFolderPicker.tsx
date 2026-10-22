import { remoteAgentServiceGeneration } from "@/lib/remoteAgentServiceGeneration.js";
import { useEffect, useRef, useState } from "react";
import {
  buildRemoteWorkspaceIdentity,
  remoteDeviceAuthorityKey,
  type ProjectMember,
} from "@lcode/shared";
import { useRemoteProjectDevices } from "@/hooks/useRemoteProjectDevices.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
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
    <ProjectDialogContent data-testid="remote-project-folder-picker">
      <DialogHeader>
        <DialogTitle>{t("选择远程目录", "Choose remote folder")}</DialogTitle>
      </DialogHeader>
      <DialogBody className="space-y-3">
        <label className="block space-y-2 text-ui-sm">
          <span>{t("远程设备", "Remote device")}</span>
          <select
            className="h-10 w-full rounded-lg border border-border bg-surface px-3 text-ui-sm"
            value={deviceId}
            disabled={busy}
            onChange={(event) => setDeviceId(event.target.value)}
          >
            <option value="">{t("选择设备", "Select a device")}</option>
            {context?.model.devices
              .filter((item) => item.profile)
              .map((item) => (
                <option key={item.key} value={item.key}>
                  {item.profile!.name}
                </option>
              ))}
          </select>
        </label>
        {device && !session ? (
          <Button
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void context?.model
                .onReconnect(device)
                .catch((failure: unknown) => setError(String(failure)))
                .finally(() => setBusy(false));
            }}
          >
            {t("连接设备", "Connect device")}
          </Button>
        ) : null}
        {session ? (
          <div
            key={`${deviceId}:${session.sessionId}:${remoteAgentServiceGeneration(session.services)}`}
            className="max-h-80 overflow-y-auto rounded-xl border border-border p-3"
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
          <p className="text-ui-sm text-foreground-subtle">
            {t("连接设备后选择目录", "Connect a device to browse its folders")}
          </p>
        )}
        <Button variant="ghost" disabled={!context || busy} onClick={() => context?.manage()}>
          {t("没有所需设备？管理远程设备", "Missing a device? Manage remote devices")}
        </Button>
        {error ? (
          <p role="alert" className="text-ui-sm text-destructive">
            {error}
          </p>
        ) : null}
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" disabled={busy} onClick={onCancel}>
          {t("返回", "Back")}
        </Button>
        <Button disabled={!session || !path || !ready || busy} onClick={() => void add()}>
          {t("添加目录", "Add folder")}
        </Button>
      </DialogFooter>
    </ProjectDialogContent>
  );
}
