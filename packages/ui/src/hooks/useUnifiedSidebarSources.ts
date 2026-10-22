import { sidebarEntryKey, type ProjectDefinition } from "@lcode/shared";
import { useEffect, useMemo } from "react";
import { useSidebarOrganization } from "./useSidebarOrganization.js";
import { useBaseWorkspaceServices } from "./useWorkspaceServices.js";
import { useSettings } from "./useSettingService.js";
import { useSidebarWorktrees } from "./useSidebarWorktrees.js";
import { useSidebarExecutionSets } from "./useSidebarExecutionSets.js";
import { resolveSessionConfigurationProjects } from "./useSessionConfigurationProjects.js";
import { useSidebarLegacyMigration } from "./useSidebarLegacyMigration.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab, type WorkspaceTabState } from "@/store/tabStore.js";
import { buildWorkspaceProjectMenuTabs } from "@/workspaceProjectMenu.js";
import { isWorktreeSidebarWorkspace } from "@/lib/worktreeSidebar.js";
import { scopeKey } from "@/WorkspaceSidebar/sidebarReferences.js";
export function useUnifiedSidebarSources() {
  const organization = useSidebarOrganization()!;
  const base = useBaseWorkspaceServices();
  const { settings } = useSettings(base);
  const tabs = useTabStore((state) => state.tabs);
  const activateTab = useTabStore((state) => state.activateTab);
  const closeTab = useTabStore((state) => state.closeTab);
  const workspaceTabs = useMemo(() => tabs.filter(isWorkspaceTab), [tabs]);
  const sessionsById = useRemoteWorkspaceSessionStore((state) => state.sessionsById);
  const sessionIdByWorkspaceIdentity = useRemoteWorkspaceSessionStore(
    (state) => state.sessionIdByWorkspaceIdentity,
  );
  const registeredTabs = useMemo(() => {
    const projects = resolveSessionConfigurationProjects({
      settings,
      workspaceTabs,
      worktreeEntries: [],
      sessionsById,
      sessionIdByWorkspaceIdentity,
      includeArchived: true,
    });
    return buildWorkspaceProjectMenuTabs({
      localProjects: settings?.projectDefinitions?.projects ?? settings?.localProjects ?? [],
      workspaceTabs: projects,
      includeArchived: true,
    }).map(
      (project): WorkspaceTabState => ({
        ...workspaceTabs.find((tab) => scopeKey(tab) === scopeKey(project)),
        ...project,
        kind: "workspace",
        id:
          workspaceTabs.find((tab) => scopeKey(tab) === scopeKey(project))?.id ??
          `sidebar:${scopeKey(project)}`,
      }),
    );
  }, [settings, workspaceTabs, sessionsById, sessionIdByWorkspaceIdentity]);
  const queryTabs = useMemo(
    () => [
      ...new Map([...registeredTabs, ...workspaceTabs].map((tab) => [scopeKey(tab), tab])).values(),
    ],
    [registeredTabs, workspaceTabs],
  );
  const allTrees = useSidebarWorktrees(queryTabs);
  const archivedProjects = useMemo<ProjectDefinition[]>(
    () =>
      (settings?.projectDefinitions?.projects ?? settings?.localProjects ?? []).filter(
        (project) => project.archivedAt && !project.sidebarHiddenAt,
      ),
    [settings],
  );
  const inactiveScopes = useMemo(
    () =>
      new Set(
        (settings?.projectDefinitions?.projects ?? settings?.localProjects ?? [])
          .filter((project) => project.archivedAt || project.sidebarHiddenAt)
          .map(
            (project: ProjectDefinition) =>
              project.workspaceIdentity?.trim() || project.primaryFolderPath,
          ),
      ),
    [settings],
  );
  // 中文依据：catalog effect 会发布投影；过滤数组必须随事实变化才换引用，避免发布→重渲染循环。
  const activeTreeEntries = useMemo(
    () => allTrees.entries.filter((entry) => !inactiveScopes.has(scopeKey(entry.origin))),
    [allTrees.entries, inactiveScopes],
  );
  const trees = {
    ...allTrees,
    entries: activeTreeEntries,
  };
  useEffect(() => {
    if (!organization.writable) return;
    const confirmed = trees.deletedReferences.filter(
      (ref) =>
        organization.sectionFor(ref) ||
        organization.snapshot.rootOrders.some(
          (item) => sidebarEntryKey(item) === sidebarEntryKey(ref),
        ),
    );
    if (confirmed.length)
      void organization.run([{ type: "forget", entries: confirmed }], false, true);
  }, [trees.deletedReferences, organization]);
  const bindings = useMemo(
    () => allTrees.entries.map((entry) => entry.binding),
    [allTrees.entries],
  );
  const projects = useMemo(
    () =>
      registeredTabs.filter(
        (tab) =>
          tab.workspacePurpose !== "conversation" && !isWorktreeSidebarWorkspace(tab, bindings),
      ),
    [registeredTabs, bindings],
  );
  useSidebarLegacyMigration(queryTabs, bindings, trees.loading);
  const archiveSets = useSidebarExecutionSets(projects, trees.lookup);
  const activeSetEntries = useMemo(
    () => archiveSets.entries.filter((entry) => !inactiveScopes.has(scopeKey(entry.origin))),
    [archiveSets.entries, inactiveScopes],
  );
  const sets = {
    ...archiveSets,
    entries: activeSetEntries,
  };
  // 中文依据：归档保留来源和完整查询能力，只过滤活动投影；不能关闭 tab 后让 recent/session 再造入口。
  const activeQueryTabs = useMemo(
    () =>
      queryTabs.filter(
        (tab) =>
          !inactiveScopes.has(scopeKey(tab)) &&
          !allTrees.entries.some(
            (entry) =>
              inactiveScopes.has(scopeKey(entry.origin)) &&
              isWorktreeSidebarWorkspace(tab, [entry.binding]),
          ),
      ),
    [queryTabs, allTrees.entries, inactiveScopes],
  );
  const activeProjects = useMemo(
    () => projects.filter((tab) => !inactiveScopes.has(scopeKey(tab))),
    [projects, inactiveScopes],
  );
  return {
    projects: activeProjects,
    archivedProjects,
    inactiveScopes,
    trees,
    sets,
    archiveSets,
    bindings,
    queryTabs: activeQueryTabs,
    archiveQueryTabs: queryTabs,
    activateTab,
    closeTab,
  };
}
