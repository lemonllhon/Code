import {
  projectMutationRequestSchema,
  projectDefinitionKey,
  buildRemoteWorkspaceIdentity,
  type AppSettings,
  type ProjectDefinition,
  type ProjectMutationRequest,
  type ProjectMutationResult,
} from "@lcode/shared";

/** 浏览器交互桩；磁盘锁、CAS 和持久化本身由真实 SettingService 集成测试覆盖。 */
export function createSidebarProjectCommands(
  settings: Partial<AppSettings>,
  calls: Array<{ method: string; params: unknown }>,
) {
  return async (input: ProjectMutationRequest): Promise<ProjectMutationResult> => {
    const request = projectMutationRequestSchema.parse(input);
    calls.push({ method: "project", params: request });
    const projects: ProjectDefinition[] =
      settings.projectDefinitions?.projects ?? settings.localProjects ?? [];
    const existing = projects.find((project) => project.id === request.projectId);
    const receipt = settings.projectMutationReceipts?.find(
      (item) => item.operationId === request.operationId,
    );
    if (receipt) return receipt.result;
    if (
      request.expectedRevision === null
        ? existing
        : !existing || (existing.revision ?? 0) !== request.expectedRevision
    )
      return { status: "conflict", project: existing ?? null, reason: "Concurrent project edit" };
    const duplicate =
      request.type === "save" &&
      projects.find(
        (project) =>
          project.id !== request.projectId &&
          projectDefinitionKey(project) === projectDefinitionKey(request.project),
      );
    if (duplicate)
      return { status: "conflict", project: duplicate, reason: "Duplicate project source" };
    let project: ProjectDefinition | null = null;
    if (request.type === "save" || request.type === "archive") {
      const members =
        request.project.members ??
        request.project.sourceFolderPaths.map((path) => ({
          id: crypto.randomUUID(),
          path,
          role: "custom" as const,
          label: "",
          description: "",
          enabled: true,
        }));
      project = {
        ...request.project,
        revision: (existing?.revision ?? 0) + 1,
        ...(request.type === "archive" ? { archivedAt: existing?.archivedAt ?? Date.now() } : {}),
        members,
        memberOrder: request.project.memberOrder ?? members.map((member) => member.id),
      };
    }
    if (request.type === "restore" && existing) {
      const { archivedAt: _archivedAt, ...active } = existing;
      project = { ...active, revision: (existing.revision ?? 0) + 1 };
    }
    const next = [...projects];
    const index = next.findIndex((item) => item.id === request.projectId);
    if (index >= 0) next.splice(index, 1, ...(project ? [project] : []));
    else if (project) next.unshift(project);
    settings.projectDefinitions = { version: 1, projects: next };
    settings.localProjects = next.filter(
      (item) => !("workspaceIdentity" in item && item.workspaceIdentity),
    );
    if (request.type === "remove" && !existing?.workspaceIdentity) {
      const paths =
        existing?.sourceFolderPaths ?? (request.workspace ? [request.workspace.workspacePath] : []);
      settings.recentProjects = settings.recentProjects?.filter((path) => !paths.includes(path));
      settings.lastWorkspaceSession = settings.lastWorkspaceSession?.filter(
        (entry) =>
          entry.kind === "remote" ||
          (!paths.includes(entry.workspacePath) && entry.localProjectId !== existing?.id),
      );
    }
    // 与 SettingService 同一提交边界：远端定义移除同步清理恢复历史，窗口无需再次保存。
    if (request.type === "remove" && existing?.workspaceIdentity?.trim()) {
      settings.lastWorkspaceSession = settings.lastWorkspaceSession?.filter(
        (entry) =>
          entry.kind !== "remote" ||
          (entry.workspaceIdentity?.trim() ||
            buildRemoteWorkspaceIdentity(entry.workspacePath, entry.target)) !==
            existing.workspaceIdentity?.trim(),
      );
    }
    const result = { status: "applied" as const, project };
    settings.projectMutationReceipts = [
      ...(settings.projectMutationReceipts ?? []),
      { operationId: request.operationId, request: JSON.stringify(request), result },
    ];
    localStorage.setItem("sidebar-fixture-projects", JSON.stringify(settings));
    return result;
  };
}

export function createHeldSidebarProjectCommands(
  settings: Partial<AppSettings>,
  calls: Array<{ method: string; params: unknown }>,
) {
  return withHeldProjectAcknowledgement(createSidebarProjectCommands(settings, calls));
}

export function withHeldProjectAcknowledgement(
  command: ReturnType<typeof createSidebarProjectCommands>,
) {
  let hold = false;
  let release: (() => void) | undefined;
  return {
    hold: () => {
      hold = true;
    },
    release: () => release?.(),
    pending: () => Boolean(release),
    mutateProject: async (request: ProjectMutationRequest) => {
      const result = await command(request);
      if (hold) {
        hold = false;
        await new Promise<void>((resolve) => {
          release = () => {
            release = undefined;
            resolve();
          };
        });
      }
      return result;
    },
  };
}
