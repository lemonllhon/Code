import type { DatabaseSync } from "node:sqlite";

const DIRECT_TABLES = [
  "message",
  "part",
  "todo",
  "session_entry",
  "input_history",
  "session_target",
  "model_usage",
  "turn_usage",
  "tool_usage",
  "session_input",
];
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

function copyRows(db: DatabaseSync, table: string, where: string, regenerateId = false): void {
  const columns = (
    db.prepare(`PRAGMA main.table_info(${quote(table)})`).all() as { name: string }[]
  )
    .map((row) => row.name)
    .filter((name) => !regenerateId || name !== "id")
    .map(quote)
    .join(",");
  // 不使用 OR IGNORE 吞掉约束失败；候选已排除现有 owner，数据异常应整体回滚。
  db.exec(
    `INSERT INTO main.${quote(table)} (${columns}) SELECT ${columns} FROM legacy.${quote(table)} WHERE ${where}`,
  );
}

/** 仅在调用方持有恢复锁与 SQLite 写事务时执行；不复制全局权限、模板或执行 lease。 */
export function importLegacySessionRows(db: DatabaseSync): void {
  copyRows(db, "session", "id IN (SELECT id FROM temp.recovery_session)");
  for (const table of DIRECT_TABLES)
    copyRows(db, table, "session_id IN (SELECT id FROM temp.recovery_session)");
  copyRows(
    db,
    "local_setting",
    "scope='session' AND scope_id IN (SELECT id FROM temp.recovery_session) AND namespace <> 'workflow.execution'",
  );
  for (const [runTable, childTables] of [
    ["workflow_run", ["workflow_activity", "workflow_event"]],
    ["dwf_run", ["dwf_actor", "dwf_node", "dwf_event"]],
  ] as const) {
    const set = `recovery_${runTable}`;
    db.exec(
      `CREATE TEMP TABLE ${set}(id TEXT PRIMARY KEY); INSERT INTO ${set} SELECT id FROM legacy.${runTable} WHERE parent_session_id IN (SELECT id FROM recovery_session) AND id NOT IN (SELECT id FROM main.${runTable})`,
    );
    copyRows(db, runTable, `id IN (SELECT id FROM ${set})`);
    for (const table of childTables)
      copyRows(db, table, `run_id IN (SELECT id FROM ${set})`, table.startsWith("dwf_"));
  }
  copyRows(
    db,
    "session_task_link",
    "child_session_id IN (SELECT id FROM recovery_session) AND (root_workflow_run_id IS NULL OR root_workflow_run_id IN (SELECT id FROM main.workflow_run))",
  );
}
