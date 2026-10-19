import {
  MEMORY_LEARNING_REQUEST_MS,
  type MessageId,
  SESSION_TRANSCRIPT_SNAPSHOT_MAX_DATA_BYTES,
  SESSION_TRANSCRIPT_SNAPSHOT_MAX_MESSAGE_ROWS,
  SESSION_TRANSCRIPT_SNAPSHOT_MAX_PART_ROWS,
} from "@lcode/contracts";
import { traceContextToLogContext, type TraceContext } from "../deps.js";
import { projectSessionHistorySearchText } from "../../session-context/session-history-search.js";
import { canReadSessionContextFromWorkspace } from "../../session-context/workspace-session-scope.js";
import {
  createMemoryExtractionScheduler,
  messagesAfterLastMemoryReviewTurn,
  type MemoryExtractionScheduler,
  type MemoryExtractionSnapshot,
} from "../../memory/extraction.js";
import { runAutomaticMemoryReview } from "../../memory/automatic-review.js";
import { MemoryReviewError } from "../../memory/review-common.js";
import { activeReviewWindowMessages } from "../../memory/review-session-window.js";
import type { AgentRuntimeInternal } from "../internal.js";
import {
  captureProjectMemoryReviewContext,
  type ProjectMemoryAgentContext,
} from "./project-memory-agent.js";
import { resolveEnabledProjectMemoryRoot } from "./project-memory.js";
import { logMemoryExtractionSkipped } from "./project-memory-extraction-outcome.js";
import { withModelInvocationContext } from "../methods/runtime-model.js";
import { memoryExtractionAdmission } from "./project-memory-extraction-admission.js";

const EXTRACTION_DRAIN_TIMEOUT_MS = 60_000;
const REAL_USER_PROBE_CHARACTER_LIMIT = 1;
const AUTOMATIC_REVIEW_QUERY =
  "Review the completed user turn for durable project facts and corrections; save only independently verified, reusable changes.";

interface ProjectMemoryExtractionSnapshot
  extends MemoryExtractionSnapshot, ReturnType<typeof captureProjectMemoryReviewContext> {
  sessionId: AgentRuntimeInternal["sessionId"];
  workspaceIdentity?: string;
  startMessageId?: string;
}

export type ProjectMemoryExtractionScheduler =
  MemoryExtractionScheduler<ProjectMemoryExtractionSnapshot>;

export function isProjectMemoryEnabled(this: AgentRuntimeInternal): boolean {
  return resolveEnabledProjectMemoryRoot(this.config, this.workspaceRoot) !== undefined;
}

export function scheduleProjectMemoryExtraction(
  runtime: AgentRuntimeInternal,
  input: {
    model?: ProjectMemoryAgentContext["model"];
    traceContext: TraceContext;
    startMessageId?: MessageId;
    boundaryMessageId?: MessageId;
  },
): void {
  const skip = (reason: string) =>
    logMemoryExtractionSkipped(
      runtime,
      input.traceContext,
      reason,
      input.boundaryMessageId ?? runtime.latestConversationMessageId,
    );
  const admission = memoryExtractionAdmission(runtime);
  if (admission.root === undefined) {
    skip(admission.reason);
    return;
  }
  const memoryRoot = admission.root;

  const snapshotBase = {
    ...captureProjectMemoryReviewContext(runtime, {
      memoryRoot,
      model: input.model,
      operation: "project_memory_extract",
      traceContext: input.traceContext,
    }),
    sessionId: runtime.sessionId,
    workspaceIdentity: runtime.config.memory?.workspaceIdentity,
    startMessageId: input.startMessageId,
  };
  const snapshotBoundaryMessageId = input.boundaryMessageId ?? runtime.latestConversationMessageId;
  if (!snapshotBoundaryMessageId) {
    skip("missing-boundary");
    return;
  }
  // 全量 messages 再切片既无 IO 预算，也会把 getSession 与历史读成两代；窗口连同元数据原子读取。
  const snapshot = async (): Promise<ProjectMemoryExtractionSnapshot> => {
    if (runtime.sessionStore?.readMemoryReviewEvidence)
      return {
        ...snapshotBase,
        boundaryMessageId: snapshotBoundaryMessageId,
        durableMessages: [],
        evidenceOnly: true,
      };
    return runtime.sessionStore!.readTranscriptWindow!({
      sessionID: snapshotBase.sessionId,
      throughMessageID: snapshotBoundaryMessageId,
      limits: {
        maxMessageRows: SESSION_TRANSCRIPT_SNAPSHOT_MAX_MESSAGE_ROWS,
        maxPartRows: SESSION_TRANSCRIPT_SNAPSHOT_MAX_PART_ROWS,
        maxDataBytes: SESSION_TRANSCRIPT_SNAPSHOT_MAX_DATA_BYTES,
      },
    })
      .then((window): ProjectMemoryExtractionSnapshot => {
        const scheduledSession = window.session;
        if (
          !window.boundaryFound ||
          window.throughMessageID !== snapshotBoundaryMessageId ||
          window.truncated ||
          !scheduledSession ||
          scheduledSession.id !== snapshotBase.sessionId ||
          !canReadSessionContextFromWorkspace(scheduledSession, snapshotBase)
        ) {
          throw new Error("Extraction completed window is unavailable");
        }
        // scheduler与审核重读必须共用可信窗口分支规则，避免一处接纳、一处拒绝。
        const activeMessages = activeReviewWindowMessages(
          window,
          scheduledSession,
          snapshotBoundaryMessageId,
        );
        if (!activeMessages) throw new Error("Extraction active branch is unavailable");
        const boundaryIndex = activeMessages.findIndex(
          (message) => message.info.id === snapshotBoundaryMessageId,
        );
        if (boundaryIndex < 0) {
          throw new Error("Extraction boundary is missing from the scheduled active branch");
        }
        const durableMessages = messagesAfterLastMemoryReviewTurn(
          activeMessages.slice(0, boundaryIndex + 1),
        );
        const realUserText = projectSessionHistorySearchText({
          messages: durableMessages.filter((message) => message.info.role === "user"),
          session: { ...scheduledSession, revert: undefined },
          characterLimit: REAL_USER_PROBE_CHARACTER_LIMIT,
        });
        // prefixTruncated 可省略旧轮，但窗口内没有真实用户边界时不能把孤立 assistant 当本轮证据。
        if (!realUserText.searchText)
          throw new Error("Extraction window has no real user boundary");
        return { ...snapshotBase, boundaryMessageId: snapshotBoundaryMessageId, durableMessages };
      })
      .catch((error: unknown) => {
        // 快照获取失败原本被scheduler静默吸收；只记录稳定原因，不输出历史或路径。
        runtime.logger?.warn("Project memory extraction window unavailable", {
          ...traceContextToLogContext(input.traceContext),
          event: "memory.extraction.window_unavailable",
          module: "core.runtime",
        });
        throw error;
      });
  };

  runtime.memoryExtractionScheduler ??= createMemoryExtractionScheduler(
    (extraction) => executeProjectMemoryExtraction(runtime, extraction),
    {
      onOverflow: (boundaryMessageId) =>
        runtime.logger?.warn("Project memory extraction backlog coalesced", {
          event: "memory.extraction.overflow",
          ...traceContextToLogContext(runtime.rootTraceContext),
          module: "core.runtime",
          sessionId: runtime.sessionId,
          boundaryMessageId,
          reason: "queue-overflow",
        }),
    },
  );
  runtime.memoryExtractionScheduler.schedule(
    runtime.sessionStore!.readMemoryReviewEvidence
      ? {
          ...snapshotBase,
          boundaryMessageId: snapshotBoundaryMessageId,
          durableMessages: [],
          evidenceOnly: true,
        }
      : snapshot,
  );
}

export async function drainMemoryExtractions(
  this: AgentRuntimeInternal,
  timeoutMs: number | null = EXTRACTION_DRAIN_TIMEOUT_MS,
): Promise<void> {
  const scheduler = this.memoryExtractionScheduler;
  if (!scheduler) return;
  // benchmark 显式等待自然结束；普通 session close 仍保留原有有界取消清理。
  if (timeoutMs === null) {
    await scheduler.drain();
    return;
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      scheduler.drain(),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function executeProjectMemoryExtraction(
  runtime: AgentRuntimeInternal,
  input: {
    abortSignal: AbortSignal;
    messageCount: number;
    snapshot: ProjectMemoryExtractionSnapshot;
  },
) {
  const startedAt = Date.now();
  let modelRequestCount = 0;
  let reviewPhase: "admission" | "generation" | "verification" | "commit" | "finish" = "admission";
  const model = withModelInvocationContext(input.snapshot.model, () => {
    modelRequestCount++;
    return {};
  });
  const abortSignal = runtime.sessionStore?.readMemoryReviewEvidence
    ? input.abortSignal
    : AbortSignal.any([input.abortSignal, AbortSignal.timeout(MEMORY_LEARNING_REQUEST_MS)]);
  const telemetry = runtime.agentTelemetry.detached({
    causation: input.snapshot.causation,
    executionKind: "background",
    operation: "project_memory_extract",
    targetKind: "project_memory",
    traceContext: input.snapshot.traceContext,
    trigger: "scheduler",
  });

  return telemetry.run(async () => {
    try {
      abortSignal.throwIfAborted();
      if (
        !runtime.fileSystemPort?.projectMemory ||
        !(
          runtime.sessionStore?.readMemoryReviewEvidence ||
          runtime.sessionStore?.readTranscriptWindow
        )
      ) {
        telemetry.finishCompleted();
        return "deferred" as const;
      }
      const snapshot = input.snapshot;
      // 两次辅助请求各自构造 tools=[] 的新证据上下文，不继承前景回答或执行任何模型工具。
      const result = await runAutomaticMemoryReview({
        query: AUTOMATIC_REVIEW_QUERY,
        context: {
          abortSignal,
          observeMemoryReviewPhase: (phase) => {
            reviewPhase = phase;
          },
          fileSystemPort: runtime.fileSystemPort,
          sessionStore: runtime.sessionStore,
          sessionId: snapshot.sessionId,
          toolCallId: `memory_extract_${snapshot.boundaryMessageId}`,
          traceContext: snapshot.traceContext,
          traceId: snapshot.traceContext.traceId,
          spanId: snapshot.traceContext.spanId,
          parentSpanId: snapshot.traceContext.parentSpanId,
          turnId: snapshot.traceContext.turnId,
          model,
          memoryRoot: snapshot.memoryRoot,
          workingDirectory: snapshot.workingDirectory,
          workspaceRoot: snapshot.workspaceRoot,
          workspaceIdentity: snapshot.workspaceIdentity,
          runtimeScope: "main",
          reviewMode: "incremental",
          selectMemoryCandidates: snapshot.selectMemoryCandidates,
          selectMemoryCandidateOffsets: snapshot.selectMemoryCandidateOffsets,
          reviewBoundary: {
            sessionId: snapshot.sessionId,
            messageId: snapshot.boundaryMessageId,
            startMessageId: snapshot.startMessageId,
          },
        },
      });
      abortSignal.throwIfAborted();
      // 冲突优先保留前景版本与 cursor；不在后台自动重试，仅后续新快照可以重新形成候选。
      runtime.logger?.info("Project memory extraction completed", {
        ...traceContextToLogContext(snapshot.traceContext),
        event:
          result.conflictCount > 0
            ? "memory.extraction.failed"
            : result.status === "skipped"
              ? "memory.extraction.skipped"
              : result.skippedReason && result.skippedReason !== "already-consumed"
                ? "memory.extraction.deferred"
                : "memory.extraction.completed",
        module: "core.runtime",
        appliedCount: result.appliedCount,
        rejectedCount: result.rejectedCount,
        conflictCount: result.conflictCount,
        evidenceSegmentCount: result.evidenceSegmentCount,
        modelRequestCount,
        durationMs: Date.now() - startedAt,
        skippedReason: result.skippedReason,
        policyReason: result.policyReason,
        phase: result.conflictCount > 0 ? "commit" : "finish",
      });
      if (result.conflictCount > 0) {
        telemetry.finishFailed(
          "execute",
          "internal",
          new Error(`Automatic memory review had ${result.conflictCount} commit conflicts`),
        );
        return "error" as const;
      }
      telemetry.finishCompleted();
      if (result.status === "skipped") return "skipped" as const;
      // 容量不足/其他 Runtime 持有租约并不代表证据已消费，不能把本地 cursor 提前推进。
      if (result.skippedReason && result.skippedReason !== "already-consumed")
        return "deferred" as const;
      return result.appliedCount > 0 ? ("success" as const) : ("no-op" as const);
    } catch (error) {
      const deadline =
        (error instanceof MemoryReviewError && error.code === "request_timeout") ||
        (abortSignal.reason instanceof Error && abortSignal.reason.name === "TimeoutError");
      if (!deadline && (abortSignal.aborted || isAbortError(error))) {
        telemetry.finishCancelled("abort_signal");
        runtime.logger?.info("Project memory extraction cancelled", {
          ...traceContextToLogContext(input.snapshot.traceContext),
          event: "memory.extraction.cancelled",
          module: "core.runtime",
          reason: "cancelled",
          phase: reviewPhase,
          modelRequestCount,
          durationMs: Date.now() - startedAt,
          boundaryMessageId: input.snapshot.boundaryMessageId,
        });
        return "aborted" as const;
      }
      // IO/供应商异常可能携带私有路径或原始响应；生产 trace 与服务日志都只保留稳定诊断字段。
      telemetry.finishFailed("execute", "internal", new Error("Project memory extraction failed"));
      runtime.logger?.warn("Project memory extraction failed", {
        ...traceContextToLogContext(input.snapshot.traceContext),
        event: "memory.extraction.failed",
        module: "core.runtime",
        code: deadline
          ? "request_timeout"
          : error instanceof MemoryReviewError
            ? error.code
            : "internal",
        phase: error instanceof MemoryReviewError ? (error.phase ?? reviewPhase) : reviewPhase,
        reason: error instanceof MemoryReviewError ? error.reason : undefined,
        modelRequestCount,
        durationMs: Date.now() - startedAt,
      });
      return "error" as const;
    }
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
