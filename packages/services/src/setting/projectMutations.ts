import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import {
  isSameLocalProjectPath,
  localProjectPathKey,
  projectDefinitionKey,
  projectDefinitionSchema,
  projectMutationRequestSchema,
  orderProjectMembers,
  projectMemberKey,
  projectMemberIsInOrigin,
  buildRemoteWorkspaceIdentity,
  type RemoteTarget,
  type AppSettings,
  type ProjectDefinition,
  type ProjectMember,
  type ProjectMutationRequest,
  type ProjectMutationResult,
} from "@lcode/shared";

function withMembers(project: ProjectDefinition, previous?: ProjectDefinition): ProjectDefinition {
  const requestedMembers: ProjectMember[] =
    project.members ??
    project.sourceFolderPaths.map(
      (path) =>
        previous?.members?.find(
          (member) =>
            projectMemberIsInOrigin(member, project.workspaceIdentity) &&
            isSameLocalProjectPath(member.path, path),
        ) ?? {
          id: randomUUID(),
          path,
          role: "",
          label: "",
          description: "",
          enabled: true,
        },
    );
  const members = requestedMembers.map((requested) => {
    const existing = previous?.members?.find(
      (member) =>
        projectMemberKey(member, previous.workspaceIdentity) ===
        projectMemberKey(requested, project.workspaceIdentity),
    );
    return {
      ...requested,
      id: existing?.id ?? requested.id,
      role: requested?.role ?? "",
      label: requested?.label ?? "",
      description: requested?.description ?? "",
      enabled: requested?.enabled ?? true,
    };
  });
  const requestedOrder = project.memberOrder ?? requestedMembers.map((member) => member.id);
  const remap = (id: string) =>
    members[requestedMembers.findIndex((member) => member.id === id)]?.id;
  const order = requestedOrder.flatMap((id) => remap(id) ?? []);
  const primaryMemberId =
    (project.primaryMemberId && remap(project.primaryMemberId)) ||
    members.find(
      (member) =>
        projectMemberIsInOrigin(member, project.workspaceIdentity) &&
        isSameLocalProjectPath(member.path, project.primaryFolderPath),
    )?.id;
  return projectDefinitionSchema.parse({
    ...project,
    members,
    primaryMemberId,
    memberOrder: orderProjectMembers(members, order, primaryMemberId).map((member) => member.id),
  });
}

/** 只由 SettingService 在既有文件锁、队列内调用；没有第二个设置文件写入者。 */
export async function applyProjectMutation(
  current: AppSettings,
  input: ProjectMutationRequest,
): Promise<{ next?: AppSettings; result: ProjectMutationResult }> {
  const request = projectMutationRequestSchema.parse(input);
  const signature = JSON.stringify(request);
  const receipt = current.projectMutationReceipts?.find(
    (item) => item.operationId === request.operationId,
  );
  if (receipt) {
    if (receipt.request !== signature)
      throw new Error("Project operationId reused with different content");
    return { result: receipt.result };
  }
  const projects =
    current.projectDefinitions?.projects ??
    current.localProjects.map((project) => withMembers(project));
  const index = projects.findIndex((project) => project.id === request.projectId);
  const previous = projects[index];
  const result = (status: ProjectMutationResult["status"], reason?: string) => ({
    status,
    project: previous ?? null,
    ...(reason ? { reason } : {}),
  });
  if (
    request.type === "remove" &&
    !previous &&
    request.workspace &&
    projects.some(
      (project) =>
        projectDefinitionKey(project) ===
        (request.workspace!.workspaceIdentity?.trim() ||
          localProjectPathKey(request.workspace!.workspacePath)),
    )
  )
    return {
      result: result(
        "conflict",
        "A project was registered for this source; refresh before deleting",
      ),
    };
  if (
    request.expectedRevision === null
      ? Boolean(previous)
      : !previous || (previous.revision ?? 0) !== request.expectedRevision
  )
    return {
      result: result(
        "conflict",
        previous ? "Project was changed in another window" : "Project no longer exists",
      ),
    };
  let saved: ProjectDefinition | null = null;
  if (request.type === "archive" || request.type === "hide") {
    const candidate = previous ?? request.project;
    if (
      candidate.id !== request.projectId ||
      projects.some(
        (project) =>
          project.id !== request.projectId &&
          projectDefinitionKey(project) === projectDefinitionKey(candidate),
      )
    )
      return { result: result("conflict", "Project source already exists") };
    // 中文依据：移除/归档只保存导航事实，不能用 stat 或删除依赖门禁阻止旧 recent、离线来源被隐藏。
    saved = withMembers(
      {
        ...candidate,
        revision: (previous?.revision ?? 0) + 1,
        ...(request.type === "archive"
          ? { archivedAt: previous?.archivedAt ?? Date.now() }
          : { sidebarHiddenAt: previous?.sidebarHiddenAt ?? Date.now() }),
      },
      previous,
    );
  }
  if (request.type === "restore") {
    if (!previous) return { result: result("conflict", "Project no longer exists") };
    const { archivedAt: _archivedAt, ...active } = previous;
    saved = { ...active, revision: (previous.revision ?? 0) + 1 };
  }
  if (request.type === "show") {
    if (!previous) return { result: result("conflict", "Project no longer exists") };
    const { sidebarHiddenAt: _sidebarHiddenAt, ...visible } = previous;
    saved = { ...visible, revision: (previous.revision ?? 0) + 1 };
  }
  if (request.type === "save") {
    const candidate = request.project;
    if (
      !candidate.members &&
      previous?.members?.some(
        (member) => !projectMemberIsInOrigin(member, previous.workspaceIdentity),
      )
    )
      return {
        result: result(
          "validation_failed",
          "This project contains device folders; update the client before editing its sources",
        ),
      };
    if (candidate.id !== request.projectId)
      return { result: result("validation_failed", "Project id does not match") };
    if (
      previous &&
      (projectDefinitionKey(previous) !== projectDefinitionKey(candidate) ||
        !isSameLocalProjectPath(previous.primaryFolderPath, candidate.primaryFolderPath))
    )
      return {
        result: result(
          "validation_failed",
          "The primary folder and source identity cannot be changed",
        ),
      };
    const duplicate = projects.find(
      (project) =>
        project.id !== request.projectId &&
        projectDefinitionKey(project) === projectDefinitionKey(candidate),
    );
    if (duplicate)
      return {
        result: {
          status: "conflict",
          project: duplicate,
          reason: "A project already exists for this source",
        },
      };
    // 中文依据：历史目录可能临时离线，只检查新增本地目录；远端目录必须由目标服务探测，不能在本机 stat。
    {
      const members: Pick<ProjectMember, "path" | "source">[] =
        candidate.members ?? candidate.sourceFolderPaths.map((path) => ({ path }));
      for (const member of members) {
        if (member.source?.kind !== "remote") continue;
        const source = member.source;
        const profile = current.remoteDevices?.devices.find(
          (device) => device.id === source.deviceId,
        );
        const retained = previous?.members?.some(
          (existing) =>
            projectMemberKey(existing, previous.workspaceIdentity) ===
            projectMemberKey(member, candidate.workspaceIdentity),
        );
        if (
          (!profile && !retained) ||
          (profile &&
            buildRemoteWorkspaceIdentity(member.path, profile.target as RemoteTarget) !==
              source.workspaceIdentity)
        )
          return {
            result: result("validation_failed", "Remote member does not match its saved device"),
          };
      }
      const added = members
        .filter(
          (member) =>
            member.source?.kind === "local" || (!member.source && !candidate.workspaceIdentity),
        )
        .filter(
          (member) =>
            !previous?.members?.some(
              (existing) =>
                projectMemberKey(existing, previous.workspaceIdentity) ===
                projectMemberKey(member, candidate.workspaceIdentity),
            ) &&
            !previous?.sourceFolderPaths.some(
              (path) => !candidate.workspaceIdentity && isSameLocalProjectPath(path, member.path),
            ),
        )
        .map((member) => member.path);
      for (let offset = 0; offset < added.length; offset += 4) {
        const checks = await Promise.all(
          added.slice(offset, offset + 4).map(async (path) => {
            try {
              return (await stat(path)).isDirectory() ? null : `${path}: Not a directory`;
            } catch (error) {
              return `${path}: ${error instanceof Error ? error.message : String(error)}`;
            }
          }),
        );
        const failure = checks.find(Boolean);
        if (failure) return { result: result("validation_failed", failure) };
      }
    }
    // 中文依据：旧编辑表单不能清除隐藏/归档事实，生命周期只由对应命令改变。
    const { archivedAt: _archivedAt, sidebarHiddenAt: _sidebarHiddenAt, ...editable } = candidate;
    saved = withMembers(
      {
        ...editable,
        ...(previous?.archivedAt ? { archivedAt: previous.archivedAt } : {}),
        ...(previous?.sidebarHiddenAt ? { sidebarHiddenAt: previous.sidebarHiddenAt } : {}),
        revision: (previous?.revision ?? 0) + 1,
      },
      previous,
    );
  }
  const nextProjects = [...projects];
  if (previous) nextProjects.splice(index, 1, ...(saved ? [saved] : []));
  else if (saved) nextProjects.unshift(saved);
  const applied: ProjectMutationResult = { status: "applied", project: saved };
  const next: AppSettings = {
    ...current,
    projectDefinitions: { version: 1, projects: nextProjects },
    localProjects: nextProjects
      .filter((project) => !project.workspaceIdentity)
      .map(({ workspaceIdentity: _identity, ...project }) => project),
    projectMutationReceipts: [
      // 永久删除不能在旧 save/archive 收据中继续保留可还原的项目定义；删除收据仅保留幂等信息。
      ...(current.projectMutationReceipts ?? []).filter(
        (receipt) => request.type !== "remove" || receipt.result.project?.id !== request.projectId,
      ),
      { operationId: request.operationId, request: signature, result: applied },
    ].slice(-256),
  };
  const removedProject =
    request.type === "remove"
      ? (previous ??
        (request.workspace
          ? {
              id: request.projectId,
              primaryFolderPath: request.workspace.workspacePath,
              sourceFolderPaths: [request.workspace.workspacePath],
              workspaceIdentity: request.workspace.workspaceIdentity,
            }
          : undefined))
      : undefined;
  if (removedProject && current.projectExecutionPreferences) {
    const removedKey = removedProject.workspaceIdentity?.trim() || removedProject.primaryFolderPath;
    next.projectExecutionPreferences = Object.fromEntries(
      Object.entries(current.projectExecutionPreferences).filter(([key]) => key !== removedKey),
    );
  }
  if (removedProject && !removedProject.workspaceIdentity) {
    const retained = new Set(
      next.localProjects.flatMap((project) => project.sourceFolderPaths.map(localProjectPathKey)),
    );
    const removed = new Set(
      removedProject.sourceFolderPaths.map(localProjectPathKey).filter((key) => !retained.has(key)),
    );
    next.recentProjects = current.recentProjects.filter(
      (path) => !removed.has(localProjectPathKey(path)),
    );
    next.lastWorkspaceSession = (current.lastWorkspaceSession ?? []).filter(
      (entry) =>
        entry.kind === "remote" ||
        (entry.localProjectId !== removedProject.id &&
          !removed.has(localProjectPathKey(entry.workspacePath))),
    );
    next.lastActiveTabIndex = Math.min(
      current.lastActiveTabIndex ?? 0,
      Math.max(0, next.lastWorkspaceSession.length - 1),
    );
  }
  if (removedProject?.workspaceIdentity?.trim()) {
    // 远端定义和恢复历史必须在同一次设置提交中删除，避免第二次保存失败留下半删除项目。
    const removedIdentity = removedProject.workspaceIdentity.trim();
    next.lastWorkspaceSession = (current.lastWorkspaceSession ?? []).filter(
      (entry) =>
        entry.kind !== "remote" ||
        (entry.workspaceIdentity?.trim() ||
          buildRemoteWorkspaceIdentity(entry.workspacePath, entry.target)) !== removedIdentity,
    );
    next.lastActiveTabIndex = Math.min(
      current.lastActiveTabIndex ?? 0,
      Math.max(0, next.lastWorkspaceSession.length - 1),
    );
  }
  return { next, result: applied };
}
