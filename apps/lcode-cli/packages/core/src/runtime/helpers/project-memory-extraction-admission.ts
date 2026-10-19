import type { AgentRuntimeInternal } from "../internal.js";
import { resolveEnabledProjectMemoryRoot } from "./project-memory.js";

/** 调度和显式恢复共用准入，禁用/远程任务不能先初始化记忆目录再被拒绝。 */
export function memoryExtractionAdmission(
  runtime: AgentRuntimeInternal,
): { root: string; reason?: never } | { root?: never; reason: string } {
  if (runtime.shuttingDown) return { reason: "cancelled" };
  if (runtime.config.memory?.extractionEnabled === false) return { reason: "disabled" };
  const root = resolveEnabledProjectMemoryRoot(runtime.config, runtime.workspaceRoot);
  if (!root) return { reason: "disabled" };
  if (runtime.isRemoteWorkspace()) return { reason: "remote-disabled" };
  if (
    !(
      runtime.sessionStore?.readMemoryReviewEvidence || runtime.sessionStore?.readTranscriptWindow
    ) ||
    !runtime.fileSystemPort?.projectMemory
  )
    return { reason: "missing-capability" };
  return { root };
}
