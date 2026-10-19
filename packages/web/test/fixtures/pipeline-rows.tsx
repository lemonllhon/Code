import { useState } from "react";
import type { ConversationRow } from "@lcode/shared/lcode-protocol-v4";
import { ConversationRowView } from "@/v4/ConversationRowView.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";

const text = Array.from({ length: 2256 }, (_, index) => `fragment-${index} `).join("");
const context = {
  workspacePath: "/fixture",
  theme: "system" as const,
  codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
  messageStreamShowReasoning: true,
};

// owner/恢复顺序在 CLI 集成测试验证；这里将相同权威行状态送进实际 UI，检查两种宽度下的渲染。
export function PipelineRowsFixture() {
  const [stage, setStage] = useState("initial");
  const [away, setAway] = useState(false);
  const base = { turnId: "turn", createdAt: 1, createdAtSeq: 1 };
  const stopped = stage === "stopped";
  const rows: ConversationRow[] = [
    { ...base, rowId: 1, kind: "reasoning", text, state: stopped ? "interrupted" : "complete" },
    ...Array.from(
      { length: 12 },
      (_, index): ConversationRow => ({
        ...base,
        rowId: index + 2,
        kind: "toolCall",
        toolCallId: `read-${index}`,
        toolName: "Read",
        input: { file_path: `/fixture/file-${index}.ts` },
        inputText: JSON.stringify({ file_path: `/fixture/file-${index}.ts` }),
        status:
          index === 0 && stage !== "initial"
            ? "success"
            : stopped
              ? "cancelled"
              : index === 1 || index === 0 || (index === 2 && stage === "refill")
                ? "running"
                : "inputStreaming",
      }),
    ),
  ];
  Object.assign(globalThis, {
    __pipelineRows: {
      refill: () => setStage("refill"),
      stop: () => setStage("stopped"),
      switchSession: () => setAway((value) => !value),
    },
  });
  return (
    <main className="@container/conversation flex min-h-dvh flex-col gap-4 p-4" data-stage={stage}>
      {away ? (
        <p data-testid="other-session">Other session</p>
      ) : (
        rows.map((row) => <ConversationRowView key={row.rowId} row={row} context={context} />)
      )}
    </main>
  );
}
