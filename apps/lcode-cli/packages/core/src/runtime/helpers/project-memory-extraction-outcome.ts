import type { TraceContext } from "@lcode/contracts";
import type { AgentRuntimeInternal } from "../internal.js";
import { traceContextToLogContext } from "../deps.js";

export function logMemoryExtractionSkipped(
  runtime: AgentRuntimeInternal,
  trace: TraceContext,
  reason: string,
  boundaryMessageId?: string,
): void {
  runtime.logger?.info("Project memory extraction skipped", {
    ...traceContextToLogContext(trace),
    event: "memory.extraction.skipped",
    module: "core.runtime",
    phase: "admission",
    modelRequestCount: 0,
    reason,
    boundaryMessageId,
  });
}
