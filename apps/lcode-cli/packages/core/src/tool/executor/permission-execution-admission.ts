import type { ToolExecutionResult } from "../types.js";
import type { ToolExecutorDeps } from "./types.js";
import { permissionStateKey } from "./permission-mode-recheck.js";

export type ToolAuthorization =
  | { allowed: true; executionInput: unknown; permissionWaitMs?: number; permissionState: string }
  | { allowed: false; result: ToolExecutionResult };

/** 等待执行资源期间可能降权；释放资源后重判，不能占着执行槽等待用户确认。 */
export async function acquireAuthorizedToolResources(input: {
  deps: ToolExecutorDeps;
  initial: Extract<ToolAuthorization, { allowed: true }>;
  authorize: () => Promise<ToolAuthorization>;
  acquire: (executionInput: unknown) => Promise<() => void>;
  signal: AbortSignal;
}): Promise<
  | (Extract<ToolAuthorization, { allowed: true }> & { release: () => void })
  | Extract<ToolAuthorization, { allowed: false }>
> {
  let approved = input.initial;
  let permissionWaitMs = approved.permissionWaitMs;
  while (true) {
    input.signal.throwIfAborted();
    const release = await input.acquire(approved.executionInput);
    if (!input.signal.aborted && approved.permissionState === permissionStateKey(input.deps)) {
      return { ...approved, permissionWaitMs, release };
    }
    release();
    input.signal.throwIfAborted();
    const result = await input.authorize();
    if (!result.allowed) return result;
    approved = result;
    if (result.permissionWaitMs !== undefined)
      permissionWaitMs = (permissionWaitMs ?? 0) + result.permissionWaitMs;
  }
}
