import { buildRemoteWorkspaceIdentity, createUuid, findProjectDefinition } from "@lcode/shared";
import type { ISettingService } from "@lcode/services";
import type { WorkspaceProjectMenuTab } from "../workspaceProjectMenu.js";

/** 设置命令是导航事实唯一写入口；再次添加只恢复原记录，不新建或覆盖会话。 */
export async function submitProjectNavigation(
  owner: Pick<ISettingService, "get" | "mutateProject">,
  target: WorkspaceProjectMenuTab,
  action: "archive" | "restore" | "hide" | "show",
) {
  const workspaceIdentity =
    target.workspaceIdentity?.trim() ||
    (target.remoteTarget
      ? buildRemoteWorkspaceIdentity(target.workspacePath, target.remoteTarget)
      : undefined);
  const settings = await owner.get();
  const previous = findProjectDefinition(
    settings.projectDefinitions?.projects ?? settings.localProjects,
    target.workspacePath,
    workspaceIdentity,
    target.localProjectId,
  );
  if (action === "show" && !previous?.sidebarHiddenAt) return;
  if (action === "restore" && !previous) throw new Error("Project no longer exists");
  const project = previous ?? {
    id: createUuid(),
    name: target.label,
    primaryFolderPath: target.workspacePath,
    sourceFolderPaths: [target.workspacePath],
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
  };
  const result = await owner.mutateProject({
    operationId: createUuid(),
    projectId: project.id,
    expectedRevision: previous?.revision ?? (previous ? 0 : null),
    ...(action === "archive" || action === "hide" ? { type: action, project } : { type: action }),
  });
  if (result.status !== "applied") throw new Error(result.reason ?? "Project could not be updated");
}
