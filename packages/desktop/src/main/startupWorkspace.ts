import { constants } from "node:fs";
import { access, mkdir, readFile, stat } from "node:fs/promises";
import { appSettingsSchema, formatZodError, type WorkspacePurpose } from "@lcode/shared";

interface StartupWorkspaceLogger {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
}

async function readStartupSettings(settingsFile: string, logger?: StartupWorkspaceLogger) {
  try {
    const raw = await readFile(settingsFile, "utf-8");
    const parsed = JSON.parse(raw);
    const result = appSettingsSchema.safeParse(parsed);

    if (!result.success) {
      logger?.warn?.(
        "[startup-workspace] invalid settings file, falling back to default workspace:",
        formatZodError(result.error),
      );
      return appSettingsSchema.parse({});
    }

    return result.data;
  } catch {
    return appSettingsSchema.parse({});
  }
}

export interface StartupWorkspaceWarmupTarget {
  workspacePath: string;
  workspaceIdentity?: string;
}

export interface StartupWindowBootstrap {
  restoreSession?: boolean;
  initialWorkspacePath?: string;
  initialWorkspacePurpose?: WorkspacePurpose;
  unavailableWorkspacePath?: string;
  agentWarmupTargets?: StartupWorkspaceWarmupTarget[];
}

async function isAvailableWorkspaceDirectory(workspacePath: string): Promise<boolean> {
  try {
    const workspaceStat = await stat(workspacePath);
    if (!workspaceStat.isDirectory()) {
      return false;
    }
    await access(workspacePath, constants.R_OK | constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolvePersistedActiveSession(
  sessions: NonNullable<ReturnType<typeof appSettingsSchema.parse>["lastWorkspaceSession"]>,
  lastActiveTabIndex: number | undefined,
) {
  if (sessions.length === 0) {
    return undefined;
  }
  const activeIndex = Math.min(Math.max(lastActiveTabIndex ?? 0, 0), sessions.length - 1);
  return sessions[activeIndex];
}

export function createOpenWorkspaceStartupBootstrap(workspacePath: string): StartupWindowBootstrap {
  return {
    initialWorkspacePath: workspacePath,
    initialWorkspacePurpose: "project",
    agentWarmupTargets: [{ workspacePath }],
  };
}

export async function resolveStartupWindowBootstrap({
  settingsFile,
  conversationWorkspaceDir,
  explicitBootstrap,
  logger,
}: {
  settingsFile: string;
  conversationWorkspaceDir: string;
  explicitBootstrap?: StartupWindowBootstrap;
  logger?: StartupWorkspaceLogger;
}): Promise<StartupWindowBootstrap> {
  // 默认对话目录也是所有本地 Host 的备用 cwd。旧逻辑只在无标签或 active 本地项目
  // 不可用时创建它；远程 active 后选中已删除的对话目录会让存储 Worker 在握手前退出。
  // 每次主窗口启动都先幂等准备 app 管理的目录，显式打开项目也走此入口，不恢复用户项目。
  await mkdir(conversationWorkspaceDir, { recursive: true });
  if (explicitBootstrap) {
    const path = explicitBootstrap.initialWorkspacePath;
    const available = path && (await isAvailableWorkspaceDirectory(path));
    return {
      ...explicitBootstrap,
      ...(path && !available ? { unavailableWorkspacePath: path } : {}),
      agentWarmupTargets: available ? [{ workspacePath: path }] : [],
    };
  }

  const settings = await readStartupSettings(settingsFile, logger);
  const sessions = settings.lastWorkspaceSession ?? [];

  if (sessions.length > 0) {
    const persistedActiveSession = resolvePersistedActiveSession(
      sessions,
      settings.lastActiveTabIndex,
    );
    const unavailableWorkspacePath =
      persistedActiveSession?.kind === "local" &&
      !(await isAvailableWorkspaceDirectory(persistedActiveSession.workspacePath))
        ? persistedActiveSession.workspacePath
        : undefined;
    if (unavailableWorkspacePath) {
      // 上次激活 workspace 被移动或删除后，Agent 仍需保留原业务路径读取历史，
      // 但子进程 cwd 必须落在真实存在的目录；conversation backing workspace 只承担 cwd 兜底。
      logger?.warn?.(
        "[startup-workspace] active local workspace unavailable; using read-only restore:",
        unavailableWorkspacePath,
      );
    }
    // 预热资格只来自可见且有效的本地标签；隐藏项目/最近项目不是执行需求。
    // 远程 active 也必须发送明确空名单，避免 Host 兼容路径误启动本地 Agent。
    return {
      ...(unavailableWorkspacePath ? { unavailableWorkspacePath } : {}),
      agentWarmupTargets:
        persistedActiveSession?.kind === "local" && !unavailableWorkspacePath
          ? [{ workspacePath: persistedActiveSession.workspacePath }]
          : [],
    };
  }

  // UI 可以没有项目，但 Agent 必须始终有真实 cwd。首次启动统一预热
  // app-managed conversation backing workspace，不能再创建会被误认成项目的 LCodeProject。
  logger?.info?.("[startup-workspace] using conversation workspace:", conversationWorkspaceDir);
  return {
    initialWorkspacePath: conversationWorkspaceDir,
    initialWorkspacePurpose: "conversation",
    agentWarmupTargets: [{ workspacePath: conversationWorkspaceDir }],
  };
}
