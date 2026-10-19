import type { DatabaseSync } from "node:sqlite";
import type { MessagePart, SessionStorePort } from "@lcode/contracts";
import { partCreatedAt } from "../codecs.js";
import { encodeJson } from "../json.js";
import { touchSession } from "./sessions.js";
import { copyLegacyMembers, preserveLegacyMembers } from "./message-compat.js";

const PART_DATA_UPDATE = preserveLegacyMembers("part", ["fromModel", "toModel", "model"]);
const NEXT_SEQUENCE_SQL = "select coalesce(max(sequence), -1) + 1 n from part where message_id = ?";
const UPSERT_SQL = `insert into part (id,message_id,session_id,time_created,time_updated,data,sequence)
  values (?,?,?,?,?,?,?) on conflict(id) do update set
    message_id=excluded.message_id,session_id=excluded.session_id,time_updated=excluded.time_updated,
    data=case when part.message_id=excluded.message_id and part.session_id=excluded.session_id
      then ${PART_DATA_UPDATE} else excluded.data end,
    sequence=case when part.message_id=excluded.message_id and part.session_id=excluded.session_id
      then part.sequence else excluded.sequence end`;

function storedData(input: MessagePart): Record<string, unknown> {
  const { id: _id, sessionID: _sessionID, messageID: _messageID, ...data } = input;
  if (input.type === "timeline" && input.timelineType === "model_change") {
    const { fromModel, toModel, ...part } = data as typeof input;
    const oldToModel = toModel
      ? {
          providerID: toModel.providerId,
          modelID: toModel.modelId,
          ...(toModel.options?.reasoningLevel ? { variant: toModel.options.reasoningLevel } : {}),
          label: toModel.label,
        }
      : {};
    return {
      ...part,
      toModel: oldToModel,
      fromModelSelection: fromModel,
      toModelSelection: toModel,
    };
  }
  if (input.type === "subtask") {
    const { model, ...part } = data as typeof input;
    return { ...part, modelSelection: model };
  }
  return data;
}

function prepareWriter(db: DatabaseSync, inlineSequence = false) {
  // 单条入口仍在同一 SQL 中分配序号，避免跨连接写入在查询和 INSERT 之间抢占序号。
  const statement = db.prepare(
    inlineSequence
      ? UPSERT_SQL.replace("values (?,?,?,?,?,?,?)", `values (?,?,?,?,?,?,(${NEXT_SEQUENCE_SQL}))`)
      : UPSERT_SQL,
  );
  return (input: MessagePart, data: Record<string, unknown>, sequence: number, now: number) => {
    statement.run(
      input.id,
      input.messageID,
      input.sessionID,
      partCreatedAt(input, now),
      now,
      encodeJson(data),
      inlineSequence ? input.messageID : sequence,
    );
  };
}

export async function savePart(
  db: DatabaseSync,
  input: MessagePart,
  copyFrom?: Parameters<SessionStorePort["savePart"]>[1],
): Promise<void> {
  const now = Date.now();
  prepareWriter(db, true)(
    input,
    copyLegacyMembers(db, "part", storedData(input), copyFrom),
    0,
    now,
  );
  touchSession(db, input.sessionID, now);
}

/** 原子内容提交；不能复用会逐条自动提交、逐条 touch 的公开 savePart。 */
export function saveParts(
  db: DatabaseSync,
  input: Parameters<SessionStorePort["saveParts"]>[0],
): void {
  if (input.parts.length === 0) return;
  const ids = new Set<string>();
  const prepared = input.parts.map((part) => {
    if (part.sessionID !== input.sessionID || part.messageID !== input.messageID)
      throw new Error("Part batch owner mismatch");
    if (ids.has(part.id)) throw new Error("Duplicate part id in batch");
    ids.add(part.id);
    return { part, data: storedData(part) };
  });
  db.exec("begin immediate");
  try {
    if (
      !db
        .prepare("select id from message where id=? and session_id=?")
        .get(input.messageID, input.sessionID)
    ) {
      throw new Error("Part batch message owner missing");
    }
    const owner = db.prepare("select message_id,session_id from part where id=?");
    const existing = new Set<string>();
    for (const { part } of prepared) {
      const previous = owner.get(part.id);
      if (
        previous &&
        (previous.message_id !== input.messageID || previous.session_id !== input.sessionID)
      ) {
        throw new Error("Existing part owner mismatch");
      }
      if (previous) existing.add(part.id);
    }
    let sequence = Number(db.prepare(NEXT_SEQUENCE_SQL).get(input.messageID)!.n);
    const write = prepareWriter(db);
    const now = Date.now();
    // 同连接事务期间不 await；避免其它 session 的写入混进本批次并被一起回滚。
    for (const { part, data } of prepared) {
      write(part, data, sequence, now);
      if (!existing.has(part.id)) sequence++;
    }
    touchSession(db, input.sessionID, now);
    db.exec("commit");
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}
