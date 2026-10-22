import { createContext, useContext, useMemo, type ReactNode } from "react";
import { findLocalProjectForWorkspace, type LocalProject } from "@lcode/shared";

const LocalProjectsContext = createContext<readonly LocalProject[]>([]);

export function LocalProjectsProvider({
  projects,
  children,
}: {
  projects: readonly LocalProject[];
  children: ReactNode;
}) {
  // 菜单改读完整项目注册表后，本机文件提及搜索仍只能消费本机 origin 的兼容投影，不能按同路径误选远端项目。
  const localProjects = useMemo(
    () =>
      projects.filter((project) => !("workspaceIdentity" in project && project.workspaceIdentity)),
    [projects],
  );
  return (
    <LocalProjectsContext.Provider value={localProjects}>{children}</LocalProjectsContext.Provider>
  );
}

export function useLocalProjectForWorkspace(
  workspacePath: string,
  workspaceIdentity?: string,
): LocalProject | undefined {
  const projects = useContext(LocalProjectsContext);
  return useMemo(
    () => (workspaceIdentity ? undefined : findLocalProjectForWorkspace(projects, workspacePath)),
    [projects, workspaceIdentity, workspacePath],
  );
}
