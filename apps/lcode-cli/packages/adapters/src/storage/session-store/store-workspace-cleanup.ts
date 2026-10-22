import { z } from "zod";
import type { LCodeSessionWorkspaceCleanupParams } from "@lcode/shared";
import type { SqliteStoreAccess } from "./store-access.js";

const JOURNAL_NAMESPACE = "workspace-cleanup";
const JOURNAL_KEY = "session-ids";
const journalSchema = z.array(z.string().min(1));

export const workspaceCleanupMethods = {
  async workspaceCleanup(
    this: SqliteStoreAccess,
    input: LCodeSessionWorkspaceCleanupParams,
  ): Promise<{ sessionIds: string[] }> {
    const scope = input.workspaceIdentity?.trim() || input.workspacePath;
    const read = () => {
      const rows = this.db
        .prepare(
          "select id from session where coalesce(nullif(trim(workspace_id), ''), directory) = ? order by id",
        )
        .all(scope) as { id: string }[];
      const journal = this.db
        .prepare(
          "select value from local_setting where scope='global' and scope_id=? and namespace=? and key=?",
        )
        .get(scope, JOURNAL_NAMESPACE, JOURNAL_KEY) as { value: string } | undefined;
      // 中文依据：正文已删但 diagnostics/ACK 失败后仍需原 ID，不能用空 session 列表宣称清理成功。
      return [
        ...new Set([
          ...rows.map((row) => row.id),
          ...(journal ? journalSchema.parse(JSON.parse(journal.value)) : []),
        ]),
      ].sort();
    };
    if (input.sessionIds === undefined) return { sessionIds: read() };
    this.throwBeforeWrite();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const allowed = read();
      const ids = [...new Set(input.sessionIds)].sort();
      if (ids.some((id) => !allowed.includes(id)))
        throw new Error("Session is outside the confirmed workspace cleanup scope");
      if (ids.length !== allowed.length)
        throw new Error("Workspace cleanup set changed; query again before deleting");
      const now = Date.now();
      this.db
        .prepare(`insert into local_setting(scope,scope_id,namespace,key,value,schema_version,time_created,time_updated)
        values('global',?,?,?,?,1,?,?) on conflict(scope,scope_id,namespace,key) do update set value=excluded.value,time_updated=excluded.time_updated`)
        .run(scope, JOURNAL_NAMESPACE, JOURNAL_KEY, JSON.stringify(ids), now, now);
      for (const id of ids) {
        this.db.prepare("delete from input_history where session_id=?").run(id);
        this.db.prepare("delete from dwf_run where parent_session_id=?").run(id);
        this.db.prepare("delete from workflow_run where parent_session_id=?").run(id);
        this.db.prepare("delete from session where id=?").run(id);
      }
      this.db.exec("COMMIT");
      return { sessionIds: ids };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  },
};
