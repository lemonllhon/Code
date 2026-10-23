import { runWithModelInvocationContext, traceContextToLogContext } from "../deps.js";
import type { Model, SessionEvent, TraceContext } from "../deps.js";
import { buildRuntimeProviderRequestMessages } from "../helpers/index.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { createRefreshRuntimeHeadersBeforeModelAttempt } from "./model-runtime-headers.js";
import { resolveModelRequestSessionTypeFromTaskType } from "./model-request-session-type.js";

/** The verifier caller owns lifecycle and evidence; this helper executes its frozen model request. */
export async function generateTargetCompletionVerificationText(
  this: AgentRuntimeInternal,
  input: {
    abortSignal?: AbortSignal;
    events: SessionEvent[];
    messages: ReturnType<typeof buildRuntimeProviderRequestMessages>["messages"];
    model: Model;
    traceContext: TraceContext;
  },
) {
  const invocationContext = {
    metadata: traceContextToLogContext(input.traceContext),
    modelRequestSessionType: resolveModelRequestSessionTypeFromTaskType(this.config.taskType),
    modelCall: {
      operation: "goal_completion_verification" as const,
    },
    statusSink: this.createModelStatusSink(input.traceContext, input.events),
    traceContext: input.traceContext,
    refreshRuntimeHeadersBeforeAttempt: createRefreshRuntimeHeadersBeforeModelAttempt(this, {
      abortSignal: input.abortSignal,
      model: input.model,
      traceContext: input.traceContext,
    }),
  };
  return await runWithModelInvocationContext(invocationContext, () =>
    input.model.generateText({
      abortSignal: input.abortSignal,
      messages: input.messages,
      // Verifier 继承已绑定的思考配置，不能套用低成本辅助调用的降档和封顶策略。
      options: { maxOutputTokens: input.model.optionSpecs.maxOutputTokens.max },
      tools: [],
    }),
  );
}
