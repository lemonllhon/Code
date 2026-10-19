import type { MemoryLearningLease } from "@lcode/contracts";
import type { ToolExecutionContext } from "../tool/types.js";
import type { AutomaticMemoryReviewResult } from "./automatic-review.js";
import { collectReviewSessionEvidence } from "./review-session-evidence.js";
import { reviewHash, throwIfReviewAborted } from "./review-common.js";
import { readValidatedMemoryReviewSources } from "./review-validation.js";

export type PreparedReviewSessions = Awaited<ReturnType<typeof collectReviewSessionEvidence>>;
export async function withAutomaticMemoryLearning(
  context: ToolExecutionContext,
  run: (
    sessions?: PreparedReviewSessions,
    lease?: MemoryLearningLease,
  ) => Promise<AutomaticMemoryReviewResult>,
): Promise<AutomaticMemoryReviewResult> {
  const learning = context.fileSystemPort?.projectMemory?.learning;
  if (context.reviewMode !== "incremental" || !learning || !context.memoryRoot) return run();
  const sessions = await collectReviewSessionEvidence(context);
  if (sessions.materials.length === 0) return run(sessions);
  const rootDir = context.memoryRoot;
  const options = { signal: context.abortSignal, trace: context.traceContext };
  const claimed = await learning.claim(
    {
      rootDir,
      workspaceKey: context.workspaceIdentity?.trim() || context.workspaceRoot,
      evidenceKey: reviewHash(sessions.materials.map((entry) => entry.source)),
    },
    options,
  );
  if (claimed.status !== "claimed")
    return {
      status: "no-change",
      appliedCount: 0,
      rejectedCount: 0,
      conflictCount: 0,
      skippedReason:
        claimed.status === "consumed"
          ? "already-consumed"
          : claimed.status === "busy"
            ? "learning-busy"
            : "learning-full",
    };
  let consumed = false;
  try {
    const result = await run(sessions, claimed.lease);
    throwIfReviewAborted(context);
    if (result.conflictCount === 0 && !result.skippedReason) {
      // 空提案也必须重读来源，不能把生成期间已被改写的证据误记为已处理。
      await readValidatedMemoryReviewSources({
        sources: sessions.materials.map((entry) => entry.source),
        context,
      });
      await learning.finish({ rootDir, lease: claimed.lease }, options);
      consumed = true;
    }
    return result;
  } finally {
    if (!consumed)
      await learning.release({ rootDir, lease: claimed.lease }, { trace: context.traceContext });
  }
}
