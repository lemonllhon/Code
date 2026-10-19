import { createHash } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { SessionInfo } from "@lcode/contracts";

export const messageOrder = (alias: string) =>
  `(${alias}.sequence is null, coalesce(${alias}.sequence, 0), ${alias}.time_created, ${alias}.rowid)`;
export const partOrder = (m: string, p: string) =>
  `(${m}.sequence is null, coalesce(${m}.sequence, 0), ${m}.time_created, ${m}.rowid, ${p}.sequence is null, coalesce(${p}.sequence, 0), ${p}.time_created, ${p}.id)`;
// 当前 writer 的规范 JSON 可先按已知首字段排除 reasoning；非规范旧 JSON 仍走 json_extract 校验。
// 这是确定无关类型的快速路径，不靠工具输出内容判断控制操作或执行成功。
export const NON_REASONING = `p.data not glob '{"type":"reasoning"*'`;
// 大 Read 的 state.output 不参与记忆。仅在头部自身是完整 JSON 对象时使用快路径，
// 旧键顺序/空白/转义均回退完整 JSON 解析，不能靠字符串包含来放过 MemoryReview。
const HEADER = `substr(p.data, 1, instr(p.data, ',"callID":') - 1) || '}'`;
export const TOOL_NAME = `case when p.data glob '{"type":"tool","tool":"*' and instr(p.data, ',"callID":') between 1 and 1024 and json_valid(${HEADER}) then json_extract(${HEADER}, '$.tool') else json_extract(p.data, '$.tool') end`;
export const PART_TYPE = `case when p.data glob '{"type":"text",*' then 'text' when p.data glob '{"type":"tool",*' then 'tool' else json_extract(p.data, '$.type') end`;
export const POSSIBLE_EXECUTION = `(instr(p.data, '"execution"') > 0 or instr(p.data, '\\u') > 0)`;
export const VISIBLE = `coalesce(json_extract(m.data, '$.semantics.transcriptVisibility'), '') != 'hidden'
  and (json_extract(m.data, '$.summary') is null or (json_extract(m.data, '$.role') = 'assistant' and json_extract(m.data, '$.summary') = 0))
  and not exists (select 1 from part cp where cp.session_id = m.session_id and cp.message_id = m.id
    and ${NON_REASONING.replaceAll("p.data", "cp.data")} and ${PART_TYPE.replaceAll("p.data", "cp.data")} = 'compaction')
  and (json_extract(m.data, '$.semantics') is null or
    (json_extract(m.data, '$.semantics.uiVisibility') = 'visible' and
      ((json_extract(m.data, '$.role') = 'user' and json_extract(m.data, '$.semantics.origin') = 'real_user') or
       (json_extract(m.data, '$.role') = 'assistant' and json_extract(m.data, '$.semantics.origin') = 'agent_runtime' and json_extract(m.data, '$.semantics.kind') = 'assistant_response'))))
  and (json_extract(m.data, '$.role') != 'user' or
    (coalesce(json_extract(m.data, '$.synthetic'), 0) != 1 and json_extract(m.data, '$.source') is null
    and coalesce(json_extract(m.data, '$.visibility'), '') != 'model-only'))`;
export const TEXT = `${PART_TYPE} = 'text'
  and coalesce(json_extract(p.data, '$.ignored'), 0) != 1
  and coalesce(json_extract(p.data, '$.synthetic'), 0) != 1
  and length(trim(json_extract(p.data, '$.text'))) > 0
  and instr(lower(json_extract(p.data, '$.text')), 'system-reminder') = 0`;

export function anchor(db: DatabaseSync, session: string, id: string): SQLInputValue[] | undefined {
  const row = db
    .prepare(
      `select sequence, time_created, rowid as r from message where session_id = ? and id = ?`,
    )
    .get(session, id);
  return row
    ? [Number(row.sequence === null), row.sequence ?? 0, row.time_created, row.r]
    : undefined;
}

export function proveBranch(db: DatabaseSync, session: SessionInfo, start: string): boolean {
  const revert = session.revert;
  if (!revert) return true;
  if (!revert.targetMessageID)
    return !revert.branchCutAfterMessageID && !revert.createdMessageID && !revert.keptMessageIDs;
  if (!anchor(db, session.id, revert.targetMessageID)) return false;
  const first = anchor(db, session.id, start);
  if (!first) return false;
  if (revert.branchCutAfterMessageID) {
    return Boolean(
      db
        .prepare(
          `select 1 from message m where m.session_id = ? and m.id = ? and ${messageOrder("m")} < (?, ?, ?, ?)`,
        )
        .get(session.id, revert.branchCutAfterMessageID, ...first),
    );
  }
  if (revert.createdMessageID) {
    return Boolean(
      db
        .prepare(
          `select 1 from message m where m.session_id = ? and m.id = ? and ${messageOrder("m")} <= (?, ?, ?, ?)`,
        )
        .get(session.id, revert.createdMessageID, ...first),
    );
  }
  return false;
}

export function selectionHash(session: SessionInfo, start: string, end: string): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: 2,
        session: session.id,
        workspace: session.workspaceID ?? session.directory,
        task: session.taskType,
        parent: session.parentID,
        archived: session.time.archived,
        revert: session.revert,
        start,
        end,
      }),
    )
    .digest("hex");
}
