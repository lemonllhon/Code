import { useRef } from "react";
import {
  remoteDeviceAuthorityKey,
  remoteDeviceTargetSchema,
  stripRemoteTargetSecrets,
  type RemoteDeviceDefinition,
  type RemoteDeviceMutationRequest,
  type RemoteTarget,
} from "@lcode/shared";
import { useBaseWorkspaceServices } from "./useWorkspaceServices.js";
import { useSettings } from "./useSettingService.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";

export interface RemoteDeviceConnectionIntent {
  deviceId: string;
  profile?: RemoteDeviceDefinition;
  reconnectOnly?: boolean;
}

/** 凭据由原 CredentialService 持有；连接配置仅提交引用，原样重试复用 operationId。 */
export function useRemoteDeviceProfiles() {
  const { intl } = useLCodeIntl();
  const services = useBaseWorkspaceServices();
  const settings = useSettings(services);
  const pending = useRef(new Map<string, RemoteDeviceMutationRequest>());
  const attempts = useRef(new Map<string, { credentialId: string; replacementId: string }>());
  const saveConnected = async (target: RemoteTarget, intent: RemoteDeviceConnectionIntent) => {
    const profile = intent.profile;
    if (intent.reconnectOnly && profile) {
      const current = (await services.settingService.get()).remoteDevices?.devices.find(
        (device) => device.id === profile.id,
      );
      if (current?.revision !== profile.revision)
        throw new Error("Remote device changed while connecting; reopen its configuration");
      return current;
    }
    // 修改地址相当于另一台设备，不能让既有成员随配置修改被重新指向别的主机。
    const sameAuthority =
      !profile ||
      remoteDeviceAuthorityKey(profile.target as RemoteTarget) === remoteDeviceAuthorityKey(target);
    // 尝试索引只保留摘要，成功后回收；不能让临时密码作为 Root 长生命周期 Map 的 key。
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify({ intent, target })),
    );
    const attemptKey = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    let attempt = attempts.current.get(attemptKey);
    if (!attempt) {
      attempt = { credentialId: crypto.randomUUID(), replacementId: crypto.randomUUID() };
      attempts.current.set(attemptKey, attempt);
    }
    const deviceId = sameAuthority ? intent.deviceId : attempt.replacementId;
    const credentialKeys: {
      passwordCredentialKey?: string;
      privateKeyPassphraseCredentialKey?: string;
    } = {};
    if (target.kind === "ssh") {
      for (const [field, value] of [
        ["passwordCredentialKey", target.password],
        ["privateKeyPassphraseCredentialKey", target.privateKeyPassphrase],
      ] as const) {
        if (value) {
          const key = `remote-device:${deviceId}:${field}:${attempt.credentialId}`;
          await services.credentialService.save(key, value);
          credentialKeys[field] = key;
        }
      }
    }
    const snapshot = remoteDeviceTargetSchema.parse({
      ...stripRemoteTargetSecrets(target),
      ...credentialKeys,
    });
    const name =
      profile?.name ??
      (target.kind === "ssh"
        ? `${target.username}@${target.host}`
        : target.kind === "wsl"
          ? target.distro || "WSL"
          : target.container);
    const command = {
      type: "save" as const,
      deviceId,
      expectedRevision: sameAuthority ? (profile?.revision ?? null) : null,
      name: name.slice(0, 200),
      target: snapshot,
    };
    const signature = JSON.stringify(command);
    let request = pending.current.get(signature);
    if (!request) {
      request = { ...command, operationId: crypto.randomUUID() };
      pending.current.set(signature, request);
    }
    const result = await settings.mutateRemoteDevice(request);
    if (result.status === "conflict" && result.device && result.device.id !== request.deviceId)
      throw new Error(intl.formatMessage({ id: "settings.remoteDevices.duplicate" }));
    if (result.status !== "applied" || !result.device)
      throw new Error(result.reason || "Remote device could not be saved");
    attempts.current.delete(attemptKey);
    pending.current.delete(signature);
    return result.device;
  };
  return { ...settings, saveConnected };
}
