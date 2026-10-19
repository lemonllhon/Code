import {
  traceContextToLogContext,
  type TraceContext,
  type PermissionBrokerResult,
  type PermissionRuleset,
} from "@lcode/contracts";
import { summarizeInput } from "./utils.js";
import type { HookRunResult } from "../../hooks/index.js";
import type { ToolEntry, ExecutableToolCall, ToolPermissionRulePolicy } from "../types.js";
import type { ToolExecutorDeps } from "./types.js";
import { applyPreToolPermissionDecision } from "./hook-flow.js";
import { applyMemoryFilePermission } from "./memory-file-permission.js";
import {
  resolveRuntimePermissionCapability,
  resolveRuntimePermissionContext,
} from "./permission-capability.js";
import { loadProjectPermissionRuleset } from "./permission-rules-persistence.js";

export interface PermissionEvaluation {
  deps: ToolExecutorDeps;
  toolCall: ExecutableToolCall;
  entry: ToolEntry;
  executionInput: unknown;
  preToolHookResult: HookRunResult;
  projectRules?: PermissionRuleset | null;
  rulePolicy?: ToolPermissionRulePolicy;
}

/** 用户应答满足 ask，等待期间新增的 Plan/硬拒绝仍须保留。 */
export function recheckResolvedPermission(
  input: PermissionEvaluation,
  result: PermissionBrokerResult,
  previousState: string,
) {
  const permissionState = permissionStateKey(input.deps);
  const latest =
    permissionState === previousState ? undefined : evaluateCurrentToolPermission(input);
  return {
    permissionState,
    mode: latest?.mode ?? input.deps.getMode(),
    result:
      latest?.decision.decision === "deny"
        ? { decision: "deny" as const, reason: latest.decision.reason, resolvedAt: new Date() }
        : result,
  };
}

export function permissionStateKey(deps: ToolExecutorDeps): string {
  return JSON.stringify([
    deps.getMode(),
    deps.sessionModePort?.isPlanEnabled?.() ?? false,
    deps.sessionModePort?.getPrePlanMode(),
  ]);
}

/** 首判与切换后重判复用同一政策，读取当前 Runtime，不能沿用 Hook 前冻结的 mode。 */
export function evaluateCurrentToolPermission(input: PermissionEvaluation) {
  const { deps, toolCall, entry, executionInput, preToolHookResult } = input;
  const mode = deps.getMode();
  let decision = deps.permissionService.checkPermission(
    {
      toolName: toolCall.name,
      input: executionInput,
      mode,
      riskLevel: entry.metadata.riskLevel,
      prePlanMode: deps.sessionModePort?.getPrePlanMode(),
      planEnabled: deps.sessionModePort?.isPlanEnabled?.(),
      workingDirectory: deps.getWorkingDirectory(),
    },
    resolveRuntimePermissionCapability(
      entry,
      executionInput,
      resolveRuntimePermissionContext(deps),
    ),
    input.projectRules,
    input.rulePolicy,
  );
  decision = applyPreToolPermissionDecision(decision, preToolHookResult, mode);
  return {
    mode,
    decision: applyMemoryFilePermission({
      decision,
      executionInput,
      memoryRoot: deps.getMemoryRoot?.(),
      toolName: toolCall.name,
      workingDirectory: deps.getWorkingDirectory(),
      workspaceRoot: deps.getWorkspaceRoot(),
    }),
  };
}

/** 第三个审批应答方：只消费已提交状态，不代用户点击，不重新执行 Hook/handler。 */
export function watchPermissionMode(
  input: PermissionEvaluation,
  signal: AbortSignal,
): Promise<PermissionBrokerResult | undefined> {
  const port = input.deps.sessionModePort;
  if (!port?.onPermissionChanged) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    let revision = 0,
      stopped = false,
      unsubscribe: (() => void) | undefined;
    const close = () => {
      stopped = true;
      revision++;
      unsubscribe?.();
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      close();
      resolve(undefined);
    };
    const check = async () => {
      const current = ++revision;
      try {
        const projectRules = await loadProjectPermissionRuleset(input.deps);
        if (stopped || signal.aborted || current !== revision) return;
        const { decision } = evaluateCurrentToolPermission({ ...input, projectRules });
        if (decision.decision === "ask") return;
        close();
        resolve({ decision: decision.decision, reason: decision.reason, resolvedAt: new Date() });
      } catch {
        // 基础设施错误不能变成自动许可，原 broker 仍然负责本次交互。
        input.deps.logger?.warn("Permission mode recheck failed; waiting for original approval", {
          event: "tool.permission.mode_recheck_failed",
          module: "core.tool.executor",
          toolCallId: input.toolCall.id,
        });
      }
    };
    unsubscribe = port.onPermissionChanged!(() => {
      void check();
    });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else void check();
  });
}

export function logToolPermissionEvaluation(
  input: PermissionEvaluation,
  evaluated: ReturnType<typeof evaluateCurrentToolPermission>,
  traceContext: TraceContext,
): void {
  const { deps, toolCall } = input;
  const { mode, decision: permissionDecision } = evaluated;
  deps.logger?.debug("Tool permission evaluated", {
    ...traceContextToLogContext(traceContext),
    decision: permissionDecision.decision,
    event: "tool.permission.evaluated",
    inputSummary: summarizeInput(toolCall.input),
    mode,
    module: "core.tool.executor",
    reason: permissionDecision.reason,
    riskLevel: permissionDecision.riskLevel,
    ruleId: permissionDecision.ruleId,
    sideEffectScope: permissionDecision.sideEffectScope,
    status:
      permissionDecision.decision === "allow"
        ? "completed"
        : permissionDecision.decision === "ask"
          ? "waiting"
          : "failed",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
  });
}
