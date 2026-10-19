import { createHash } from "node:crypto";
import {
  MEMORY_LEARNING_REQUEST_MS,
  MemoryReviewEvidencePageSchema,
  type MemoryEvidenceCursor,
  type SessionId,
} from "@lcode/contracts";
import type { ToolExecutionContext } from "../tool/types.js";
import type { AutomaticMemoryReviewResult } from "./automatic-review.js";
import {
  assertReviewCapabilities,
  MemoryReviewError,
  reviewIO,
  throwIfReviewAborted,
} from "./review-common.js";
import { memoryReviewProfile } from "./review-profile.js";
import { validateReviewSessionScope } from "./review-session-evidence.js";

/** 每页沿用原 claim/CAS；重启后重放消费键即可恢复，不保存第二份会话正文。 */
export async function runAutomaticReviewSegments(
  context: ToolExecutionContext,
  run: (context: ToolExecutionContext) => Promise<AutomaticMemoryReviewResult>,
): Promise<AutomaticMemoryReviewResult> {
  assertReviewCapabilities(context);
  await validateReviewSessionScope(context);
  const read = context.sessionStore!.readMemoryReviewEvidence!.bind(context.sessionStore);
  const maxCharacters = memoryReviewProfile(context).sessionCharacterLimit;
  let startMessageID = context.reviewBoundary!.startMessageId;
  let cursor: MemoryEvidenceCursor | undefined;
  let previous: { cursor?: MemoryEvidenceCursor } | undefined;
  let firstSelection: string | undefined;
  const coverage = createHash("sha256");
  let segments = 0;
  const total: AutomaticMemoryReviewResult = {
    status: "no-change",
    appliedCount: 0,
    rejectedCount: 0,
    conflictCount: 0,
  };
  do {
    throwIfReviewAborted(context);
    const page = MemoryReviewEvidencePageSchema.parse(
      await reviewIO(context, () =>
        read({
          sessionID: context.sessionId as SessionId,
          startMessageID,
          throughMessageID: context.reviewBoundary!.messageId,
          turnId: context.turnId,
          cursor,
          maxCharacters,
          signal: context.abortSignal,
          memoryScope: { rootDir: context.memoryRoot!, workingDirectory: context.workingDirectory },
        }),
      ),
    );
    if (
      page.status !== "ready" &&
      (page.reason === "no-user-prose" ||
        page.reason === "foreground-review" ||
        page.reason === "direct-memory-write")
    )
      return { ...total, status: "skipped", policyReason: page.reason };
    if (page.status !== "ready")
      throw new MemoryReviewError("source_unavailable", "admission", page.reason);
    startMessageID ??= page.startMessageID;
    firstSelection ??= page.selection;
    if (page.selection !== firstSelection) throw new MemoryReviewError("stale_source");
    coverage.update(JSON.stringify([page.selection, page.content, page.nextCursor]));
    if (page.content) {
      segments++;
      // 超时属于单段工作，长轮次不会因累计时长而被当成内容超限。
      const result = await run({
        ...context,
        abortSignal: AbortSignal.any([
          context.abortSignal,
          AbortSignal.timeout(MEMORY_LEARNING_REQUEST_MS),
        ]),
        reviewSegment: { startMessageID, cursor, previous, maxCharacters, turnId: context.turnId },
      });
      total.appliedCount += result.appliedCount;
      total.rejectedCount += result.rejectedCount;
      total.conflictCount += result.conflictCount;
      total.evidenceSegmentCount = segments;
      total.modelRequestCount = (total.modelRequestCount ?? 0) + (result.modelRequestCount ?? 0);
      if (
        result.conflictCount ||
        (result.skippedReason && result.skippedReason !== "already-consumed")
      )
        return { ...total, skippedReason: result.skippedReason };
    }
    if (page.content) previous = { cursor };
    cursor = page.nextCursor;
  } while (cursor);
  if (!segments) throw new MemoryReviewError("source_unavailable", "admission", "no-user-prose");
  // 已提交页也要参与整轮收口证明；读取时变化不能把整轮标记为完成。
  context.observeMemoryReviewPhase?.("finish");
  const checked = createHash("sha256");
  do {
    const page = MemoryReviewEvidencePageSchema.parse(
      await reviewIO(context, () =>
        read({
          sessionID: context.sessionId as SessionId,
          startMessageID,
          throughMessageID: context.reviewBoundary!.messageId,
          turnId: context.turnId,
          cursor,
          maxCharacters,
          signal: context.abortSignal,
          memoryScope: { rootDir: context.memoryRoot!, workingDirectory: context.workingDirectory },
        }),
      ),
    );
    if (page.status !== "ready") throw new MemoryReviewError("stale_source");
    checked.update(JSON.stringify([page.selection, page.content, page.nextCursor]));
    cursor = page.nextCursor;
  } while (cursor);
  if (coverage.digest("hex") !== checked.digest("hex")) throw new MemoryReviewError("stale_source");
  total.status = total.appliedCount ? "completed" : "no-change";
  return total;
}
