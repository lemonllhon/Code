import { useMemo, useRef } from "react";
import type { IServiceAccessor } from "@lcode/services";
import {
  buildProjectContextSnapshot,
  buildRemoteWorkspaceIdentity,
  findProjectDefinition,
  replaceRemoteWorkspaceIdentityPath,
  resolveWorkspaceKey,
  type AppSettings,
  type IPlatformService,
  type RemoteTarget,
} from "@lcode/shared";
import { createRemoteTargetFromSnapshot } from "@/lib/remoteWorkspaceHistory.js";
import {
  bindRemoteWorkspaceIdentity,
  useRemoteWorkspaceSessionStore,
} from "@/store/remoteWorkspaceSessionStore.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import type { DesktopWorkspaceReconnect } from "./windowWorkspaceReconnect.js";

export interface ProjectWorkspaceTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  localProjectId?: string;
}
interface Connection {
  sessionId: string;
  workspaceIdentity?: string;
  target?: RemoteTarget;
}
interface PreparationPorts {
  getSettings(): Promise<AppSettings>;
  loadCredential(key: string): Promise<string | null>;
  sessions(): readonly Connection[];
  connect(
    target: RemoteTarget,
    requestId?: string,
    context?: Parameters<IPlatformService["connectRemote"]>[2],
  ): Promise<string>;
  dispose(sessionId: string): Promise<void>;
  retain(sessionId: string): void;
  bind(identity: string, sessionId: string): void;
  reconnect: DesktopWorkspaceReconnect;
  isDesktop(): boolean;
}
class PreparationError extends Error {
  constructor(readonly messageId: "project.open.deviceUnavailable" | "project.open.changed") {
    super(messageId);
  }
}
const authority = (identity: string) => replaceRemoteWorkspaceIdentityPath(identity, "/");
const definition = (settings: AppSettings, target: ProjectWorkspaceTarget) =>
  findProjectDefinition(
    settings.projectDefinitions?.projects ?? settings.localProjects,
    target.workspacePath,
    target.workspaceIdentity,
    target.localProjectId,
  );

/** 只合并用户显式打开期间的在途准备；连接和资源生命周期继续归 Root/Host，不保存业务队列。 */
export function createProjectWorkspacePreparation(ports: PreparationPorts) {
  const flights = new Map<string, Promise<void>>();
  const prepare = async (target: ProjectWorkspaceTarget) => {
    const settings = await ports.getSettings();
    const project = definition(settings, target);
    const frozen = project ? JSON.stringify(project) : undefined;
    const context = project ? buildProjectContextSnapshot(settings, target) : null;
    const scopes = new Map<
      string,
      { workspacePath: string; workspaceIdentity: string; deviceId?: string }
    >();
    // 中文依据：origin 是会话运行位置，主要成员可能在另一端；两者需要的连接都必须先准备。
    if (target.workspaceIdentity)
      scopes.set(authority(target.workspaceIdentity)!, {
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
      });
    for (const member of context?.members ?? []) {
      if (!member.workspaceIdentity) continue;
      const key = authority(member.workspaceIdentity)!;
      const previous = scopes.get(key);
      scopes.set(key, {
        workspacePath: previous?.workspacePath ?? member.workspacePath,
        workspaceIdentity: previous?.workspaceIdentity ?? member.workspaceIdentity,
        deviceId: member.source?.kind === "remote" ? member.source.deviceId : previous?.deviceId,
      });
    }
    const created: string[] = [];
    const deviceRevisions = new Map<string, number>();
    try {
      for (const [key, scope] of scopes) {
        const profile = settings.remoteDevices?.devices.find((device) =>
          scope.deviceId
            ? device.id === scope.deviceId
            : authority(
                buildRemoteWorkspaceIdentity(scope.workspacePath, device.target as RemoteTarget),
              ) === key,
        );
        if (
          scope.deviceId &&
          (!profile ||
            authority(
              buildRemoteWorkspaceIdentity(scope.workspacePath, profile.target as RemoteTarget),
            ) !== key)
        )
          throw new PreparationError("project.open.deviceUnavailable");
        if (profile) deviceRevisions.set(profile.id, profile.revision);
        const isOrigin = scope.workspaceIdentity === target.workspaceIdentity;
        const find = () =>
          ports
            .sessions()
            .find((session) =>
              isOrigin
                ? session.workspaceIdentity === scope.workspaceIdentity
                : (session.workspaceIdentity && authority(session.workspaceIdentity) === key) ||
                  (session.target &&
                    authority(buildRemoteWorkspaceIdentity(scope.workspacePath, session.target)) ===
                      key),
            );
        let connection = find();
        if (!connection) {
          if (!ports.isDesktop() || !profile) {
            await ports.reconnect(scope.workspaceIdentity, {
              activateWorkspaceAfterReconnect: false,
              showErrorToast: false,
              throwOnFailure: true,
            });
          } else {
            const snapshot = profile.target;
            const [password, privateKeyPassphrase] =
              snapshot.kind === "ssh"
                ? await Promise.all([
                    snapshot.passwordCredentialKey
                      ? ports.loadCredential(snapshot.passwordCredentialKey)
                      : null,
                    snapshot.privateKeyPassphraseCredentialKey
                      ? ports.loadCredential(snapshot.privateKeyPassphraseCredentialKey)
                      : null,
                  ])
                : [null, null];
            const id = await ports.connect(
              createRemoteTargetFromSnapshot(snapshot, { password, privateKeyPassphrase }),
              crypto.randomUUID(),
              {
                workspacePath: scope.workspacePath,
                workspaceIdentity: scope.workspaceIdentity,
                connectTrigger: "reconnect",
              },
            );
            created.push(id);
          }
          connection = find();
        }
        if (!connection) throw new PreparationError("project.open.deviceUnavailable");
      }
      const current = await ports.getSettings();
      if (
        (frozen !== undefined && JSON.stringify(definition(current, target)) !== frozen) ||
        [...deviceRevisions].some(
          ([id, revision]) =>
            current.remoteDevices?.devices.find((device) => device.id === id)?.revision !==
            revision,
        )
      )
        throw new PreparationError("project.open.changed");
      for (const id of created) ports.retain(id);
      if (target.workspaceIdentity) {
        const origin = ports
          .sessions()
          .find((session) => session.workspaceIdentity === target.workspaceIdentity);
        if (!origin) throw new PreparationError("project.open.deviceUnavailable");
        ports.bind(target.workspaceIdentity, origin.sessionId);
      }
    } catch (error) {
      // 失败只能回收本次新建的 attachment；不能拆掉其它项目已经持有的连接。
      await Promise.allSettled(created.map((id) => ports.dispose(id)));
      throw error;
    }
  };
  return (target: ProjectWorkspaceTarget): Promise<void> => {
    const key = resolveWorkspaceKey(target);
    const previous = flights.get(key);
    if (previous) return previous;
    const operation = prepare(target).finally(() => {
      flights.delete(key);
    });
    flights.set(key, operation);
    return operation;
  };
}

export function useProjectWorkspacePreparation(options: {
  services: IServiceAccessor;
  connect: PreparationPorts["connect"];
  dispose: PreparationPorts["dispose"];
  retain: PreparationPorts["retain"];
  reconnect: DesktopWorkspaceReconnect;
  isDesktop: boolean;
}) {
  const { intl } = useLCodeIntl();
  const latest = useRef(options);
  latest.current = options;
  const prepare = useMemo(
    () =>
      createProjectWorkspacePreparation({
        getSettings: () => latest.current.services.settingService.get(),
        loadCredential: (key) => latest.current.services.credentialService.load(key),
        sessions: () => Object.values(useRemoteWorkspaceSessionStore.getState().sessionsById),
        connect: (...args) => latest.current.connect(...args),
        dispose: (id) => latest.current.dispose(id),
        retain: (id) => latest.current.retain(id),
        bind: bindRemoteWorkspaceIdentity,
        reconnect: (...args) => latest.current.reconnect(...args),
        isDesktop: () => latest.current.isDesktop,
      }),
    [options.services],
  );
  return useMemo(
    () => async (target: ProjectWorkspaceTarget) => {
      try {
        await prepare(target);
      } catch (error) {
        throw error instanceof PreparationError
          ? new Error(intl.formatMessage({ id: error.messageId }))
          : error;
      }
    },
    [prepare, intl],
  );
}
