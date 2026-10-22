import { randomUUID } from "node:crypto";
import {
  remoteDeviceAuthorityKey,
  remoteDeviceMutationRequestSchema,
  type AppSettings,
  type RemoteDeviceMutationRequest,
  type RemoteDeviceMutationResult,
  type RemoteTarget,
} from "@lcode/shared";

/** 历史只导入一次；独立注册表存在后，移除的设备不能从旧目录记录复活。 */
export function migrateRemoteDeviceSettings(settings: AppSettings): AppSettings {
  if (settings.remoteDevices) return settings;
  const history = (settings.lastWorkspaceSession ?? [])
    .filter((entry) => entry.kind === "remote")
    .toSorted((left, right) => right.lastOpenedAt - left.lastOpenedAt);
  if (!history.length) return settings;
  const seen = new Set<string>();
  const devices = history.flatMap((entry) => {
    const key = remoteDeviceAuthorityKey(entry.target as RemoteTarget);
    if (seen.has(key)) return [];
    seen.add(key);
    const target = entry.target;
    const name =
      target.kind === "ssh"
        ? `${target.username}@${target.host}`
        : target.kind === "wsl"
          ? target.distro || "WSL"
          : target.container;
    return [{ id: randomUUID(), name: name.slice(0, 200), revision: 1, target }];
  });
  return { ...settings, remoteDevices: { version: 1, devices } };
}

export function applyRemoteDeviceMutation(
  settings: AppSettings,
  input: RemoteDeviceMutationRequest,
): { next?: AppSettings; result: RemoteDeviceMutationResult } {
  const request = remoteDeviceMutationRequestSchema.parse(input),
    signature = JSON.stringify(request);
  const receipt = settings.remoteDeviceMutationReceipts?.find(
    (item) => item.operationId === request.operationId,
  );
  if (receipt) {
    if (receipt.request !== signature)
      throw new Error("Remote device operationId reused with different content");
    return { result: receipt.result };
  }
  const current = migrateRemoteDeviceSettings(settings),
    devices = current.remoteDevices?.devices ?? [];
  const previous = devices.find((device) => device.id === request.deviceId);
  if (
    request.expectedRevision === null
      ? Boolean(previous)
      : !previous || previous.revision !== request.expectedRevision
  )
    return {
      result: {
        status: "conflict",
        device: previous ?? null,
        reason: previous
          ? "Remote device changed in another window"
          : "Remote device no longer exists",
      },
    };
  const saved =
    request.type === "save"
      ? {
          id: request.deviceId,
          name: request.name,
          target: request.target,
          revision: (previous?.revision ?? 0) + 1,
        }
      : null;
  if (
    previous &&
    saved &&
    remoteDeviceAuthorityKey(previous.target as RemoteTarget) !==
      remoteDeviceAuthorityKey(saved.target as RemoteTarget)
  )
    return {
      result: {
        status: "conflict",
        device: previous,
        reason: "Create a new device to change its address or user",
      },
    };
  const duplicate =
    saved &&
    devices.find(
      (device) =>
        device.id !== saved.id &&
        remoteDeviceAuthorityKey(device.target as RemoteTarget) ===
          remoteDeviceAuthorityKey(saved.target as RemoteTarget),
    );
  if (duplicate)
    return {
      result: {
        status: "conflict",
        device: duplicate,
        reason: "A remote device already exists for this address and user",
      },
    };
  const nextDevices = devices.filter((device) => device.id !== request.deviceId);
  if (saved) nextDevices.push(saved);
  const result: RemoteDeviceMutationResult = { status: "applied", device: saved };
  return {
    next: {
      ...current,
      remoteDevices: { version: 1, devices: nextDevices },
      remoteDeviceMutationReceipts: [
        ...(current.remoteDeviceMutationReceipts ?? []),
        { operationId: request.operationId, request: signature, result },
      ].slice(-256),
    },
    result,
  };
}
