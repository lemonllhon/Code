import type { ConversationSnapshot } from "@lcode/shared/lcode-protocol-v4";

/** 只消费权威完成/来源字段，不从回答文字或 canStop 单字段猜测完成。 */
export function composerPredictionBoundary(snapshot: ConversationSnapshot | null): string | null {
  if (
    !snapshot ||
    snapshot.control.phase !== "completedSuccess" ||
    snapshot.control.canStop ||
    snapshot.queue.items.length ||
    snapshot.pendingCommands.length ||
    snapshot.pendingInteractions.length ||
    snapshot.goal ||
    snapshot.backgroundWorks.some(
      (work) => work.status === "running" || work.status === "resultPending",
    ) ||
    snapshot.subagents?.running.length ||
    snapshot.workflowRuns?.runs.some((run) => run.status === "pending" || run.status === "running")
  )
    return null;
  const rows = snapshot.rows.window;
  const header = rows.findLast((row) => row.kind === "turnHeader");
  if (
    header?.kind !== "turnHeader" ||
    header.origin !== "userInput" ||
    header.executionKind !== "agent" ||
    header.state !== "completedSuccess"
  )
    return null;
  const assistant = rows.findLast(
    (row) => row.kind === "assistantText" && row.turnId === header.turnId,
  );
  return assistant?.kind === "assistantText" && assistant.state === "complete"
    ? (assistant.entityId ?? null)
    : null;
}
