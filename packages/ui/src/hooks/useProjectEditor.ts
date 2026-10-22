import { projectMemberKey, projectOriginFolderPaths, projectMemberIsInOrigin } from "@lcode/shared";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { replaceRemoteWorkspaceIdentityPath, buildRemoteWorkspaceIdentity } from "@lcode/shared";
import { useEffect, useRef, useState } from "react";
import {
  findProjectDefinition,
  isSameLocalProjectPath,
  orderProjectMembers,
  reorderProjectMembers,
  type ProjectMember,
  type ProjectDefinition,
  type ProjectMutationRequest,
} from "@lcode/shared";
import type { SidebarProjectEditorTarget } from "./useSidebarOrganization.js";
import {
  useBaseWorkspaceServices,
  useWorkspaceServicesResolution,
} from "./useWorkspaceServices.js";
import { useSettings } from "./useSettingService.js";
import { getPathLeaf } from "@/lib/path.js";
import { toast } from "@/components/ui/toast.js";
import { useProjectEditorText } from "@/WorkspaceSidebar/projectEditorText.js";
import { mergeLocalProjectFolderPaths } from "@/createProjectFolderDrop.js";

export function useProjectEditor(target: SidebarProjectEditorTarget, onSaved: () => void) {
  const baseServices = useBaseWorkspaceServices();
  const remoteSessions = useRemoteWorkspaceSessionStore((state) => state.sessionsById);
  const { mutateProject, refresh } = useSettings(baseServices);
  const resolution = useWorkspaceServicesResolution(
    target.workspacePath,
    target.remoteSessionId,
    target.workspaceIdentity,
    target.remoteTarget,
  );
  const text = useProjectEditorText();
  const [base, setBase] = useState<ProjectDefinition | null>(null);
  const [draft, setDraft] = useState<ProjectDefinition | null>(null);
  const [projects, setProjects] = useState<ProjectDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [latest, setLatest] = useState<ProjectDefinition | null | undefined>();
  const [saving, setSaving] = useState(false);
  const [folderErrors, setFolderErrors] = useState<Record<string, string>>(Object.create(null));
  const [checking, setChecking] = useState(false);
  const requestRef = useRef<ProjectMutationRequest | null>(null);
  const loadGeneration = useRef(0);
  const original = useRef("");
  const load = async () => {
    const token = ++loadGeneration.current;
    setLoading(true);
    setError("");
    try {
      const settings = await baseServices.settingService.get();
      const all = settings.projectDefinitions?.projects ?? settings.localProjects;
      const existing = findProjectDefinition(
        all,
        target.workspacePath,
        target.workspaceIdentity,
        target.localProjectId,
      );
      const initial = existing ?? {
        id: crypto.randomUUID(),
        name: target.label || getPathLeaf(target.workspacePath),
        primaryFolderPath: target.workspacePath,
        sourceFolderPaths: [target.workspacePath],
        ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
      };
      const members =
        initial.members ??
        initial.sourceFolderPaths.map((path) => ({
          id: crypto.randomUUID(),
          path,
          role: "",
          label: "",
          description: "",
          enabled: true,
        }));
      const primaryMemberId =
        initial.primaryMemberId ??
        members.find(
          (member) =>
            projectMemberIsInOrigin(member, initial.workspaceIdentity) &&
            isSameLocalProjectPath(member.path, initial.primaryFolderPath),
        )?.id;
      const display = {
        ...initial,
        members,
        primaryMemberId,
        memberOrder: orderProjectMembers(members, initial.memberOrder, primaryMemberId).map(
          (member) => member.id,
        ),
      };
      if (token !== loadGeneration.current) return;
      original.current = JSON.stringify(display);
      setBase(existing ?? null);
      setDraft(display);
      setProjects(all);
      setLatest(undefined);
    } catch (failure) {
      if (token === loadGeneration.current)
        setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (token === loadGeneration.current) setLoading(false);
    }
  };
  useEffect(() => {
    void load();
    return () => {
      loadGeneration.current++;
    };
  }, [
    baseServices.settingService,
    target.workspacePath,
    target.workspaceIdentity,
    target.localProjectId,
  ]);
  const changed = Boolean(draft && JSON.stringify(draft) !== original.current);
  const withMembers = (current: ProjectDefinition, members: ProjectMember[]) => {
    // 中文依据：后来选为主要的非身份目录可以移除；删除后必须立即回到仍保留的身份目录，不能保存悬空 ID。
    const primaryMemberId = members.some((member) => member.id === current.primaryMemberId)
      ? current.primaryMemberId
      : (members.find(
          (member) =>
            projectMemberIsInOrigin(member, current.workspaceIdentity) &&
            isSameLocalProjectPath(member.path, current.primaryFolderPath),
        )?.id ?? members[0]?.id);
    return {
      ...current,
      members,
      primaryMemberId,
      memberOrder: orderProjectMembers(
        members,
        members.map((member) => member.id),
        primaryMemberId,
      ).map((member) => member.id),
      sourceFolderPaths: projectOriginFolderPaths(
        members,
        current.primaryFolderPath,
        current.workspaceIdentity,
      ),
    };
  };
  const setMembers = (members: ProjectMember[]) =>
    setDraft((current) => (current ? withMembers(current, members) : current));
  const setPrimaryMember = (id: string) =>
    setDraft((current) => {
      if (!current?.members?.some((member) => member.id === id)) return current;
      return {
        ...current,
        primaryMemberId: id,
        memberOrder: orderProjectMembers(current.members, current.memberOrder, id).map(
          (member) => member.id,
        ),
      };
    });
  const reorderMembers = (activeId: string, overId: string) =>
    setDraft((current) =>
      current?.members
        ? withMembers(
            current,
            reorderProjectMembers(
              orderProjectMembers(current.members, current.memberOrder, current.primaryMemberId),
              current.primaryMemberId,
              activeId,
              overId,
            ),
          )
        : current,
    );
  const addMember = (member: ProjectMember): boolean => {
    if (!draft || draft.members!.length >= 20) {
      setError(text("limit"));
      return false;
    }
    setDraft((current) =>
      current &&
      current.members!.length < 20 &&
      !current.members!.some(
        (item) =>
          projectMemberKey(item, current.workspaceIdentity) ===
          projectMemberKey(member, current.workspaceIdentity),
      )
        ? withMembers(current, [...current.members!, member])
        : current,
    );
    return true;
  };
  const addFolders = async (paths: string[]): Promise<boolean> => {
    if (!draft || checking || saving) return false;
    const token = loadGeneration.current;
    setChecking(true);
    setError("");
    try {
      const localPaths = draft
        .members!.filter(
          (member) =>
            member.source?.kind === "local" || (!member.source && !draft.workspaceIdentity),
        )
        .map((member) => member.path);
      const merged = mergeLocalProjectFolderPaths(localPaths, paths);
      const available = Math.max(0, 20 - draft.members!.length);
      const addedPaths = merged.addedPaths.slice(0, available);
      if (merged.discardedForLimitCount || merged.addedPaths.length > available)
        setError(text("limit"));
      if (!addedPaths.length) return false;
      for (const path of addedPaths)
        if ((await baseServices.fileService.stat({ path })).type !== "directory")
          throw new Error(`${path}: Not a directory`);
      if (token !== loadGeneration.current) return false;
      setDraft((current) => {
        if (!current) return current;
        const next = [...current.members!];
        for (const path of addedPaths) {
          const member: ProjectMember = {
            id: crypto.randomUUID(),
            path,
            source: { kind: "local" },
            role: "",
            label: "",
            description: "",
            enabled: true,
          };
          if (
            !next.some(
              (item) =>
                projectMemberKey(item, current.workspaceIdentity) ===
                projectMemberKey(member, current.workspaceIdentity),
            ) &&
            next.length < 20
          )
            next.push(member);
        }
        return withMembers(current, next);
      });
      return true;
    } catch (failure) {
      if (token === loadGeneration.current)
        setError(failure instanceof Error ? failure.message : String(failure));
      return false;
    } finally {
      if (token === loadGeneration.current) setChecking(false);
    }
  };
  const signature = JSON.stringify(
    draft?.members?.map((member) => [member.id, member.path, member.source]),
  );
  useEffect(() => {
    let active = true;
    if (!draft) return;
    const members = draft.members ?? [];
    void Promise.all(
      members.map(async (member) => {
        try {
          const identity =
            member.source?.kind === "remote"
              ? member.source.workspaceIdentity
              : member.source?.kind === "local"
                ? undefined
                : draft.workspaceIdentity;
          const source = !identity
            ? baseServices
            : Object.values(remoteSessions).find(
                (session) =>
                  session.target &&
                  buildRemoteWorkspaceIdentity("/", session.target) ===
                    replaceRemoteWorkspaceIdentityPath(identity, "/"),
              )?.services;
          if (!source) throw new Error("Remote device is disconnected");
          if ((await source.fileService.stat({ path: member.path })).type !== "directory")
            throw new Error("Not a directory");
          return [member.id, ""] as const;
        } catch (failure) {
          return [member.id, failure instanceof Error ? failure.message : String(failure)] as const;
        }
      }),
    ).then((checks) => {
      if (active) setFolderErrors(Object.fromEntries(checks.filter(([, error]) => error)));
    });
    return () => {
      active = false;
    };
  }, [signature, baseServices, remoteSessions]);
  const save = async () => {
    if (!draft || saving || checking) return;
    setError("");
    if (!draft.members?.some((member) => member.enabled)) {
      setError(text("noSelection"));
      return;
    }
    const addedError = Object.entries(folderErrors).find(([id]) => {
      const member = draft.members?.find((item) => item.id === id);
      return (
        !base?.members?.some((item) => item.id === id) &&
        !(
          base &&
          member &&
          projectMemberIsInOrigin(member, draft.workspaceIdentity) &&
          base.sourceFolderPaths.some((path) => isSameLocalProjectPath(path, member.path))
        )
      );
    });
    if (addedError) {
      setError(`${addedError[0]}: ${addedError[1]}`);
      return;
    }
    setSaving(true);
    const command = {
      type: "save" as const,
      projectId: draft.id,
      expectedRevision: base ? (base.revision ?? 0) : null,
      project: { ...draft, name: draft.name.trim() },
    };
    const previous = requestRef.current;
    const { operationId: _id, ...previousCommand } = previous ?? { operationId: "" };
    const request: ProjectMutationRequest =
      JSON.stringify(command) === JSON.stringify(previousCommand)
        ? previous!
        : { ...command, operationId: crypto.randomUUID() };
    requestRef.current = request;
    try {
      // 中文依据：响应丢失时重放原 operationId，由设置 owner 核对收据；禁止新 key 重复创建。
      let result;
      try {
        result = await mutateProject(request);
      } catch {
        result = await mutateProject(request);
      }
      if (result.status === "conflict") {
        // 中文依据：另一窗口可能已将隐式目录升级为不同 id 的同源项目，这不是对象被删除。
        setLatest(result.project);
        setError(result.reason ?? text("failed"));
        return;
      }
      if (result.status !== "applied") {
        setError(result.reason ?? text("failed"));
        return;
      }
      toast(text("saved"));
      onSaved();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : text("failed"));
    } finally {
      setSaving(false);
    }
  };
  return {
    base,
    draft,
    setDraft,
    setMembers,
    setPrimaryMember,
    reorderMembers,
    orderedMembers: draft?.members
      ? orderProjectMembers(draft.members, draft.memberOrder, draft.primaryMemberId)
      : [],
    projects,
    loading,
    error,
    latest,
    saving,
    checking,
    folderErrors,
    changed,
    services: resolution.services,
    ready: true,
    addMember,
    async importMember(member: ProjectMember) {
      try {
        const identity =
          member.source?.kind === "remote" ? member.source.workspaceIdentity : undefined;
        const source = !identity
          ? baseServices
          : Object.values(remoteSessions).find(
              (session) =>
                session.target &&
                buildRemoteWorkspaceIdentity("/", session.target) ===
                  replaceRemoteWorkspaceIdentityPath(identity, "/"),
            )?.services;
        if (!source) throw new Error("Remote device is disconnected");
        if ((await source.fileService.stat({ path: member.path })).type !== "directory")
          throw new Error("Not a directory");
        return addMember({ ...member, id: crypto.randomUUID() });
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure));
        return false;
      }
    },
    baseServices,
    addFolders,
    addFolder: (path: string) => addFolders([path]),
    reportFolderError: (message: string | null) => setError(message ?? ""),
    save,
    load,
    reviewLatest: () => {
      if (latest && latest.id === draft?.id) {
        setBase(latest);
        setLatest(undefined);
        setError("");
        requestRef.current = null;
      }
    },
    refresh,
  };
}
