import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import {
  legacySessionRecoveryPlanSchema,
  isRemoteWorkspaceIdentity,
  lcodeWorkspaceRefSchema,
  type LegacySessionRecoveryPlan,
} from "@lcode/shared";
import { withFileLock } from "@lcode/shared/node";
import { runSqliteSessionMigrationsAsync } from "./migration-runner.js";
import { copyLegacySessionFiles } from "./legacy-recovery-files.js";
import { importLegacySessionRows } from "./legacy-recovery-import.js";

const RECOVERY_NAMESPACE = "storage.legacy-session-recovery";
const RECOVERY_LOCK_WAIT_MS = 60 * 60_000;
interface SourceSession {
  id: string;
  parent_id: string | null;
  workspace_id: string | null;
  path: string | null;
  directory: string;
  task_type: string;
}
const pathKey = (path: string) =>
  process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);

function matchesWorkspace(
  source: DatabaseSync,
  row: SourceSession,
  expected: LegacySessionRecoveryPlan["sessions"][number],
  inherited = false,
  ancestors = new Set<string>(),
): boolean {
  if (ancestors.has(row.id)) throw new Error("Legacy session parent cycle");
  ancestors.add(row.id);
  const binding = source
    .prepare(
      "SELECT data FROM session_entry WHERE session_id=? AND type='runtime/worktree_binding' ORDER BY time_created DESC,rowid DESC LIMIT 1",
    )
    .get(row.id) as { data: string } | undefined;
  if (binding) {
    const value = lcodeWorkspaceRefSchema.parse(JSON.parse(binding.data));
    const identity = value.originWorkspacePath
      ? value.originWorkspaceIdentity
      : value.workspaceIdentity;
    const path = value.originWorkspacePath ?? value.workspacePath;
    if (value.remoteSessionId || isRemoteWorkspaceIdentity(identity?.trim() || path)) return false;
    return identity?.trim() || expected.workspaceIdentity?.trim()
      ? (identity?.trim() || path) ===
          (expected.workspaceIdentity?.trim() || expected.workspacePath)
      : pathKey(path) === pathKey(expected.workspacePath);
  }
  const identity = row.workspace_id?.trim();
  if (!identity && row.task_type === "subagent_child") {
    // 老 child 只记执行 cwd，继承必须来自已验证的父链，不能拿请求路径充当身份。
    if (inherited) return true;
    if (row.parent_id) {
      const parent = source
        .prepare(
          "SELECT id,parent_id,workspace_id,path,directory,task_type FROM session WHERE id=?",
        )
        .get(row.parent_id) as SourceSession | undefined;
      return parent ? matchesWorkspace(source, parent, expected, false, ancestors) : false;
    }
  }
  if (identity || expected.workspaceIdentity?.trim())
    return (
      (identity || row.path || row.directory) ===
      (expected.workspaceIdentity?.trim() || expected.workspacePath)
    );
  return pathKey(row.path || row.directory) === pathKey(expected.workspacePath);
}

function selectSessions(
  source: DatabaseSync,
  target: DatabaseSync,
  plan: LegacySessionRecoveryPlan,
  sourceKey: string,
): { candidates: string[]; missing: string[] } {
  const rows = source
    .prepare("SELECT id,parent_id,workspace_id,path,directory,task_type FROM session")
    .all() as unknown as SourceSession[];
  const byId = new Map(rows.map((row) => [row.id, row]));
  const children = new Map<string, SourceSession[]>();
  for (const row of rows)
    if (row.parent_id) {
      const siblings = children.get(row.parent_id) ?? [];
      siblings.push(row);
      children.set(row.parent_id, siblings);
    }
  const candidates = new Set<string>();
  const missing = new Set<string>();
  const existing = target.prepare("SELECT 1 FROM session WHERE id=?");
  const processed = target.prepare(
    "SELECT 1 FROM local_setting WHERE scope='global' AND scope_id=? AND namespace=? AND key=?",
  );
  for (const expected of plan.sessions) {
    const root = byId.get(expected.sessionId);
    if (!root || !matchesWorkspace(source, root, expected)) continue;
    const pending = [root];
    const visited = new Set<string>();
    while (pending.length) {
      const row = pending.pop()!;
      if (visited.has(row.id)) throw new Error("Legacy session parent cycle");
      visited.add(row.id);
      if (!matchesWorkspace(source, row, expected, row.id !== root.id)) continue;
      candidates.add(row.id);
      if (existing.get(row.id) || processed.get(sourceKey, RECOVERY_NAMESPACE, row.id)) continue;
      missing.add(row.id);
      pending.push(...(children.get(row.id) ?? []));
    }
  }
  return { candidates: [...candidates], missing: [...missing] };
}

/** Host 只授权当前任务索引引用的历史会话；目标是唯一写入库，旧库只生成一致快照。 */
export async function recoverLegacySessions(
  target: DatabaseSync,
  targetDb: string,
  input: LegacySessionRecoveryPlan,
): Promise<void> {
  const parsed = legacySessionRecoveryPlanSchema.parse(input);
  const plan = {
    ...parsed,
    sessions: parsed.sessions.filter(
      (item) => !isRemoteWorkspaceIdentity(item.workspaceIdentity?.trim() || item.workspacePath),
    ),
  };
  if (!plan.sessions.length) return;
  const sourceDb = await realpath(plan.sourceDatabasePath);
  const actualTarget = await realpath(targetDb);
  if (pathKey(sourceDb) === pathKey(actualTarget)) return;
  const sourceCli = dirname(dirname(sourceDb));
  const targetCli = dirname(dirname(actualTarget));
  const contains = (parent: string, child: string) => {
    const path = relative(parent, child);
    return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
  };
  if (contains(sourceCli, targetCli) || contains(targetCli, sourceCli))
    throw new Error("Legacy session recovery roots overlap");
  const sourceKey = createHash("sha256").update(sourceDb).digest("hex");
  await withFileLock(
    `${targetDb}.legacy-recovery`,
    async () => {
      const processed = target.prepare(
        "SELECT 1 FROM local_setting WHERE scope='global' AND scope_id=? AND namespace=? AND key=?",
      );
      const existing = target.prepare("SELECT 1 FROM session WHERE id=?");
      // 正常重启不再为已处理任务生成整库快照；删除后的标记独立于 session 行保留。
      if (
        plan.sessions.every(
          (item) =>
            processed.get(sourceKey, RECOVERY_NAMESPACE, item.sessionId) ||
            existing.get(item.sessionId),
        )
      )
        return;
      const stagingParent = dirname(targetDb);
      await mkdir(stagingParent, { recursive: true });
      const staging = await mkdtemp(join(stagingParent, ".legacy-recovery-"));
      const snapshotPath = join(staging, "snapshot.sqlite");
      let snapshot: DatabaseSync | undefined;
      let attached = false;
      try {
        const source = new DatabaseSync(sourceDb, { readOnly: true });
        try {
          const hasSession = source.prepare("SELECT 1 FROM session WHERE id=?");
          if (
            !plan.sessions.some(
              (item) => !existing.get(item.sessionId) && hasSession.get(item.sessionId),
            )
          )
            return;
          await backup(source, snapshotPath);
        } finally {
          source.close();
        }
        snapshot = new DatabaseSync(snapshotPath);
        await runSqliteSessionMigrationsAsync(snapshot, snapshotPath);
        const selected = selectSessions(snapshot, target, plan, sourceKey);
        if (!selected.candidates.length) return;
        await copyLegacySessionFiles(sourceDb, targetDb, selected.missing);
        snapshot.close();
        snapshot = undefined;
        target.prepare("ATTACH DATABASE ? AS legacy").run(snapshotPath);
        attached = true;
        target.exec("BEGIN IMMEDIATE");
        try {
          target.exec(
            "PRAGMA defer_foreign_keys=ON; CREATE TEMP TABLE recovery_session(id TEXT PRIMARY KEY)",
          );
          const add = target.prepare(
            "INSERT INTO recovery_session SELECT ? WHERE NOT EXISTS(SELECT 1 FROM session WHERE id=?) AND NOT EXISTS(SELECT 1 FROM local_setting WHERE scope='global' AND scope_id=? AND namespace=? AND key=?)",
          );
          for (const id of selected.missing) add.run(id, id, sourceKey, RECOVERY_NAMESPACE, id);
          importLegacySessionRows(target);
          const mark = target.prepare(
            "INSERT INTO local_setting(scope,scope_id,namespace,key,value,schema_version,time_created,time_updated) VALUES ('global',?,?,?,'true',1,?,?) ON CONFLICT DO NOTHING",
          );
          for (const id of selected.candidates)
            mark.run(sourceKey, RECOVERY_NAMESPACE, id, Date.now(), Date.now());
          target.exec(
            "DROP TABLE recovery_session; DROP TABLE recovery_workflow_run; DROP TABLE recovery_dwf_run; COMMIT",
          );
        } catch (error) {
          target.exec("ROLLBACK");
          throw error;
        }
      } finally {
        snapshot?.close();
        if (attached) target.exec("DETACH DATABASE legacy");
        // staging 来自当前库同目录 mkdtemp，仅删除本次临时快照，不触碰旧库和目标文件。
        if (dirname(staging) === stagingParent) await rm(staging, { recursive: true, force: true });
      }
    },
    { lockMaxWaitMs: RECOVERY_LOCK_WAIT_MS },
  );
}
