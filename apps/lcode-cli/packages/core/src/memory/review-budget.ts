import type { ModelRequest, ModelUsage } from "@lcode/contracts";
import { estimateTokens } from "../context/utils.js";
import type { ToolExecutionContext } from "../tool/types.js";
import { MemoryReviewError, REVIEW_REQUEST_TOKEN_RESERVE } from "./review-common.js";
import { memoryReviewProfile } from "./review-profile.js";

type ReviewPhase = "generation" | "verification";
type BudgetReason =
  | "request-characters"
  | "request-tokens"
  | "model-context"
  | "response-characters"
  | "item-count";

export function assertReviewBudget(
  actual: number,
  limit: number,
  phase: ReviewPhase,
  reason: BudgetReason,
): void {
  if (actual > limit)
    throw new MemoryReviewError("budget_exceeded", phase, reason, { actual, limit });
}

export function assertReviewRequestBudget(
  request: ModelRequest,
  context: ToolExecutionContext,
  phase: ReviewPhase,
): void {
  const profile = memoryReviewProfile(context);
  const encoded = JSON.stringify(request);
  const estimatedTokens = estimateTokens(encoded);
  assertReviewBudget(encoded.length, profile.requestCharacterLimit, phase, "request-characters");
  assertReviewBudget(estimatedTokens, profile.requestTokenLimit, phase, "request-tokens");
  assertReviewBudget(
    estimatedTokens + request.options!.maxOutputTokens! + REVIEW_REQUEST_TOKEN_RESERVE,
    context.model!.properties.contextWindow,
    phase,
    "model-context",
  );
}

export function observeReviewOutputUsage(
  usage: ModelUsage | undefined,
  limit: number,
  context: ToolExecutionContext,
  phase: ReviewPhase,
): void {
  const actual = usage?.outputTokens;
  // 原因：usage 是供应商事后计量，可能含推理或偏差；不能把完整 stop JSON 误判为截断。
  // 请求仍有 maxOutputTokens，响应字符/候选数量和独立核验继续决定是否允许提交。
  if (actual !== undefined && Number.isFinite(actual) && actual > limit)
    context.observeMemoryReviewDiagnostic?.({ phase, reason: "output-token-usage", actual, limit });
}
