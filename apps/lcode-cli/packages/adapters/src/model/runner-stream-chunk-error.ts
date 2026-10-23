import { ModelRetryReason } from "@lcode/contracts";
import { classifyModelFailure, type ClassifiedModelFailure } from "./failure-classifier.js";
import { getResponseHeaders, unwrapRetryError } from "./failure-inspection.js";
import { retryBudgetMaxAttempts } from "./retry-budget.js";
import { shouldReportRoutingFailure } from "./routing-feedback.js";
import { createDeferredRetryYieldGate } from "./runner-failover-yield.js";
import { sanitizeModelNetworkHeaders } from "./runner-network-headers.js";
import {
  calculateRetryDelay,
  logRetryDelayDecision,
  sleep,
  TerminalStreamChunkError,
  toAdapterError,
} from "./runner-retry.js";
import { publishModelStatus } from "./runner-status.js";
import { modelFailureStatusFields } from "./runner-telemetry.js";

import { canRotateApiKey } from "./api-key-retry.js";
import { publishRetryScheduledStatus, statusPublishOptions } from "./runner-attempt-status.js";
import { streamChunkResult } from "./runner-stream-boundary.js";
import type { StreamChunkInput, StreamChunkResult } from "./runner-stream-chunk-state.js";
import { resolveStreamFailureDecision } from "./runner-stream-failure-policy.js";

export async function handleStreamErrorEvent(
  input: StreamChunkInput,
  error: unknown,
): Promise<StreamChunkResult> {
  const retryWithRepairedHistory =
    !input.emittedRetryBoundaryEvent && input.repairThinkingSignatureRejection(error);
  const statusContext = retryWithRepairedHistory
    ? {
        ...input.statusContext,
        maxAttempts: retryBudgetMaxAttempts(
          input.input.request.modelRetryBudget,
          input.input.retry.maxAttempts + 1,
        ),
      }
    : input.statusContext;
  const classified = classifyModelFailure(error, input.input.request.abortSignal);
  input.apiKeyAttempt?.observeFailure(
    classified.statusCode,
    getResponseHeaders(unwrapRetryError(error)),
    input.emittedRetryBoundaryEvent,
    input.input.request.abortSignal?.aborted,
  );
  if (shouldReportRoutingFailure(classified.routing, input.emittedRetryBoundaryEvent))
    await input.input.resolved.observeRoutingFailure?.(
      classified.statusCode,
      getResponseHeaders(unwrapRetryError(error)),
      input.emittedRetryBoundaryEvent,
      input.input.request.abortSignal?.aborted,
    );
  const failure: ClassifiedModelFailure = classified;
  const responseHeaders = sanitizeModelNetworkHeaders(getResponseHeaders(unwrapRetryError(error)));
  const failureDecision = resolveStreamFailureDecision({
    attempt: input.retryBudgetAttempt,
    emittedRetryBoundaryEvent: input.emittedRetryBoundaryEvent,
    error,
    failure,
    maxAttempts: input.input.retry.maxAttempts,
    preserveProviderStreamBoundaries: input.input.request.preserveProviderStreamBoundaries,
    responseHeaders,
    retryBudget: input.input.request.modelRetryBudget,
    streamErrorChunkObserved: true,
  });
  const rotateApiKey = canRotateApiKey({
    apiKeyAttempt: input.apiKeyAttempt,
    error,
    signal: input.input.request.abortSignal,
    outputCommitted: input.emittedRetryBoundaryEvent,
    retryBudget: input.input.request.modelRetryBudget,
    attempt: input.retryBudgetAttempt,
    maxAttempts: input.input.retry.maxAttempts,
  });
  if (rotateApiKey) failureDecision.canRetry = true;
  if (retryWithRepairedHistory) {
    failureDecision.canRetry = true;
  }
  await publishModelStatus(
    {
      ...statusContext,
      attempt: input.attempt,
      durationMs: Date.now() - input.startedAt,
      message: failure.message,
      reason: failure.reason,
      requestHeaderCount: input.requestHeaderCount,
      requestHeaders: input.requestHeaders,
      responseHeaderCount: Object.keys(responseHeaders).length,
      responseHeaders,
      retryable: failureDecision.canRetry,
      statusCode: failure.statusCode,
      streamOutputCommitted: input.emittedRetryBoundaryEvent,
      ...modelFailureStatusFields(error, failure, "stream"),
      timestamp: new Date().toISOString(),
      type: "model_request_failed",
    },
    {
      ...statusPublishOptions(input.input, input.admission),
      failureError: unwrapRetryError(error),
    },
  );

  if (retryWithRepairedHistory) {
    await publishRetryScheduledStatus(
      input.input,
      statusContext,
      input.attempt,
      0,
      {
        ...failure,
        retryReason: ModelRetryReason.ReasoningSignatureRepair,
      },
      input.requestHeaders,
      responseHeaders,
      input.admission,
    );
    return streamChunkResult({
      emittedError: true,
      retryScheduled: true,
    });
  }

  if (!failureDecision.canRetry) {
    logRetryDelayDecision({
      attempt: input.attempt,
      canRetry: false,
      failure,
      logger: input.input.logger,
      responseHeaders,
      statusContext,
    });
    return streamChunkResult({
      emittedError: true,
      terminalError: new TerminalStreamChunkError(
        toAdapterError(error, failure, statusContext, input.attempt, {
          ...failureDecision.context,
          errorPhase: "stream",
        }),
      ),
    });
  }

  const delayMs = rotateApiKey
    ? 0
    : calculateRetryDelay(input.input.retry, input.retryBudgetAttempt, failure.retryAfterMs);
  logRetryDelayDecision({
    attempt: input.attempt,
    canRetry: failureDecision.canRetry,
    delayMs,
    failure,
    logger: input.input.logger,
    responseHeaders,
    statusContext,
  });

  await publishRetryScheduledStatus(
    input.input,
    statusContext,
    input.attempt,
    delayMs,
    failure,
    input.requestHeaders,
    responseHeaders,
    input.admission,
  );
  // error chunk 仍持有 AI SDK iterator；退避和 policy gate 前必须先关闭旧 attempt。
  await input.beforeRetryYieldEvaluation();
  // Note: AI SDK can surface pre-output APICallError as an error chunk;
  // retry it here so protocol clients still receive the normal apiRetry status updates.
  try {
    await sleep(delayMs, input.input.request.abortSignal);
  } catch (sleepError) {
    const sleepFailure = classifyModelFailure(sleepError, input.input.request.abortSignal);
    // SSE error chunk 在 helper 内等待 retry；取消发生时 iterator 仍存在，
    // 外层仅按 iterator 判断会误记为 stream。先在真实等待边界写入 connect 事实。
    throw toAdapterError(sleepError, sleepFailure, statusContext, input.attempt, {
      errorPhase: "connect",
    });
  }
  const finalRetryYieldGate = createDeferredRetryYieldGate(
    {
      attempt: input.attempt,
      canRetry: failureDecision.canRetry,
      consumedRetryAttempts: input.retryBudgetAttempt,
      failure,
      logger: input.input.logger,
      request: input.input.request,
      resolved: input.input.resolved,
    },
    toAdapterError(error, failure, statusContext, input.attempt, {
      ...failureDecision.context,
      errorPhase: "stream",
      retryYieldedToFailover: true,
    }),
  );
  if (await finalRetryYieldGate.shouldYield()) {
    return streamChunkResult({
      emittedError: true,
      terminalError: new TerminalStreamChunkError(finalRetryYieldGate.adapterError),
    });
  }
  return streamChunkResult({
    deferredRetryYield: finalRetryYieldGate,
    emittedError: true,
    retryScheduled: true,
  });
}
