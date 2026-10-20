// ============================================================
// Automation Port - scheduled task management boundary
// ============================================================

import type {
  CronAutomation,
  CronCreateInput,
  CronDeleteInput,
  CronUpdateInput,
} from "../tools/automation.js";

export const AUTOMATION_CREATE_LIMIT_ERROR_CODE = "AUTOMATION_CREATE_LIMIT_REACHED";

export class AutomationCreateLimitError extends Error {
  readonly code = AUTOMATION_CREATE_LIMIT_ERROR_CODE;
  override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "AutomationCreateLimitError";
    this.cause = cause;
  }
}

export function isAutomationCreateLimitError(error: unknown): error is AutomationCreateLimitError {
  if (error instanceof AutomationCreateLimitError) return true;
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; message?: unknown };
  return (
    candidate.code === AUTOMATION_CREATE_LIMIT_ERROR_CODE ||
    (typeof candidate.message === "string" &&
      candidate.message.includes(AUTOMATION_CREATE_LIMIT_ERROR_CODE))
  );
}

/** 执行器注入的单次调用归因；不属于模型输入或跨进程协议参数。 */
export interface AutomationExecutionContext {
  automationTurn: boolean;
  automationId?: string;
}

export interface AutomationCreateContext extends Partial<AutomationExecutionContext> {
  /** 当前工具调用所在 runtime 的模型，由执行器注入，不来自模型输入。 */
  model?: string;
  /** 当前工具调用所在 session；会话内 cron 后续触发复用该 session。 */
  sessionId?: string;
}

export interface AutomationPort {
  create(input: CronCreateInput, context?: AutomationCreateContext): Promise<CronAutomation>;
  update(input: CronUpdateInput, context?: AutomationExecutionContext): Promise<CronAutomation>;
  list(): Promise<CronAutomation[]>;
  /** 执行轮只允许删除其可信 automationId；普通用户轮沿用 workspace 管理权限。重复删除返回 false。 */
  delete(input: CronDeleteInput, context?: AutomationExecutionContext): Promise<boolean>;
}
