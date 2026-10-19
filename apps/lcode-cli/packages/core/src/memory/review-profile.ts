import { PROJECT_MEMORY_REVIEW_ITEM_LIMIT } from "@lcode/contracts";
import type { ToolExecutionContext } from "../tool/types.js";
import {
  REVIEW_SESSION_LIMIT,
  REVIEW_SESSION_CHARACTER_LIMIT,
  REVIEW_SESSION_TOTAL_CHARACTER_LIMIT,
  REVIEW_MEMORY_LIMIT,
  REVIEW_MEMORY_CHARACTER_LIMIT,
  REVIEW_QUERY_CHARACTER_LIMIT,
  REVIEW_REQUEST_CHARACTER_LIMIT,
  REVIEW_REQUEST_TOKEN_LIMIT,
  REVIEW_OUTPUT_TOKEN_LIMIT,
} from "./review-common.js";

export const REVIEW_ADJACENT_CHARACTER_LIMIT = 512;
const ADJACENT_ENVELOPE_CHARACTERS = 128;

export interface MemoryReviewProfile {
  sessionLimit: number;
  sessionCharacterLimit: number;
  sessionTotalCharacterLimit: number;
  memoryLimit: number;
  memoryCharacterLimit: number;
  queryCharacterLimit: number;
  requestCharacterLimit: number;
  requestTokenLimit: number;
  itemLimit: number;
  generationOutputTokenLimit: number;
  verificationOutputTokenLimit: number;
}

const FULL_REVIEW_PROFILE: Readonly<MemoryReviewProfile> = Object.freeze({
  sessionLimit: REVIEW_SESSION_LIMIT,
  sessionCharacterLimit: REVIEW_SESSION_CHARACTER_LIMIT,
  sessionTotalCharacterLimit: REVIEW_SESSION_TOTAL_CHARACTER_LIMIT,
  memoryLimit: REVIEW_MEMORY_LIMIT,
  memoryCharacterLimit: REVIEW_MEMORY_CHARACTER_LIMIT,
  queryCharacterLimit: REVIEW_QUERY_CHARACTER_LIMIT,
  requestCharacterLimit: REVIEW_REQUEST_CHARACTER_LIMIT,
  requestTokenLimit: REVIEW_REQUEST_TOKEN_LIMIT,
  itemLimit: PROJECT_MEMORY_REVIEW_ITEM_LIMIT,
  generationOutputTokenLimit: REVIEW_OUTPUT_TOKEN_LIMIT,
  verificationOutputTokenLimit: 2_048,
});

const INCREMENTAL_REVIEW_PROFILE: Readonly<MemoryReviewProfile> = Object.freeze({
  sessionLimit: 1,
  sessionCharacterLimit: 6_000,
  sessionTotalCharacterLimit: 6_000,
  memoryLimit: 2,
  memoryCharacterLimit: 4_000,
  queryCharacterLimit: 1_000,
  requestCharacterLimit: 20_000,
  requestTokenLimit: 6_000,
  itemLimit: 3,
  // 原因：总输出可能包含推理，1536/768实盘可在JSON正文前耗尽；保留有界输入与两次请求。
  generationOutputTokenLimit: FULL_REVIEW_PROFILE.generationOutputTokenLimit,
  verificationOutputTokenLimit: FULL_REVIEW_PROFILE.verificationOutputTokenLimit,
});

/** 档位只来自可信runtime上下文，不读取query、候选或模型响应中的预算覆盖。 */
export function memoryReviewProfile(context: ToolExecutionContext): Readonly<MemoryReviewProfile> {
  if (
    context.reviewMode === "incremental" &&
    context.sessionStore?.readMemoryReviewEvidence &&
    context.model
  ) {
    const window = Math.floor(context.model.properties.contextWindow);
    const output = Math.max(
      1,
      Math.min(
        REVIEW_OUTPUT_TOKEN_LIMIT,
        Math.floor(context.model.optionSpecs.maxOutputTokens.max),
        Math.floor(window / 8),
      ),
    );
    // JSON 转义、独立核验候选和系统提示均需预留；这里只约束单批，后续页继续读取。
    const requestTokens = Math.max(1, window - output - 1_024);
    const characters = Math.min(
      65_536,
      Math.max(1_024, Math.floor((window - output * 2 - 4_000) / 16)),
    );
    return {
      ...INCREMENTAL_REVIEW_PROFILE,
      sessionCharacterLimit: characters,
      sessionTotalCharacterLimit:
        characters + REVIEW_ADJACENT_CHARACTER_LIMIT + ADJACENT_ENVELOPE_CHARACTERS,
      memoryCharacterLimit: Math.floor(characters / 2),
      requestCharacterLimit: requestTokens * 4,
      requestTokenLimit: requestTokens,
      generationOutputTokenLimit: output,
      verificationOutputTokenLimit: output,
    };
  }
  return context.reviewMode === "incremental" ? INCREMENTAL_REVIEW_PROFILE : FULL_REVIEW_PROFILE;
}
