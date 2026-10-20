import { CoreErrorType, createCoreError } from "@lcode/contracts";
import type { AutomationExecutionContext } from "@lcode/contracts";
import type { ToolExecutionContext } from "../types.js";

export function automationExecutionContext(
  context: ToolExecutionContext,
): AutomationExecutionContext {
  return {
    automationTurn: Boolean(context.automationTurn || context.automationId?.trim()),
    automationId: context.automationId?.trim() || undefined,
  };
}

function deny(context: ToolExecutionContext, toolName: string, message: string): never {
  throw createCoreError(CoreErrorType.PermissionDenied, message, {
    context: { toolCallId: context.toolCallId, toolName },
    recoverable: false,
    retryable: false,
  });
}

export function assertNotAutomationTurn(
  context: ToolExecutionContext,
  toolName: "CronCreate" | "CronUpdate",
): void {
  if (!context.automationTurn && !context.automationId?.trim()) return;
  // provider 隐藏工具不等于权限校验；旧入口直接提交创建/修改时仍必须在端口前拒绝。
  deny(context, toolName, `${toolName} is not allowed while running a scheduled automation.`);
}

export function assertAutomationDeleteAllowed(context: ToolExecutionContext, id: string): void {
  const automationId = context.automationId?.trim();
  if (!context.automationTurn && !automationId) return;
  // 原先整体拒绝 CronDelete 使任务无法自行收尾；仅允许精确匹配可信本轮身份。
  // boolean/queryId/denylist 只能证明受限，不能补出自身 ID；身份缺失必须拒绝。
  if (!automationId || id !== automationId) {
    deny(context, "CronDelete", "A scheduled automation can only delete itself.");
  }
}
