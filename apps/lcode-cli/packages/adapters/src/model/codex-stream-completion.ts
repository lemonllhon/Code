import { wrapLanguageModel } from "ai";
import {
  getCurrentModelInvocationContext,
  traceContextToLogContext,
  type Logger,
} from "@lcode/contracts";

type SdkModel = Parameters<typeof wrapLanguageModel>[0]["model"];
type StreamPart =
  Awaited<ReturnType<SdkModel["doStream"]>>["stream"] extends ReadableStream<infer Part>
    ? Part
    : never;

/** 临时投影只属于单次 doStream；不缓存正文，也不改变原 SDK 的错误、usage 和工具调用。 */
export function withCodexStreamCompletion(model: SdkModel, logger?: Logger): SdkModel {
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: "v3",
      async wrapStream({ params, model: source }) {
        const trace = getCurrentModelInvocationContext()?.traceContext;
        const started = new Set<string>();
        const ended = new Set<string>();
        const hasText = new Set<string>();
        const counts = {
          textDelta: 0,
          messageDone: 0,
          completed: 0,
          incomplete: 0,
          failed: 0,
          other: 0,
        };
        let textChars = 0,
          toolCalls = 0,
          errorCount = 0;
        const result = await source.doStream({ ...params, includeRawChunks: true });
        return {
          ...result,
          stream: result.stream.pipeThrough(
            new TransformStream<StreamPart, StreamPart>({
              transform(chunk, controller) {
                const emit = (part: StreamPart) => {
                  if (part.type === "text-start") started.add(part.id);
                  if (part.type === "text-end") ended.add(part.id);
                  if (part.type === "text-delta" && part.delta.length) {
                    hasText.add(part.id);
                    textChars += part.delta.length;
                  }
                  controller.enqueue(part);
                };
                if (chunk.type === "raw") {
                  if (params.includeRawChunks) emit(chunk);
                  const frame = record(chunk.rawValue);
                  switch (frame.type) {
                    case "response.output_text.delta":
                      counts.textDelta++;
                      break;
                    case "response.output_item.done": {
                      counts.messageDone++;
                      const item = record(frame.item);
                      completeMessage(item, false, emit);
                      break;
                    }
                    case "response.completed":
                    case "response.incomplete": {
                      counts[frame.type === "response.completed" ? "completed" : "incomplete"]++;
                      const output = record(frame.response).output;
                      if (Array.isArray(output))
                        for (const item of output) completeMessage(record(item), true, emit);
                      break;
                    }
                    case "response.failed":
                      counts.failed++;
                      break;
                    default:
                      counts.other++;
                      break;
                  }
                  return;
                }
                if (chunk.type === "tool-call") toolCalls++;
                if (chunk.type === "error") errorCount++;
                emit(chunk);

                function completeMessage(
                  item: Record<string, unknown>,
                  close: boolean,
                  emitPart: typeof emit,
                ) {
                  const id = item.id;
                  if (
                    item.type !== "message" ||
                    item.role !== "assistant" ||
                    typeof id !== "string" ||
                    ended.has(id) ||
                    hasText.has(id) ||
                    !Array.isArray(item.content)
                  )
                    return;
                  const text = item.content
                    .map(record)
                    .filter((part) => part.type === "output_text" && typeof part.text === "string")
                    .map((part) => part.text as string)
                    .join("");
                  if (!text) return;
                  const providerMetadata = {
                    openai: {
                      itemId: id,
                      ...(item.phase === "commentary" || item.phase === "final_answer"
                        ? { phase: item.phase }
                        : {}),
                    },
                  };
                  // Bug 原因：SDK 的最终 message 分支只发 text-end，忽略无 delta 的完整正文。
                  // 只补该消息从未收到的文本，不拼接已流出的内容、不重放工具副作用。
                  if (!started.has(id)) emitPart({ type: "text-start", id, providerMetadata });
                  emitPart({ type: "text-delta", id, delta: text, providerMetadata });
                  if (close) emitPart({ type: "text-end", id, providerMetadata });
                }
              },
              flush() {
                if (!textChars && !toolCalls)
                  logger?.warn("Codex stream completed without visible output", {
                    ...(trace ? traceContextToLogContext(trace) : {}),
                    event: "model.codex.stream.no_output",
                    counts,
                    textChars,
                    toolCalls,
                    errorCount,
                  });
              },
            }),
          ),
        };
      },
    },
  });
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
