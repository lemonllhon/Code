import { createPartId, traceContextToLogContext } from "../deps.js";
import type { MessageId, MessagePart, ModelReasoningContentBlock, TraceContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { hasAssistantReasoningContent } from "./turn-output-token-continuation.js";

/** 成功与取消共用；真实思考块保留，消除逐片自动提交造成的收尾阻塞。 */
export async function persistAssistantContent(
  runtime: AgentRuntimeInternal,
  input: {
    assistantMessageId: MessageId;
    createdAt: number;
    reasoning?: readonly ModelReasoningContentBlock[];
    text: string;
    traceContext: TraceContext;
  },
): Promise<void> {
  if (!runtime.sessionStore) return;
  const startedAt = Date.now();
  const parts: MessagePart[] = [];
  const common = {
    sessionID: runtime.sessionId,
    messageID: input.assistantMessageId,
    time: { start: input.createdAt, end: startedAt },
  };
  for (const reasoning of input.reasoning ?? []) {
    if (!hasAssistantReasoningContent(reasoning)) continue;
    parts.push({
      ...common,
      id: createPartId(),
      type: "reasoning",
      text: reasoning.text,
      metadata: reasoning.providerOptions,
    });
  }
  if (input.text) parts.push({ ...common, id: createPartId(), type: "text", text: input.text });
  if (parts.length === 0) return;
  await runtime.sessionStore.saveParts({
    sessionID: runtime.sessionId,
    messageID: input.assistantMessageId,
    parts,
  });
  runtime.logger?.info("Assistant content committed", {
    ...traceContextToLogContext(input.traceContext),
    event: "assistant.parts.committed",
    module: "core.runtime",
    status: "completed",
    durationMs: Date.now() - startedAt,
    partCount: parts.length,
  });
}
