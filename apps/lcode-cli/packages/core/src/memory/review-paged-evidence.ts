import {
  MemoryReviewEvidencePageSchema,
  type ProjectMemoryReviewSource,
  type SessionId,
} from "@lcode/contracts";
import type { ToolExecutionContext } from "../tool/types.js";
import { canReadSessionContextFromWorkspace } from "../session-context/workspace-session-scope.js";
import {
  createReviewSource,
  MemoryReviewError,
  reviewIO,
  type FrozenReviewSource,
} from "./review-common.js";

import { REVIEW_ADJACENT_CHARACTER_LIMIT } from "./review-profile.js";

export async function readPagedReviewEvidence(
  context: ToolExecutionContext,
  segment: NonNullable<ProjectMemoryReviewSource["segment"]>,
  boundaryMessageId: string,
): Promise<FrozenReviewSource> {
  const page = MemoryReviewEvidencePageSchema.parse(
    await reviewIO(context, () =>
      context.sessionStore!.readMemoryReviewEvidence!({
        sessionID: context.sessionId as SessionId,
        startMessageID: segment.startMessageID,
        throughMessageID: boundaryMessageId,
        turnId: segment.turnId,
        cursor: segment.cursor,
        maxCharacters: segment.maxCharacters,
        signal: context.abortSignal,
        memoryScope: { rootDir: context.memoryRoot!, workingDirectory: context.workingDirectory },
      }),
    ),
  );
  if (
    page.status !== "ready" ||
    !page.session ||
    page.session.id !== context.sessionId ||
    page.session.time.archived !== undefined ||
    !["interactive", "fork", "workflow_parent"].includes(page.session.taskType) ||
    (page.session.parentID && page.session.taskType !== "fork") ||
    !canReadSessionContextFromWorkspace(page.session, context) ||
    page.startMessageID !== segment.startMessageID ||
    page.throughMessageID !== boundaryMessageId
  )
    throw new MemoryReviewError("source_unavailable");
  let preceding: { selection: string; content: string; nextCursor: unknown } | undefined;
  if (segment.previous) {
    const prior = await readPagedReviewEvidence(
      context,
      { ...segment, cursor: segment.previous.cursor, previous: undefined },
      boundaryMessageId,
    );
    // 相邻原文也属于受控来源，重读与修订哈希必须覆盖，不能信任捕获时的一段自由文本。
    let tail = prior.content.slice(-REVIEW_ADJACENT_CHARACTER_LIMIT);
    if (/^[\uDC00-\uDFFF]/u.test(tail)) tail = tail.slice(1);
    preceding = { selection: prior.source.revision, content: tail, nextCursor: segment.cursor };
  }
  return {
    source: createReviewSource({
      context,
      kind: "session",
      reference: context.sessionId,
      characterLimit: segment.maxCharacters,
      boundaryMessageId,
      projection: "completed-turn-v2",
      segment,
      material: {
        selection: page.selection,
        content: page.content,
        nextCursor: page.nextCursor,
        preceding,
      },
    }),
    content: preceding
      ? `Adjacent preceding original text (context only):\n${preceding.content}\nCurrent evidence segment:\n${page.content}`
      : page.content,
    partial: Boolean(segment.cursor || page.nextCursor),
  };
}
