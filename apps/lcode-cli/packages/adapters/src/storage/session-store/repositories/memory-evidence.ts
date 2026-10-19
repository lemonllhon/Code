import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
  ReadMemoryReviewEvidenceSchema,
  parseCompletedToolPartMetadata,
  type ReadMemoryReviewEvidenceInput,
  type MemoryReviewEvidencePage,
} from "@lcode/contracts";
import { getSession } from "./sessions.js";
import {
  anchor,
  messageOrder,
  proveBranch,
  selectionHash,
  TEXT,
  VISIBLE,
  NON_REASONING,
  TOOL_NAME,
  PART_TYPE,
} from "./memory-evidence-selection.js";

import { memoryEvidenceProof } from "./memory-evidence-proof-cache.js";

import { readNextMemoryEvidenceRow, type MemoryEvidenceRowsState } from "./memory-evidence-rows.js";
import { hasDirectMemoryWrite } from "./memory-evidence-writes.js";

const PAGE_ROWS = 128;
const FACT_PREFIX = "\nStructured tool states (exit status proves only that call): ";

/** 原始工具结果和 reasoning 不参与预算；SQL 只返回可见正文的当前片段与结构化执行事实。 */
export function readMemoryReviewEvidence(
  db: DatabaseSync,
  input: ReadMemoryReviewEvidenceInput,
): MemoryReviewEvidencePage {
  const { signal, ...raw } = input;
  const parsed = ReadMemoryReviewEvidenceSchema.parse(raw);
  signal?.throwIfAborted();
  db.exec("savepoint memory_review_evidence");
  try {
    const result = readPage(db, { ...parsed, sessionID: input.sessionID, signal });
    db.exec("release savepoint memory_review_evidence");
    return result;
  } catch (error) {
    db.exec("rollback to savepoint memory_review_evidence");
    db.exec("release savepoint memory_review_evidence");
    throw error;
  }
}

function readPage(
  db: DatabaseSync,
  input: ReadMemoryReviewEvidenceInput,
): MemoryReviewEvidencePage {
  const session = getSession(db, input.sessionID);
  const result: MemoryReviewEvidencePage = {
    session,
    status: "unavailable",
    reason: "missing-boundary",
    startMessageID: input.startMessageID ?? "",
    throughMessageID: input.throughMessageID,
    selection: "",
    content: "",
    projectedRows: 0,
  };
  const end = anchor(db, input.sessionID, input.throughMessageID);
  if (!session || !end) return result;
  const endInfo = db
    .prepare(
      `select json_extract(data, '$.role') as role, json_extract(data, '$.time.completed') as completed, json_extract(data, '$.error') as error, json_extract(data, '$.anchor.turnId') as turnId, json_extract(data, '$.anchor.boundaryMessageId') as boundaryId, json_extract(data, '$.anchor.orderedMessageIds[0]') as startId from message where session_id = ? and id = ?`,
    )
    .get(session.id, input.throughMessageID);
  if (endInfo?.role !== "assistant" || !endInfo.completed || endInfo.error) return result;
  if (
    (input.turnId && endInfo.turnId !== input.turnId) ||
    (endInfo.boundaryId && endInfo.boundaryId !== input.throughMessageID)
  )
    return result;
  const startId =
    input.startMessageID ??
    (typeof endInfo.startId === "string" ? endInfo.startId : undefined) ??
    (db
      .prepare(
        `select m.id from message m where m.session_id = ? and ${messageOrder("m")} <= (?, ?, ?, ?) and json_extract(m.data, '$.role') = 'user' and ${VISIBLE} order by m.sequence is null desc, m.sequence desc, m.time_created desc, m.rowid desc limit 1`,
      )
      .get(session.id, ...end)?.id as string | undefined);
  if (endInfo.startId && startId !== endInfo.startId) return result;
  if (!startId) return { ...result, reason: "no-user-prose" };
  const start = anchor(db, session.id, startId);
  if (!start) return result;
  result.startMessageID = startId;
  result.selection = selectionHash(session, startId, input.throughMessageID);
  if (input.cursor && input.cursor.selection !== result.selection)
    return { ...result, reason: "stale-source" };
  if (!proveBranch(db, session, startId)) return { ...result, reason: "branch-unprovable" };
  const range = `m.session_id = ? and ${messageOrder("m")} >= (?, ?, ?, ?) and ${messageOrder("m")} <= (?, ?, ?, ?)`;
  const args = [session.id, ...start, ...end];
  const proof = memoryEvidenceProof(
    db,
    result.selection + JSON.stringify(input.memoryScope ?? null),
  );
  if (!proof.valid) {
    const user = db
      .prepare(
        `select 1 from message m join part p on p.message_id = m.id and p.session_id = m.session_id where ${range} and m.id = ? and json_extract(m.data, '$.role') = 'user' and ${VISIBLE} and ${TEXT} limit 1`,
      )
      .get(...args, startId);
    if (!user) return { ...result, reason: "no-user-prose" };
    const review = db
      .prepare(
        `select 1 from message m join part p on p.message_id = m.id and p.session_id = m.session_id where ${range} and ${NON_REASONING} and ${PART_TYPE} = 'tool' and (${TOOL_NAME} = 'MemoryReviewApply' or (${TOOL_NAME} = 'MemoryReview' and json_extract(p.data, '$.state.input.action') in ('create','read','list')) or (${TOOL_NAME} = 'MemoryHistory' and json_extract(p.data, '$.state.input.action') = 'undo')) limit 1`,
      )
      .get(...args);
    if (review) return { ...result, reason: "foreground-review" };
    if (hasDirectMemoryWrite(db, input.memoryScope, range, args))
      return { ...result, reason: "direct-memory-write" };
    proof.remember();
  }
  let position: SQLInputValue[] = input.cursor
    ? input.cursor.afterMessage
      ? [...(anchor(db, session.id, input.cursor.messageId) ?? []), 0, 0, 0, 0]
      : (cursorPosition(db, session.id, input.cursor.messageId, input.cursor.partId) ?? [])
    : [];
  if (input.cursor && position.length === 0) return { ...result, reason: "stale-source" };
  if (input.cursor?.offset) {
    const part = db
      .prepare(
        "select json_extract(data, '$.type') as type, length(json_extract(data, '$.text')) as length from part where session_id = ? and message_id = ? and id = ?",
      )
      .get(session.id, input.cursor.messageId, input.cursor.partId);
    // 原文被缩短或 cursor 被错误复用时，不能越过不存在的正文后假报已经覆盖。
    if (
      input.cursor.afterMessage ||
      part?.type !== "text" ||
      Number(part.length) <= input.cursor.offset
    )
      return { ...result, reason: "stale-source" };
  }
  let offset = input.cursor?.offset ?? 0;
  let content = "";
  const rowsState: MemoryEvidenceRowsState = { index: 0 };
  result.status = "ready";
  delete result.reason;
  // 页内也有扫描批次，取消或后续请求可继续；不会把长逻辑轮次当作超额失败。
  for (let count = 0; count < PAGE_ROWS; count++) {
    input.signal?.throwIfAborted();
    const next = readNextMemoryEvidenceRow(db, {
      state: rowsState,
      sessionId: session.id,
      start,
      end,
      position,
      offset,
      maxCharacters: input.maxCharacters,
      inclusive: offset > 0 || Boolean(input.cursor?.inclusive && count === 0),
      afterMessage: Boolean(input.cursor?.afterMessage && count === 0),
    });
    if (next.skippedMessage)
      return {
        ...result,
        content,
        nextCursor: {
          messageId: next.skippedMessage,
          partId: "none",
          offset: 0,
          afterMessage: true,
          selection: result.selection,
        },
      };
    const row = next.row;
    if (!row) return { ...result, content };
    result.projectedRows++;
    const nextPosition = [
      Number(row.ms === null),
      row.ms ?? 0,
      row.mt,
      row.mr,
      Number(row.ps === null),
      row.ps ?? 0,
      row.pt,
      row.pr,
    ];
    let text = "";
    if (row.type === "text")
      text = (offset ? "" : `\n${row.role === "user" ? "User" : "Assistant"}: `) + String(row.text);
    else {
      let execution: unknown;
      try {
        execution = JSON.parse(String(row.execution));
      } catch {
        /* 未知元数据不构成执行证明。 */
      }
      const parsed = parseCompletedToolPartMetadata({ schemaVersion: 1, execution });
      if (parsed?.execution)
        text =
          FACT_PREFIX +
          JSON.stringify({
            tool: row.tool,
            callID: row.callID,
            status: "completed",
            execution: parsed.execution,
          });
    }
    const room = input.maxCharacters - content.length;
    const prefixLength =
      row.type === "text" && !offset
        ? `\n${row.role === "user" ? "User" : "Assistant"}: `.length
        : 0;
    if ((text.length > room && row.type !== "text") || room <= prefixLength) {
      if (!content) throw new Error("Structured execution fact exceeds evidence page");
      return {
        ...result,
        content,
        nextCursor: {
          messageId: String(row.messageId),
          partId: String(row.partId),
          offset: 0,
          inclusive: true,
          selection: result.selection,
        },
      };
    }
    let admitted = text.slice(0, room);
    if (/[\uD800-\uDBFF]$/u.test(admitted)) admitted = admitted.slice(0, -1);
    content += admitted;
    const consumed = Array.from(admitted.slice(prefixLength)).length;
    if (row.type === "text" && offset + consumed < Number(row.textLength)) {
      return {
        ...result,
        content,
        nextCursor: {
          messageId: String(row.messageId),
          partId: String(row.partId),
          offset: offset + consumed,
          selection: result.selection,
        },
      };
    }
    position = nextPosition;
    offset = 0;
    if (content.length >= input.maxCharacters || count === PAGE_ROWS - 1)
      return {
        ...result,
        content,
        nextCursor: {
          messageId: String(row.messageId),
          partId: String(row.partId),
          offset: 0,
          selection: result.selection,
        },
      };
  }
  return { ...result, content };
}

function cursorPosition(
  db: DatabaseSync,
  session: string,
  message: string,
  part: string,
): SQLInputValue[] | undefined {
  const m = anchor(db, session, message);
  const p = db
    .prepare(
      `select sequence, time_created, id as r from part where session_id = ? and message_id = ? and id = ?`,
    )
    .get(session, message, part);
  return m && p
    ? [...m, Number(p.sequence === null), p.sequence ?? 0, p.time_created, p.r]
    : undefined;
}
