import type { AppSettings } from "@lcode/shared";

/** 注册表只通过原 CAS 命令写入，旧窗口整数组补丁不得覆盖新成员或设备。 */
export function assertRegistryPatch(current: AppSettings, patch: Partial<AppSettings>): void {
  if (Object.hasOwn(patch, "remoteDevices") || Object.hasOwn(patch, "remoteDeviceMutationReceipts"))
    throw new Error("Use the remote device command to update device profiles");
  if (
    Object.hasOwn(patch, "projectDefinitions") ||
    Object.hasOwn(patch, "projectMutationReceipts") ||
    (current.projectDefinitions && Object.hasOwn(patch, "localProjects"))
  )
    throw new Error("Use the project command to update project definitions");
}
