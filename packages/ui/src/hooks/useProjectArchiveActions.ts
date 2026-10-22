import { useCallback } from "react";
import { buildRemoteWorkspaceIdentity, createUuid, findProjectDefinition } from "@lcode/shared";
import { useBaseWorkspaceServices } from "./useWorkspaceServices.js";
import { useSettings } from "./useSettingService.js";
import type { WorkspaceProjectMenuTab } from "@/workspaceProjectMenu.js";

/** 设置 owner 提交成功后由各视图派生位置；归档不关闭连接或改变会话运行状态。 */
export function useProjectArchiveActions() {
  const services = useBaseWorkspaceServices();
  const { mutateProject } = useSettings(services);
  return useCallback(
    async (target: WorkspaceProjectMenuTab, archived: boolean) => {
      const workspaceIdentity =
        target.workspaceIdentity?.trim() ||
        (target.remoteTarget
          ? buildRemoteWorkspaceIdentity(target.workspacePath, target.remoteTarget)
          : undefined);
      const settings = await services.settingService.get();
      const previous = findProjectDefinition(
        settings.projectDefinitions?.projects ?? settings.localProjects,
        target.workspacePath,
        workspaceIdentity,
        target.localProjectId,
      );
      if (!archived && !previous) throw new Error("Project no longer exists");
      const project = previous ?? {
        id: createUuid(),
        name: target.label,
        primaryFolderPath: target.workspacePath,
        sourceFolderPaths: [target.workspacePath],
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
      };
      const result = await mutateProject({
        operationId: createUuid(),
        projectId: project.id,
        expectedRevision: previous?.revision ?? (previous ? 0 : null),
        ...(archived ? { type: "archive", project } : { type: "restore" }),
      });
      if (result.status !== "applied")
        throw new Error(result.reason ?? "Project could not be updated");
    },
    [services.settingService, mutateProject],
  );
}
