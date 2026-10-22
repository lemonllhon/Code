import {
  buildRemoteEnvironmentKey,
  remoteDeviceAuthorityKey,
  stripRemoteTargetSecrets,
  type RemoteTarget,
  type RemoteWorkspaceSessionEntry,
  type RemoteDeviceDefinition,
} from "@lcode/shared";
import { createRemoteTargetFromSnapshot } from "./remoteWorkspaceHistory.js";

export interface RemoteDevice {
  key: string;
  profile?: RemoteDeviceDefinition;
  target: RemoteTarget;
  projects: RemoteWorkspaceSessionEntry[];
  sessionIds: string[];
  connected: boolean;
}

/** 配置来自设置 owner，在册 attachment 才能证明在线；旧 Host 暂保留历史投影兼容。 */
export function buildRemoteDevices(
  history: readonly RemoteWorkspaceSessionEntry[],
  sessions: readonly { sessionId: string; target?: RemoteTarget; deviceId?: string }[],
  profiles?: readonly RemoteDeviceDefinition[],
): RemoteDevice[] {
  if (profiles) {
    return profiles.map((profile) => {
      const target = createRemoteTargetFromSnapshot(profile.target, {
        password: null,
        privateKeyPassphrase: null,
      });
      const authority = remoteDeviceAuthorityKey(target);
      const matching = sessions.filter((session) =>
        session.deviceId
          ? session.deviceId === profile.id
          : session.target &&
            remoteDeviceAuthorityKey(session.target) === authority &&
            profiles.filter(
              (candidate) =>
                remoteDeviceAuthorityKey(candidate.target as RemoteTarget) === authority,
            ).length === 1,
      );
      return {
        key: profile.id,
        profile,
        target,
        projects: history.filter(
          (entry) => remoteDeviceAuthorityKey(entry.target as RemoteTarget) === authority,
        ),
        sessionIds: matching.map((session) => session.sessionId),
        connected: matching.length > 0,
      };
    });
  }
  const devices = new Map<string, RemoteDevice>();
  const get = (target: RemoteTarget) => {
    // 密码只在建连参数中短暂存在；先脱敏再求投影身份，避免保存前后被拆成两张设备卡。
    const sanitized = stripRemoteTargetSecrets(target);
    const key = buildRemoteEnvironmentKey(sanitized);
    let device = devices.get(key);
    if (!device) {
      device = {
        key,
        target: sanitized,
        projects: [],
        sessionIds: [],
        connected: false,
      };
      devices.set(key, device);
    }
    return device;
  };
  for (const entry of history) {
    get(
      createRemoteTargetFromSnapshot(entry.target, { password: null, privateKeyPassphrase: null }),
    ).projects.push(entry);
  }
  for (const session of sessions) {
    if (!session.target) continue;
    const device = get(session.target);
    device.sessionIds.push(session.sessionId);
    device.connected = true;
  }
  return [...devices.values()];
}
