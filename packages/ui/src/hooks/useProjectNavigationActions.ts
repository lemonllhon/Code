import { useCallback } from "react";
import { submitProjectNavigation } from "./projectNavigationCommands.js";
import { useBaseWorkspaceServices } from "./useWorkspaceServices.js";
import { useSettings } from "./useSettingService.js";
import type { WorkspaceProjectMenuTab } from "@/workspaceProjectMenu.js";

/** 所有导航动作共用设置 owner，移除不关闭连接或改变会话运行状态。 */
export function useProjectNavigationActions() {
  const services = useBaseWorkspaceServices();
  const { mutateProject } = useSettings(services);
  return useCallback(
    (target: WorkspaceProjectMenuTab, action: "archive" | "restore" | "hide" | "show") =>
      submitProjectNavigation({ get: services.settingService.get, mutateProject }, target, action),
    [services.settingService, mutateProject],
  );
}
