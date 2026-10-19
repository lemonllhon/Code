import type { MessageId, TraceContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { RuntimeModelStreamSnapshot } from "../types.js";
import { persistAssistantContent } from "./assistant-content-persistence.js";

export async function persistCancelledStreamSnapshot(
  runtime: AgentRuntimeInternal,
  options: {
    assistantCreatedAt: number;
    assistantMessageId: MessageId;
    snapshot: RuntimeModelStreamSnapshot;
    traceContext: TraceContext;
  },
): Promise<void> {
  // 用户 stop 时模型请求会以异常退出，成功路径里的最终 text/reasoning
  // 持久化不会执行；这里只 flush 已经到达本进程的 text/reasoning，工具仍等终态路径处理。
  // 取消只停止执行；已收到的内容仍原子收尾，不能逐片自动提交阻塞停止完成。
  await persistAssistantContent(runtime, {
    assistantMessageId: options.assistantMessageId,
    createdAt: options.assistantCreatedAt,
    reasoning: options.snapshot.reasoning,
    text: options.snapshot.text,
    traceContext: options.traceContext,
  });
}
