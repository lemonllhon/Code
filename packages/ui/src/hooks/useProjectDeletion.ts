import { useRef, useState } from "react";
import {
  buildRemoteWorkspaceIdentity,
  createUuid,
  findProjectDefinition,
  sidebarEntryKey,
  type LocalProjectRemoveRequest,
} from "@lcode/shared";
import {
  useBaseWorkspaceServices,
  useWorkspaceServicesResolution,
} from "./useWorkspaceServices.js";
import { useSettings } from "./useSettingService.js";
import { useConfirmDialog } from "./useConfirmDialog.js";
import { useSidebarOrganization } from "./useSidebarOrganization.js";
import { useTabStoreApi } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab } from "@/store/tabStore.js";
import { useSidebarText } from "@/WorkspaceSidebar/sidebarText.js";
import type { WorkspaceProjectMenuTab } from "@/workspaceProjectMenu.js";
import { invalidateTaskQueryCacheByScopes } from "@/store/taskQueryCacheStore.js";
import { releaseWorkspaceRuntimeAfterProjectRemoval } from "@/lib/workspaceRuntimeRelease.js";
import { logger } from "@/logger.js";
import { toast } from "@/components/ui/toast.js";

/** 两个菜单入口共用同一删除顺序：确认→权威来源校验→真实会话清理→定义/索引→派生 tab。 */
export function useProjectDeletion(
  target: WorkspaceProjectMenuTab,
  callbacks: {
    onRemoveLocalProject?: (request: LocalProjectRemoveRequest) => Promise<void>;
    onRemoveRemoteProject?: (key: string) => Promise<void>;
  } = {},
) {
  const base = useBaseWorkspaceServices();
  const workspaceIdentity =
    target.workspaceIdentity?.trim() ||
    (target.remoteTarget
      ? buildRemoteWorkspaceIdentity(target.workspacePath, target.remoteTarget)
      : undefined);
  const resolution = useWorkspaceServicesResolution(
    target.workspacePath,
    target.remoteSessionId,
    workspaceIdentity,
    target.remoteTarget,
  );
  const { mutateProject } = useSettings(base);
  const confirm = useConfirmDialog();
  const text = useSidebarText();
  const tabs = useTabStoreApi();
  const organization = useSidebarOrganization();
  const pending = useRef(false);
  const [deleting, setDeleting] = useState(false);
  const run = async () => {
    if (pending.current) return;
    pending.current = true;
    setDeleting(true);
    try {
      if (!resolution.rpcReady || (resolution.isRemoteTarget && !workspaceIdentity))
        throw new Error(text("deleteProjectOffline"));
      if (
        !(await confirm({
          title: text("deleteProject"),
          description: text("deleteProjectHint"),
          confirmLabel: text("deleteProjectConfirm"),
          cancelLabel: text("cancel"),
          confirmVariant: "destructive",
        }))
      )
        return;
      const scope = {
        workspacePath: target.workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
      };
      const services = resolution.services;
      // 中文依据：确认框打开期间依赖可能改变，不能只信任菜单的旧禁用态；归档项也走同一门禁。
      if (!services.worktreeService) throw new Error(text("deleteProjectUpgrade"));
      const bindings = await services.worktreeService.list(scope);
      if (bindings.some((binding) => binding.status !== "deleted"))
        throw new Error(text("activeBinding"));
      const setService = services.projectExecutionSetService;
      if (setService && (await setService.capabilities()).protocolVersion === 1) {
        const sets = await setService.list(scope);
        if (sets.some((set) => set.status !== "archived"))
          throw new Error(text("activeExecutionSet"));
      }
      const settings = await base.settingService.get();
      const project = findProjectDefinition(
        settings.projectDefinitions?.projects ?? settings.localProjects,
        scope.workspacePath,
        scope.workspaceIdentity,
        target.localProjectId,
      );
      if (typeof services.lcodeTaskService.deleteWorkspaceTasks !== "function")
        throw new Error(text("deleteProjectUpgrade"));
      await services.lcodeTaskService.deleteWorkspaceTasks(scope);
      if (resolution.isRemoteTarget && callbacks.onRemoveRemoteProject) {
        await callbacks.onRemoveRemoteProject(scope.workspaceIdentity || scope.workspacePath);
      } else if (!resolution.isRemoteTarget && callbacks.onRemoveLocalProject) {
        await callbacks.onRemoveLocalProject({
          workspacePath: scope.workspacePath,
          ...(project ? { projectId: project.id } : {}),
        });
      } else {
        const result = await mutateProject({
          type: "remove",
          operationId: createUuid(),
          projectId: project?.id ?? createUuid(),
          expectedRevision: project?.revision ?? (project ? 0 : null),
          workspace: scope,
        });
        if (result.status !== "applied")
          throw new Error(result.reason ?? text("projectActionFailed"));
      }
      const key = scope.workspaceIdentity?.trim() || scope.workspacePath;
      for (const tab of tabs.getState().tabs)
        if (isWorkspaceTab(tab) && (tab.workspaceIdentity?.trim() || tab.workspacePath) === key)
          tabs.getState().closeTab(tab.id);
      const references = [
        ...(organization?.snapshot.sections.flatMap((section) => section.entries) ?? []),
        ...(organization?.snapshot.rootOrders ?? []),
      ].filter((entry) => {
        const origin =
          entry.kind === "project" ? entry : entry.kind === "task" ? entry.workspace : entry.origin;
        return (origin.workspaceIdentity?.trim() || origin.workspacePath) === key;
      });
      if (references.length)
        await organization?.run(
          [
            {
              type: "forget",
              entries: [
                ...new Map(references.map((entry) => [sidebarEntryKey(entry), entry])).values(),
              ],
            },
          ],
          false,
          true,
        );
      invalidateTaskQueryCacheByScopes([scope]);
      releaseWorkspaceRuntimeAfterProjectRemoval({
        tab: scope,
        lcodeTaskService: services.lcodeTaskService,
      });
    } catch (error) {
      logger.error("[useProjectDeletion] 删除项目失败", { error });
      toast(
        `${text("projectActionFailed")} ${error instanceof Error ? error.message : String(error)}`,
        { variant: "warning" },
      );
    } finally {
      pending.current = false;
      setDeleting(false);
    }
  };
  return { deleting, deleteProject: run };
}
