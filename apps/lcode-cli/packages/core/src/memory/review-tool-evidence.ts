import { parseCompletedToolPartMetadata, type MessageWithParts } from "@lcode/contracts";

const TOOL_EVIDENCE_LIMIT = 12;
const TOOL_EVIDENCE_CHARACTER_LIMIT = 1200;
const IDENTIFIER_LIMIT = 128;

/** 只投影持久结构化状态；禁止把可伪造的输出文案重新解释成执行证明。 */
export function projectReviewToolEvidence(messages: readonly MessageWithParts[]): {
  text: string;
  partial: boolean;
} {
  const parts = messages.flatMap((message) => message.parts.filter((part) => part.type === "tool"));
  const facts: unknown[] = [];
  let text = "";
  let truncated = parts.length > TOOL_EVIDENCE_LIMIT;
  for (const part of parts.slice(-TOOL_EVIDENCE_LIMIT)) {
    const execution =
      part.state.status === "completed"
        ? parseCompletedToolPartMetadata(part.state.metadata)?.execution
        : undefined;
    // 普通工具仅完成 handler，不是执行证明；纳入指纹会让无关 Read 更新冲掉已冻结提案。
    if (!execution) continue;
    const next = {
      tool: part.tool.slice(0, IDENTIFIER_LIMIT),
      callID: part.callID.slice(0, IDENTIFIER_LIMIT),
      status: part.state.status,
      ...(execution ? { execution } : {}),
    };
    const candidate = `\nStructured tool states (exit status proves only that call): ${JSON.stringify([...facts, next])}`;
    if (candidate.length > TOOL_EVIDENCE_CHARACTER_LIMIT) {
      truncated = true;
      break;
    }
    facts.push(next);
    text = candidate;
  }
  return { text, partial: truncated };
}
