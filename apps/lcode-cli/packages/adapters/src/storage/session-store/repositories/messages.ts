import type { DatabaseSync } from "node:sqlite";
import type {
  MessageId,
  MessageInfo,
  MessagePart,
  MessageWithParts,
  PartId,
  SessionId,
  SessionStorePort,
} from "@lcode/contracts";
import { decodeMessageRow, decodePartRow } from "../codecs.js";
import { encodeJson } from "../json.js";
import type { MessageRow, PartRow } from "../rows.js";
import { touchSession } from "./sessions.js";

// 只补回旧版快照字段，不合并整个 JSON：递归 merge 会让已清空的 metadata/options 残留。
import { copyLegacyMembers, preserveLegacyMembers } from "./message-compat.js";
export { savePart, saveParts } from "./message-parts.js";

const MESSAGE_DATA_UPDATE = preserveLegacyMembers("message", [
  "model",
  "providerID",
  "modelID",
  "variant",
]);

// on-conflict 的 sequence 规则：
// 同 scope 再保存必须原样保留现有 sequence——包括 NULL。coalesce(existing, excluded)
// 会把 NULL 历史行（迁移遗漏/旧版本二进制写入）在任何一次再保存时重排到队尾（excluded=max+1），
// assistant 完成后的二次 save 就足以触发，造成时间线漂移；NULL 由 0015 backfill 统一修复。
// 跨 scope 改绑（id 冲突但 session/message 不同，仅导入 upsert 场景）才取 excluded 的新 scope 队尾。
export async function saveMessage(
  db: DatabaseSync,
  input: MessageInfo,
  copyFrom?: Parameters<SessionStorePort["saveMessage"]>[1],
): Promise<void> {
  saveMessageSync(db, input, copyFrom);
}

/** SQLite transaction callers must not yield while this connection owns BEGIN IMMEDIATE. */
export function saveMessageSync(
  db: DatabaseSync,
  input: MessageInfo,
  copyFrom?: Parameters<SessionStorePort["saveMessage"]>[1],
): void {
  const { id, sessionID, ...data } = input;
  // 冻结旧版协议 mapper 无条件读取 user.model；缺少整个对象会让正文也无法打开。
  // 只补必需对象；旧行的原 model 仍由冲突更新/复制逻辑保留，新版 Reader 不使用它。
  const storedData =
    input.role === "user"
      ? {
          ...data,
          model: input.modelSelection
            ? {
                providerID: input.modelSelection.providerId,
                modelID: input.modelSelection.modelId,
                ...(input.modelSelection.options?.reasoningLevel
                  ? { variant: input.modelSelection.options.reasoningLevel }
                  : {}),
              }
            : {},
        }
      : data;
  const timeCreated = input.time.created;
  const timeUpdated =
    input.role === "assistant" ? (input.time.completed ?? Date.now()) : timeCreated;

  db.prepare(
    `
      insert into message (id, session_id, time_created, time_updated, data, sequence)
      values (
        ?,
        ?,
        ?,
        ?,
        ?,
        (
          select coalesce(max(sequence), -1) + 1
          from message
          where session_id = ?
        )
      )
      on conflict(id) do update set
        session_id = excluded.session_id,
        time_updated = excluded.time_updated,
        -- 旧字段是回滚快照，不能因新版 Reader 隐藏了它们而在普通更新时丢掉。
        data = case when message.session_id = excluded.session_id then ${MESSAGE_DATA_UPDATE} else excluded.data end,
        sequence = case
          when message.session_id = excluded.session_id then message.sequence
          else excluded.sequence
        end
      `,
  ).run(
    id,
    sessionID,
    timeCreated,
    timeUpdated,
    encodeJson(copyLegacyMembers(db, "message", storedData, copyFrom)),
    sessionID,
  );
  touchSession(db, sessionID, timeUpdated);
}

export async function removeMessage(
  db: DatabaseSync,
  input: { sessionID: SessionId; messageID: MessageId },
): Promise<void> {
  db.prepare("delete from message where id = ? and session_id = ?").run(
    input.messageID,
    input.sessionID,
  );
}

export async function removePart(
  db: DatabaseSync,
  input: {
    sessionID: SessionId;
    messageID: MessageId;
    partID: PartId;
  },
): Promise<void> {
  db.prepare("delete from part where id = ? and message_id = ? and session_id = ?").run(
    input.partID,
    input.messageID,
    input.sessionID,
  );
}

export async function messages(
  db: DatabaseSync,
  input: { sessionID: SessionId },
): Promise<MessageWithParts[]> {
  return messagesSync(db, input);
}

export function messagesSync(
  db: DatabaseSync,
  input: { sessionID: SessionId },
): MessageWithParts[] {
  const messageRows = db
    .prepare(
      `
      select * from message
      where session_id = ?
      order by sequence is null, sequence, time_created, rowid
      `,
    )
    .all(input.sessionID) as unknown as MessageRow[];

  const partRows = db
    .prepare(
      `
      select * from part
      where session_id = ?
      order by message_id, sequence is null, sequence, time_created, id
      `,
    )
    .all(input.sessionID) as unknown as PartRow[];
  const partsByMessage = new Map<string, MessagePart[]>();

  for (const row of partRows) {
    const part = decodePartRow(row);
    const list = partsByMessage.get(row.message_id) ?? [];
    list.push(part);
    partsByMessage.set(row.message_id, list);
  }

  return messageRows.map((row) => ({
    info: decodeMessageRow(row),
    parts: partsByMessage.get(row.id) ?? [],
  }));
}

export async function messageWithParts(
  db: DatabaseSync,
  input: { sessionID: SessionId; messageID: MessageId },
): Promise<MessageWithParts | null> {
  const messageRow = db
    .prepare("select * from message where id = ? and session_id = ?")
    .get(input.messageID, input.sessionID) as unknown as MessageRow | undefined;
  if (!messageRow) return null;

  const partRows = db
    .prepare(
      `
      select * from part
      where message_id = ? and session_id = ?
      order by sequence is null, sequence, time_created, id
      `,
    )
    .all(input.messageID, input.sessionID) as unknown as PartRow[];
  return {
    info: decodeMessageRow(messageRow),
    parts: partRows.map(decodePartRow),
  };
}
