import { ModelErrorCode, ModelFailureReason, ModelRetryReason } from "@lcode/contracts";
import type { Logger, ModelStatusSink } from "@lcode/contracts";
import type { ClassifiedModelFailure } from "./failure-classifier.js";
import {
  calculateRetryDelay,
  logRetryDelayDecision,
  sleep,
  toAdapterError,
} from "./runner-retry.js";
import { publishModelStatus, type ModelStatusContext } from "./runner-status.js";
import type { ResolvedAiSdkModelRetryOptions } from "./retry-policy.js";
import { ModelProtocolError } from "@lcode/contracts";
import {
  createDeferredRetryYieldGate,
  RetryYieldBeforeInvocationError,
} from "./runner-failover-yield.js";
import type { AiSdkModelTextRequest, ResolvedAiSdkModel } from "./runner-runtime.js";
import type { ModelRunnerRetryState } from "./runner-request-state.js";

const EMPTY_COMPLETION_MAX_RETRIES = 1;
const EMPTY_COMPLETION_MESSAGE =
  "Model returned no text, no tool calls, and no usage before completing the turn.";

export function createEmptyCompletionFailure(): ClassifiedModelFailure {
  return {
    code: ModelErrorCode.InvalidModelResponse,
    message: EMPTY_COMPLETION_MESSAGE,
    // 物理重试按上游临时空响应处理；该结构化原因也允许 Core 在安全边界接管。
    reason: ModelFailureReason.ServerError,
    retryReason: ModelRetryReason.ServerError,
    retryable: true,
  };
}

export function exhaustedEmptyCompletionError(): ModelProtocolError {
  // 空响应只允许 adapter 重试一次；耗尽后必须终止，不能作为 length 成功交给 Core 续跑。
  return new ModelProtocolError(ModelErrorCode.InvalidModelResponse, EMPTY_COMPLETION_MESSAGE, {
    retryBudgetExhausted: true,
  });
}

export async function prepareEmptyCompletionRetry(
  input: Parameters<typeof scheduleEmptyCompletionRetry>[0] & {
    request: AiSdkModelTextRequest;
    resolved: ResolvedAiSdkModel;
    retryState: Pick<ModelRunnerRetryState, "pendingRetryYield">;
  },
): Promise<void> {
  // generate/stream 共用同一 backoff 与 failover 交接，物理票据由调用方在等待前释放。
  await scheduleEmptyCompletionRetry(input);
  const failure = createEmptyCompletionFailure();
  const gate = createDeferredRetryYieldGate(
    {
      attempt: input.attempt,
      canRetry: true,
      consumedRetryAttempts: input.retryBudgetAttempt,
      failure,
      logger: input.logger,
      request: input.request,
      resolved: input.resolved,
    },
    toAdapterError(new Error(failure.message), failure, input.statusContext, input.attempt, {
      errorPhase: input.errorPhase,
      retryYieldedToFailover: true,
    }),
  );
  if (await gate.shouldYield()) throw new RetryYieldBeforeInvocationError(gate.adapterError);
  input.retryState.pendingRetryYield = gate;
}

export function canRetryEmptyCompletion(input: {
  abortSignal?: AbortSignal;
  attempt: number;
  maxAttempts: number;
  retryCount: number;
}): boolean {
  return (
    !input.abortSignal?.aborted &&
    input.retryCount < EMPTY_COMPLETION_MAX_RETRIES &&
    input.attempt < input.maxAttempts
  );
}

export async function scheduleEmptyCompletionRetry(input: {
  abortSignal?: AbortSignal;
  attempt: number;
  completedAt: number;
  errorPhase: "response" | "stream";
  logger?: Logger;
  requestHeaders: Record<string, string>;
  requestStatusSink?: ModelStatusSink;
  responseHeaders: Record<string, string>;
  retry: ResolvedAiSdkModelRetryOptions;
  retryBudgetAttempt: number;
  startedAt: number;
  statusContext: ModelStatusContext;
  statusSink?: ModelStatusSink;
  streamOutputCommitted?: boolean;
}): Promise<void> {
  const failure = createEmptyCompletionFailure();
  await publishModelStatus(
    {
      ...input.statusContext,
      attempt: input.attempt,
      durationMs: input.completedAt - input.startedAt,
      errorCode: failure.code,
      errorPhase: input.errorPhase,
      message: failure.message,
      reason: failure.reason,
      requestHeaderCount: Object.keys(input.requestHeaders).length,
      requestHeaders: input.requestHeaders,
      responseHeaderCount: Object.keys(input.responseHeaders).length,
      responseHeaders: input.responseHeaders,
      retryable: true,
      ...(input.streamOutputCommitted !== undefined
        ? { streamOutputCommitted: input.streamOutputCommitted }
        : {}),
      timestamp: new Date(input.completedAt).toISOString(),
      type: "model_request_failed",
    },
    {
      logger: input.logger,
      requestStatusSink: input.requestStatusSink,
      statusSink: input.statusSink,
    },
  );

  const delayMs = calculateRetryDelay(input.retry, input.retryBudgetAttempt);
  logRetryDelayDecision({
    attempt: input.attempt,
    canRetry: true,
    delayMs,
    failure,
    logger: input.logger,
    responseHeaders: input.responseHeaders,
    statusContext: input.statusContext,
  });
  await publishModelStatus(
    {
      ...input.statusContext,
      attempt: input.attempt,
      delayMs,
      errorCode: failure.code,
      message: failure.message,
      nextAttempt: input.attempt + 1,
      reason: failure.retryReason,
      requestHeaderCount: Object.keys(input.requestHeaders).length,
      requestHeaders: input.requestHeaders,
      responseHeaderCount: Object.keys(input.responseHeaders).length,
      responseHeaders: input.responseHeaders,
      retryAfterMs: failure.retryAfterMs,
      timestamp: new Date().toISOString(),
      type: "model_retry_scheduled",
    },
    {
      logger: input.logger,
      requestStatusSink: input.requestStatusSink,
      statusSink: input.statusSink,
    },
  );
  await sleep(delayMs, input.abortSignal);
}
