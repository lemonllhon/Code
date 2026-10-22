import {
  projectMemberWorkspaceIdentity,
  type ProjectDefinition,
  type RemoteTarget,
  type WorkspacePurpose,
} from "@lcode/shared";
import { isWorkspaceReferenceForLocalProject } from "./localProjectLifecycle.js";

export interface WorkspaceProjectMenuTab {
  workspacePath: string;
  label: string;
  remoteSessionId?: string;
  remoteTarget?: RemoteTarget;
  workspaceIdentity?: string;
  workspacePurpose?: WorkspacePurpose;
  localProjectId?: string;
  projectSourceKind?: "local" | "remote" | "mixed";
  archivedAt?: number;
}

export function buildWorkspaceProjectMenuTabs({
  localProjects,
  workspaceTabs,
  includeArchived = false,
}: {
  localProjects: readonly ProjectDefinition[];
  workspaceTabs: readonly WorkspaceProjectMenuTab[];
  includeArchived?: boolean;
}): WorkspaceProjectMenuTab[] {
  const explicitProjectTabs = localProjects
    .filter((project) => includeArchived || !project.archivedAt)
    .map((project) => {
      const openedTab = workspaceTabs.find((tab) => {
        if (tab.workspacePurpose === "conversation") {
          return false;
        }
        return isWorkspaceReferenceForLocalProject(project, tab);
      });
      const environments = new Set(
        project.members?.map((member) =>
          projectMemberWorkspaceIdentity(member, project.workspaceIdentity) ? "remote" : "local",
        ) ?? [project.workspaceIdentity ? "remote" : "local"],
      );
      // 启动门禁、延迟恢复或关闭 tab 不代表项目已删除；菜单始终从注册表投影。
      return {
        ...(openedTab ?? {
          workspacePath: project.primaryFolderPath,
          label: project.name,
          workspacePurpose: "project" as const,
        }),
        workspacePath: project.primaryFolderPath,
        label: project.name,
        localProjectId: project.id,
        ...(project.archivedAt ? { archivedAt: project.archivedAt } : {}),
        ...(project.workspaceIdentity ? { workspaceIdentity: project.workspaceIdentity } : {}),
        projectSourceKind: (environments.size > 1
          ? "mixed"
          : environments.has("remote")
            ? "remote"
            : "local") as "local" | "remote" | "mixed",
      };
    });
  const remainingTabs = workspaceTabs.filter((tab) => {
    if (tab.workspacePurpose === "conversation") {
      return false;
    }
    return !localProjects.some((project) => isWorkspaceReferenceForLocalProject(project, tab));
  });
  return [...explicitProjectTabs, ...remainingTabs];
}
