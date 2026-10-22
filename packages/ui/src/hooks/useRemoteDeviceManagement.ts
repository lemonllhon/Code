import { useMemo } from "react";
import type { RemoteTarget, RemoteWorkspaceSessionEntry } from "@lcode/shared";
import { buildRemoteDevices, type RemoteDevice } from "@/lib/remoteDevices.js";
import {
  buildWorkspaceSessionKey,
  createRemoteTargetFromSnapshot,
} from "@/lib/remoteWorkspaceHistory.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { associateRemoteDeviceSession } from "@/store/remoteWorkspaceSessionStore.js";
import {
  useRemoteDeviceProfiles,
  type RemoteDeviceConnectionIntent,
} from "./useRemoteDeviceProfiles.js";
import { useBaseWorkspaceServices } from "./useWorkspaceServices.js";
import type { RemoteConnectionLogEntry } from "./useRemoteConnectionLogs.js";

export interface RemoteDeviceManagement {
  devices: RemoteDevice[];
  connectingKeys: string[];
  logs: Record<string, RemoteConnectionLogEntry[]>;
  onNew(): void;
  onConfigure(device: RemoteDevice): Promise<void>;
  onReconnect(device: RemoteDevice): Promise<void>;
  onDisconnect(device: RemoteDevice): Promise<void>;
  onRemove(device: RemoteDevice): Promise<void>;
  onOpenProject(key: string): Promise<void>;
}

export function useRemoteDeviceManagement(options: {
  history: RemoteWorkspaceSessionEntry[];
  connectingKeys: string[];
  logs: Record<string, RemoteConnectionLogEntry[]>;
  open(preference?: {
    preferredKind?: RemoteTarget["kind"];
    preferredTarget?: RemoteTarget;
    connectOnOpen?: boolean;
    deviceIntent?: RemoteDeviceConnectionIntent;
  }): void;
  reconnect(
    key: string,
    options?: {
      cancelPending?: boolean;
      activateWorkspaceAfterReconnect?: boolean;
      throwOnFailure?: boolean;
    },
  ): Promise<void>;
  disconnect(sessionId: string): Promise<void>;
  openProject(key: string): Promise<void>;
  retain(sessionId: string): void;
}): RemoteDeviceManagement & {
  saveConnected(
    sessionId: string,
    target: RemoteTarget,
    intent: RemoteDeviceConnectionIntent,
  ): Promise<void>;
} {
  const sessions = useRemoteWorkspaceSessionStore((state) => state.sessionsById);
  const services = useBaseWorkspaceServices();
  const profiles = useRemoteDeviceProfiles();
  const devices = useMemo(
    () =>
      buildRemoteDevices(
        options.history,
        Object.values(sessions),
        profiles.settings?.remoteDevices?.devices,
      ),
    [options.history, sessions, profiles.settings?.remoteDevices],
  );
  const cancelReconnects = async (device: RemoteDevice) => {
    for (const entry of device.projects) {
      const key = buildWorkspaceSessionKey(entry);
      if (options.connectingKeys.includes(key))
        await options.reconnect(key, { cancelPending: true });
    }
  };
  const disconnect = async (device: RemoteDevice) => {
    await cancelReconnects(device);
    // 释放仅限本窗口在册的 logical session；其它窗口/设备的 owner 由原 Host 注册表保护。
    for (const id of device.sessionIds) {
      if (useRemoteWorkspaceSessionStore.getState().sessionsById[id]) await options.disconnect(id);
    }
  };
  const configure = async (device: RemoteDevice, connectOnOpen = false) => {
    const snapshot = device.profile?.target ?? device.projects[0]?.target;
    // 密码只在明确打开配置时从原凭据 owner 读取，临时进入表单，不写入设备投影或日志。
    const credentials =
      snapshot?.kind === "ssh"
        ? await Promise.all([
            snapshot.passwordCredentialKey
              ? services.credentialService.load(snapshot.passwordCredentialKey)
              : null,
            snapshot.privateKeyPassphraseCredentialKey
              ? services.credentialService.load(snapshot.privateKeyPassphraseCredentialKey)
              : null,
          ])
        : [null, null];
    const target = snapshot
      ? createRemoteTargetFromSnapshot(snapshot, {
          password: credentials[0] ?? null,
          privateKeyPassphrase: credentials[1] ?? null,
        })
      : device.target;
    options.open({
      preferredKind: target.kind,
      preferredTarget: target,
      connectOnOpen,
      deviceIntent: {
        deviceId: device.profile?.id ?? crypto.randomUUID(),
        profile: device.profile,
        reconnectOnly: connectOnOpen,
      },
    });
  };
  return {
    devices,
    connectingKeys: options.connectingKeys,
    logs: options.logs,
    onNew: () => options.open({ deviceIntent: { deviceId: crypto.randomUUID() } }),
    onConfigure: (device) => configure(device),
    onReconnect: async (device) => {
      await configure(device, true);
    },
    onDisconnect: disconnect,
    onRemove: async (device) => {
      if (!device.profile) throw new Error("Remote device profiles have not finished loading");
      const result = await profiles.mutateRemoteDevice({
        type: "remove",
        operationId: crypto.randomUUID(),
        deviceId: device.profile.id,
        expectedRevision: device.profile.revision,
      });
      if (result.status !== "applied") throw new Error(result.reason || "Remote device changed");
      // 移除配置不释放项目持有的 attachment，也不删除项目或文件；显式断开仍走原注册表。
    },
    onOpenProject: options.openProject,
    saveConnected: async (
      sessionId: string,
      target: RemoteTarget,
      intent: RemoteDeviceConnectionIntent,
    ) => {
      const profile = await profiles.saveConnected(target, intent);
      if (useRemoteWorkspaceSessionStore.getState().sessionsById[sessionId]) {
        associateRemoteDeviceSession(sessionId, profile.id);
        options.retain(sessionId);
      }
    },
  };
}
