import type { DatabaseSync, SQLInputValue, SQLOutputValue, StatementSync } from "node:sqlite";
import {
  messageOrder,
  partOrder,
  NON_REASONING,
  PART_TYPE,
  POSSIBLE_EXECUTION,
  TEXT,
  TOOL_NAME,
  VISIBLE,
} from "./memory-evidence-selection.js";

const MESSAGE_BATCH = 128;
const PROJECTED_ROW_BATCH = 16;
const STATEMENT_LIMIT = 32;
const statements = new WeakMap<DatabaseSync, Map<string, StatementSync>>();
function evidenceStatement(db: DatabaseSync, sql: string): StatementSync {
  let cache = statements.get(db);
  if (!cache) {
    cache = new Map();
    statements.set(db, cache);
  }
  const existing = cache.get(sql);
  if (existing) return existing;
  // 只复用编译，不保留参数或结果；历史修改仍在每次执行时从 SQLite 重读。
  if (cache.size >= STATEMENT_LIMIT) cache.delete(cache.keys().next().value!);
  const statement = db.prepare(sql);
  cache.set(sql, statement);
  return statement;
}
export interface MemoryEvidenceRowsState {
  messages?: Record<string, SQLOutputValue>[];
  messageIndex?: number;
  advanceAfterBuffer?: boolean;
  batchSize?: number;
  index: number;
  rowBuffer?: Record<string, SQLOutputValue>[];
}
export function readNextMemoryEvidenceRow(
  db: DatabaseSync,
  input: {
    sessionId: string;
    start: SQLInputValue[];
    end: SQLInputValue[];
    position: SQLInputValue[];
    offset: number;
    maxCharacters: number;
    inclusive: boolean;
    afterMessage: boolean;
    state: MemoryEvidenceRowsState;
  },
) {
  const state = input.state;
  if (!state.messages) {
    const messagePosition = input.position.slice(0, 4);
    const seekMessage = messagePosition.length
      ? `and ${messageOrder("m")} ${input.afterMessage ? ">" : ">="} (?, ?, ?, ?)`
      : "";
    // 先按轻量消息顺序定位，再读该消息的 part；不能先对全部工具排序再 limit 1。
    state.messages = db
      .prepare(`select m.id, exists(select 1 from part c where c.session_id = m.session_id and c.message_id = m.id limit 1 offset ${PROJECTED_ROW_BATCH}) as bulky from message m
      where m.session_id = ? and ${messageOrder("m")} >= (?, ?, ?, ?) and ${messageOrder("m")} <= (?, ?, ?, ?) ${seekMessage}
      order by m.sequence is null, m.sequence, m.time_created, m.rowid limit ${MESSAGE_BATCH}`)
      .all(input.sessionId, ...input.start, ...input.end, ...messagePosition);
  }
  if (state.rowBuffer && state.index < state.rowBuffer.length)
    return { row: state.rowBuffer[state.index++]! };
  if (state.advanceAfterBuffer) {
    state.messageIndex = (state.messageIndex ?? 0) + (state.batchSize ?? 1);
    state.advanceAfterBuffer = false;
  }
  while ((state.messageIndex ?? 0) < state.messages.length) {
    const message = state.messages[state.messageIndex ?? 0]!;
    const batch = [message];
    if (!message.bulky)
      for (const next of state.messages.slice((state.messageIndex ?? 0) + 1)) {
        if (next.bulky || batch.length >= PROJECTED_ROW_BATCH) break;
        batch.push(next);
      }
    const seek = input.position.length
      ? `and ${partOrder("m", "p")} ${input.inclusive ? ">=" : ">"} (${input.position.map(() => "?").join(",")})`
      : "";
    const rows = evidenceStatement(
      db,
      `select m.id as messageId, p.id as partId, json_extract(m.data, '$.role') as role,
      ${PART_TYPE} as type, substr(json_extract(p.data, '$.text'), case when p.id = ? then ? else 1 end, ?) as text, length(json_extract(p.data, '$.text')) as textLength,
      substr(${TOOL_NAME}, 1, 128) as tool, substr(json_extract(p.data, '$.callID'), 1, 128) as callID,
      json_object('exitCode', json_extract(p.data, '$.state.metadata.execution.exitCode'), 'cancelled', json(case json_extract(p.data, '$.state.metadata.execution.cancelled') when 1 then 'true' when 0 then 'false' else 'null' end)) as execution,
      m.sequence as ms, m.time_created as mt, m.rowid as mr, p.sequence as ps, p.time_created as pt, p.id as pr
      from message m join part p on p.message_id = m.id and p.session_id = m.session_id
      where m.session_id = ? and m.id in (${batch.map(() => "?").join(",")}) ${seek} and (${VISIBLE}) and ${NON_REASONING} and ((${TEXT}) or (${PART_TYPE} = 'tool' and ${POSSIBLE_EXECUTION} and json_extract(p.data, '$.state.status') = 'completed' and json_extract(p.data, '$.state.metadata.schemaVersion') = 1 and json_extract(p.data, '$.state.metadata.execution') is not null))
      order by m.sequence is null, m.sequence, m.time_created, m.rowid, p.sequence is null, p.sequence, p.time_created, p.id limit ${PROJECTED_ROW_BATCH}`,
    ).all(
      input.position[7] ?? null,
      input.offset + 1,
      input.maxCharacters,
      input.sessionId,
      ...batch.map((candidate) => candidate.id),
      ...input.position,
    );
    if (rows.length) {
      // 轻量消息按小批读取；含大量 part 的消息独立处理，避免每页重复扫描最终消息的大工具。
      state.rowBuffer = rows;
      state.index = 1;
      state.advanceAfterBuffer = rows.length < PROJECTED_ROW_BATCH;
      state.batchSize = batch.length;
      return { row: rows[0]! };
    }
    state.messageIndex = (state.messageIndex ?? 0) + batch.length;
  }
  if (state.messages.length === MESSAGE_BATCH)
    return { skippedMessage: String(state.messages.at(-1)!.id) };
  return {};
}
