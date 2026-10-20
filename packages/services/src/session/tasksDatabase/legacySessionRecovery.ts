import { access, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  isRemoteWorkspaceIdentity,
  LCODE_AGENT_PROVIDER,
  type LegacySessionRecoveryPlan,
} from "@lcode/shared";
import { getLCodeDataRootDir, getTasksIndexDatabasePath } from "#src/paths.js";
import { TaskIndexRepo } from "#src/session/taskIndexRepo.js";

/** 任务索引只提供恢复范围；会话数据的校验、去重和写入仍由 CLI storage owner 执行。 */
export async function planLegacySessionRecovery(options: {
  targetDatabasePath: string;
  tasksDatabasePath?: string;
  dataRoot?: string;
  legacyHome?: string;
}): Promise<LegacySessionRecoveryPlan | undefined> {
  const target = resolve(options.targetDatabasePath);
  const current = resolve(options.dataRoot ?? getLCodeDataRootDir(), "cli", "db", "db.sqlite");
  const source = join(options.legacyHome ?? homedir(), ".lcode", "cli", "db", "db.sqlite");
  const canonical = async (path: string) =>
    realpath(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return resolve(path);
      throw error;
    });
  const compare = (path: string) => (process.platform === "win32" ? path.toLowerCase() : path);
  const actualTarget = compare(await canonical(target));
  // 项目/CLI 显式数据库路径不能被当成应用资料根自动导入另一个 profile。
  if (actualTarget !== compare(await canonical(current))) return undefined;
  if (compare(await canonical(source)) === actualTarget) return undefined;
  try {
    await access(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const tasks = new TaskIndexRepo(options.tasksDatabasePath ?? getTasksIndexDatabasePath());
  try {
    const metas = await tasks.listTaskMetas({ provider: LCODE_AGENT_PROVIDER });
    const sessions = metas
      .filter(
        (meta) => !isRemoteWorkspaceIdentity(meta.workspaceIdentity?.trim() || meta.workspacePath),
      )
      .map((meta) => ({
        sessionId: meta.taskId,
        workspacePath: meta.workspacePath,
        ...(meta.workspaceIdentity ? { workspaceIdentity: meta.workspaceIdentity } : {}),
      }));
    return sessions.length ? { sourceDatabasePath: source, sessions } : undefined;
  } finally {
    tasks.close({ throwOnError: true });
  }
}
