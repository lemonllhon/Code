import { withProjectMemberSelector } from "./registry.js";
import { PROJECT_NATIVE_TOOLS } from "./project-routing.js";
import type { ModelToolContract } from "@lcode/contracts";
import type { ToolEntry, ToolExecutionModelContext } from "./types.js";

export function resolveToolEntryModelContract(
  entry: ToolEntry,
  context: ToolExecutionModelContext,
): ToolEntry {
  const projection = entry.resolveModelContract?.(context);
  const inputSchema = projection?.inputSchema ?? entry.inputSchema;
  return {
    ...entry,
    inputSchema:
      context.projectRoutingAvailable && PROJECT_NATIVE_TOOLS.has(entry.metadata.name)
        ? withProjectMemberSelector(inputSchema)
        : inputSchema,
    metadata: {
      ...entry.metadata,
      ...(projection?.description !== undefined ? { description: projection.description } : {}),
    },
  };
}

export function projectToolModelContract(
  contract: ModelToolContract,
  entry: ToolEntry | undefined,
  context: ToolExecutionModelContext,
): ModelToolContract {
  if (!entry) return contract;
  const projection = entry.resolveModelContract?.(context);
  const inputSchema = projection?.inputSchema ?? contract.inputSchema;
  return {
    ...contract,
    ...(projection?.description !== undefined ? { description: projection.description } : {}),
    // 模型曾能看到当前 Runtime 无法执行的选择器；仅原生工具且真实范围/resolver 同时存在时发布。
    inputSchema:
      context.projectRoutingAvailable && PROJECT_NATIVE_TOOLS.has(entry.metadata.name)
        ? withProjectMemberSelector(inputSchema)
        : inputSchema,
  };
}
