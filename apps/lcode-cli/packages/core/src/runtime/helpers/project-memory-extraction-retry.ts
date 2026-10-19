import {
  MemoryExtractionRetryInputSchema,
  type MemoryExtractionRetryInput,
  type MessageId,
  type TurnId,
} from "@lcode/contracts";
import type { AgentRuntimeInternal } from "../internal.js";
import { scheduleProjectMemoryExtraction } from "./project-memory-extraction.js";
import { memoryExtractionAdmission } from "./project-memory-extraction-admission.js";
import { logMemoryExtractionSkipped } from "./project-memory-extraction-outcome.js";

/** 只有显式调用才恢复指定边界；不在 cold resume 或失败路径隐式产生计费请求。 */
export async function retryMemoryExtraction(
  this: AgentRuntimeInternal,
  input: MemoryExtractionRetryInput,
): Promise<void> {
  const parsed = MemoryExtractionRetryInputSchema.parse(input);
  const traceContext = {
    ...this.rootTraceContext,
    sessionId: this.sessionId,
    turnId: parsed.turnId as TurnId,
  };
  const admission = memoryExtractionAdmission(this);
  if (admission.reason) {
    logMemoryExtractionSkipped(this, traceContext, admission.reason, parsed.boundaryMessageId);
    return;
  }
  await this.loadProjectMemoryRoot(traceContext);
  scheduleProjectMemoryExtraction(this, {
    startMessageId: parsed.startMessageId as MessageId,
    boundaryMessageId: parsed.boundaryMessageId as MessageId,
    traceContext,
  });
}
