import type { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import {
  HISTORY_DISCOVERY_SESSION_LIMIT,
  HISTORY_DISCOVERY_PART_LIMIT,
  HISTORY_DISCOVERY_PART_BYTES,
  HISTORY_DISCOVERY_TOTAL_BYTES,
  SESSION_HISTORY_SEARCH_TITLE_CHARACTER_LIMIT,
  HISTORY_DISCOVERY_TERM_LIMIT,
  HISTORY_DISCOVERY_TERM_CHARACTERS,
  type DiscoverSessionHistoryInput,
  type DiscoveredSessionHistory,
  type MessageId,
} from "@lcode/contracts";
import { decodeSessionRow } from "../codecs.js";
import type { SessionRow } from "../rows.js";

const RESULT_LIMIT = 20;
const FOLLOWING_MESSAGES = 2;
const TASK_TYPES = ["interactive", "fork", "workflow_parent"] as const;

/** 查询发现只决定候选与读取锚点；有效分支/可见性仍由后续原子窗口验证。 */
export async function discoverSessionHistory(
  db: DatabaseSync,
  input: DiscoverSessionHistoryInput,
): Promise<DiscoveredSessionHistory> {
  input.signal?.throwIfAborted();
  const terms = [
    ...new Set(
      input.queryTerms
        .slice(0, HISTORY_DISCOVERY_TERM_LIMIT)
        .map((term) =>
          term.slice(0, HISTORY_DISCOVERY_TERM_CHARACTERS).normalize("NFKC").toLowerCase(),
        )
        .filter(Boolean),
    ),
  ];
  const sessions = historySessions(db, input);
  let partial = sessions.length > HISTORY_DISCOVERY_SESSION_LIMIT;
  const readParts =
    db.prepare(`with selected as materialized (select p.rowid as ordinal, p.message_id, p.data,
    length(cast(p.data as blob)) as data_bytes
    from part p join message m on m.id = p.message_id and m.session_id = p.session_id
    where p.session_id = ? order by m.sequence is null desc, m.sequence desc, m.time_created desc,
      m.rowid desc, p.sequence is null desc, p.sequence desc, p.time_created desc, p.rowid desc limit ?)
    select message_id, data_bytes,
      case when data_bytes <= ${HISTORY_DISCOVERY_PART_BYTES} and
        sum(case when data_bytes <= ${HISTORY_DISCOVERY_PART_BYTES} then data_bytes else 0 end)
          over (order by ordinal desc rows between unbounded preceding and current row) <= ?
      then data else null end as data from selected order by ordinal desc`);
  let remainingBytes = HISTORY_DISCOVERY_TOTAL_BYTES;
  const ranked = [];
  for (const session of sessions.slice(0, HISTORY_DISCOVERY_SESSION_LIMIT)) {
    input.signal?.throwIfAborted();
    if (session.id === input.excludeSessionID || (session.parentID && session.taskType !== "fork"))
      continue;
    const titleScore = score(
      session.title.slice(0, SESSION_HISTORY_SEARCH_TITLE_CHARACTER_LIMIT),
      terms,
    );
    let bodyScore = 0;
    let anchor: string | undefined;
    const parts = readParts.all(session.id, HISTORY_DISCOVERY_PART_LIMIT, remainingBytes) as {
      message_id: string;
      data: string | null;
      data_bytes: number;
    }[];
    partial ||= parts.length >= HISTORY_DISCOVERY_PART_LIMIT;
    for (const row of parts) {
      if (row.data === null) {
        partial = true;
        continue;
      }
      remainingBytes -= row.data_bytes;
      const part = JSON.parse(row.data);
      if (
        part.type !== "text" ||
        part.synthetic === true ||
        part.ignored === true ||
        typeof part.text !== "string"
      )
        continue;
      const current = score(part.text, terms);
      if (current > bodyScore) {
        bodyScore = current;
        anchor = row.message_id;
      }
    }
    ranked.push({
      session,
      score: titleScore + bodyScore,
      throughMessageID: readBoundary(db, session.id, anchor),
    });
  }
  ranked.sort(
    (a, b) =>
      b.score - a.score ||
      b.session.time.updated - a.session.time.updated ||
      (a.session.id < b.session.id ? -1 : a.session.id > b.session.id ? 1 : 0),
  );
  const limit = Number.isFinite(input.limit)
    ? Math.max(1, Math.min(RESULT_LIMIT, Math.trunc(input.limit)))
    : RESULT_LIMIT;
  return {
    candidates: ranked.slice(0, limit).map(({ score: _score, ...candidate }) => candidate),
    partial: partial || ranked.length > limit,
  };
}

function historySessions(db: DatabaseSync, input: DiscoverSessionHistoryInput) {
  const identity = input.workspaceIdentity?.trim();
  const path = "coalesce(nullif(path, ''), directory)";
  const windows = process.platform === "win32";
  // Windows picker 保存正斜杠，Runtime resolve 产生反斜杠；scope 必须与最终文件路径校验一致。
  // 只规范本地路径，带 identity 的记录仍严格按 identity 匹配，且在 SQL 内先过滤再限额。
  const cwd = process.cwd();
  const keyOf = (value: string) => {
    const normalized = resolve(cwd, value);
    return windows ? normalized.toLowerCase() : normalized;
  };
  db.function("lcode_history_path_key", { deterministic: true }, (value) =>
    typeof value === "string" && value ? keyOf(value) : null,
  );
  const key = identity ?? keyOf(input.workspaceRoot);
  const rows = db
    .prepare(`select * from session where time_archived is null
    and task_type in (${TASK_TYPES.map(() => "?").join(",")})
    and ${identity ? "trim(workspace_id) = ?" : `nullif(trim(workspace_id), '') is null and lcode_history_path_key(${path}) = ?`}
    order by time_updated desc, id desc limit ?`)
    .all(...TASK_TYPES, key, HISTORY_DISCOVERY_SESSION_LIMIT + 1) as unknown as SessionRow[];
  return rows.map(decodeSessionRow);
}

function score(text: string, terms: readonly string[]): number {
  const normalized = text.normalize("NFKC").toLowerCase();
  return terms.reduce((sum, term) => sum + Number(normalized.includes(term)), 0);
}

function readBoundary(
  db: DatabaseSync,
  sessionID: string,
  anchorID?: string,
): MessageId | undefined {
  const latest = () =>
    (
      db
        .prepare(`select id from message where session_id = ?
    order by sequence is null desc, sequence desc, time_created desc, rowid desc limit 1`)
        .get(sessionID) as { id: MessageId } | undefined
    )?.id;
  if (!anchorID) return latest();
  const anchor = db
    .prepare(
      "select sequence, time_created, rowid as storage_rowid from message where session_id = ? and id = ?",
    )
    .get(sessionID, anchorID) as
    | { sequence: number | null; time_created: number; storage_rowid: number }
    | undefined;
  if (!anchor) return undefined;
  const following = db
    .prepare(`select id from message where session_id = ?
    and (sequence is null, coalesce(sequence, 0), time_created, rowid) > (?, ?, ?, ?)
    order by sequence is null, sequence, time_created, rowid limit ?`)
    .all(
      sessionID,
      Number(anchor.sequence === null),
      anchor.sequence ?? 0,
      anchor.time_created,
      anchor.storage_rowid,
      FOLLOWING_MESSAGES,
    ) as { id: MessageId }[];
  return following.at(-1)?.id ?? (anchorID as MessageId);
}
