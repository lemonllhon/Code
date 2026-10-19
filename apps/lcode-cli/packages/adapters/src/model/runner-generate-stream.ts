import { streamText } from "ai";
import type { generateText } from "ai";

/** 最终结果接口不要求 HTTP 非流式；统一收集 SSE，兼容只支持流式的模型且不重放 POST。 */
export async function generateTextFromStream(
  options: Parameters<typeof generateText>[0],
): Promise<Awaited<ReturnType<typeof generateText>>> {
  // 由原 Runner 记录安全错误事实，避免 SDK 默认 onError 将原始错误额外打印到 stderr。
  const result = streamText({ ...options, onError: () => {} });
  // SDK 的聚合字段不会单独消费流；错误块也不能被当成有文字的成功结果。
  for await (const part of result.fullStream) {
    if (part.type === "error") throw part.error;
    if (part.type === "abort") {
      options.abortSignal?.throwIfAborted();
      throw new Error("Model generation was cancelled.");
    }
  }
  options.abortSignal?.throwIfAborted();
  const steps = await result.steps;
  const last = steps.at(-1);
  if (!last) throw new Error("Model stream completed without a result.");
  if (last.finishReason === "other" || last.finishReason === "error")
    throw new Error("Model stream completed without a finish reason.");
  const totalUsage = await result.totalUsage;
  const output = options.output ? await result.output : undefined;
  // StepResult 多个字段是 getter，不能用展开运算符丢掉 text、reasoning 或工具结果。
  return {
    content: last.content,
    text: last.text,
    reasoning: last.reasoning,
    reasoningText: last.reasoningText,
    files: last.files,
    sources: last.sources,
    toolCalls: last.toolCalls,
    staticToolCalls: last.staticToolCalls,
    dynamicToolCalls: last.dynamicToolCalls,
    toolResults: last.toolResults,
    staticToolResults: last.staticToolResults,
    dynamicToolResults: last.dynamicToolResults,
    finishReason: last.finishReason,
    rawFinishReason: last.rawFinishReason,
    usage: last.usage,
    totalUsage,
    warnings: last.warnings,
    request: last.request,
    response: last.response,
    providerMetadata: last.providerMetadata,
    steps,
    output,
    experimental_output: output,
  };
}
