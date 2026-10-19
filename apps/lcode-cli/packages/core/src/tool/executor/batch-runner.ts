import {
  CoreErrorType,
  createCoreError,
  createRootTraceContext,
  traceContextToLogContext,
} from "@lcode/contracts";
import type { ToolSchedule } from "../scheduler.js";
import type { ExecutableToolCall, ToolBatchEvent, ToolExecutionResult } from "../types.js";
import { createErrorResult } from "./errors.js";
import { emitToolCallError } from "./events.js";
// import { emitSkippedToolError } from "./events.js";
import type { ToolBatchExecuteOptions, ToolExecuteOptions, ToolExecutorDeps } from "./types.js";

// const TOOL_SKIPPED_AFTER_BLOCKING_FAILURE =
//   "Tool skipped because a previous tool call in the scheduled sequence failed.";
const TOOL_CANCELLED_AFTER_TURN_STOP =
  "Tool cancelled because a previous tool result requested a turn stop.";

type ExecuteToolCall = (
  toolCall: ExecutableToolCall,
  options?: ToolExecuteOptions,
) => Promise<ToolExecutionResult>;

export async function executeToolBatch(
  deps: ToolExecutorDeps,
  executeOne: ExecuteToolCall,
  toolCalls: ExecutableToolCall[],
  options?: ToolBatchExecuteOptions,
): Promise<ToolExecutionResult[]> {
  // 修复整批等待最慢项：所有入口在权限后领取同一 executor 许可，空槽可立即补位。
  return Promise.all(
    toolCalls.map((tc) =>
      executeOne(tc, {
        ...options,
        maxConcurrency: Math.min(
          options?.maxConcurrency ?? deps.maxConcurrency,
          deps.maxConcurrency,
        ),
      }),
    ),
  );
}

export async function* executeToolSchedule(
  deps: ToolExecutorDeps,
  executeBatch: (
    toolCalls: ExecutableToolCall[],
    options?: ToolBatchExecuteOptions,
  ) => Promise<ToolExecutionResult[]>,
  toolCalls: ExecutableToolCall[],
  schedule: ToolSchedule,
  options?: ToolBatchExecuteOptions,
): AsyncGenerator<ToolBatchEvent, ToolExecutionResult[], void> {
  const toolMap = new Map(toolCalls.map((tc) => [tc.id, tc]));
  const allResults: ToolExecutionResult[] = [];
  const maxConcurrency = Math.min(
    options?.maxConcurrency ?? deps.maxConcurrency,
    schedule.maxConcurrency ?? deps.maxConcurrency,
    deps.maxConcurrency,
  );

  for (let groupIndex = 0; groupIndex < schedule.parallelGroups.length; groupIndex++) {
    const group = schedule.parallelGroups[groupIndex];
    const groupTools = group
      .map((id) => toolMap.get(id))
      .filter((tc): tc is ExecutableToolCall => tc !== undefined);

    if (groupTools.length === 0) continue;

    yield { type: "batch_start", parallelGroupIndex: groupIndex, toolCallIds: group };

    const groupResults = await executeBatch(groupTools, {
      ...options,
      automationTurn: options?.automationTurn,
      signal: options?.signal,
      traceContext: options?.traceContext,
      subagentModelOverride: options?.subagentModelOverride,
      model: options?.model,
      maxConcurrency,
    });
    allResults.push(...groupResults);

    yield { type: "batch_complete", parallelGroupIndex: groupIndex, results: groupResults };

    const shouldStopTurn = groupResults.some(
      (result) => result.turnControl?.stopTurnAfterResult === true,
    );
    if (shouldStopTurn) {
      const skippedTools = schedule.parallelGroups
        .slice(groupIndex + 1)
        .flat()
        .map((id) => toolMap.get(id))
        .filter((toolCall): toolCall is ExecutableToolCall => toolCall !== undefined);
      const eventTraceContext =
        options?.traceContext ??
        deps.traceContext ??
        createRootTraceContext({ sessionId: deps.sessionId, turnId: deps.turnId });
      const turnId = eventTraceContext.turnId ?? deps.turnId;

      for (const toolCall of skippedTools) {
        const result = createErrorResult(
          toolCall,
          createCoreError(CoreErrorType.ToolCancelled, TOOL_CANCELLED_AFTER_TURN_STOP, {
            context: { toolCallId: toolCall.id, toolName: toolCall.name },
            recoverable: true,
          }),
        );
        allResults.push(result);
        await emitToolCallError(deps, result.toolCallId, eventTraceContext, turnId, result.error);
        deps.logger?.warn("Tool call cancelled after turn stop", {
          ...traceContextToLogContext(eventTraceContext),
          event: "tool.call.cancelled_after_turn_stop",
          module: "core.tool.executor",
          status: "cancelled",
          toolCallId: result.toolCallId,
          toolName: result.toolName,
        });
      }

      break;
    }

    // 旧策略会在前序非 concurrentSafe 工具失败后，跳过所有后续调度组。
    // 连续 subagent 场景里，TodoWrite 这类本地失败会误截断后续 Agent；现在改为继续按
    // parallelGroups 顺序执行，后续工具由自己的权限、取消信号和 handler 决定结果。
    // const hasBlockingFailure = groupResults.some(
    //   (result) => !result.success && !deps.registry.get(result.toolName)?.metadata.concurrentSafe,
    // );
    // if (!hasBlockingFailure) continue;
    //
    // const skippedTools = schedule.parallelGroups
    //   .slice(groupIndex + 1)
    //   .flat()
    //   .map((id) => toolMap.get(id))
    //   .filter((toolCall): toolCall is ExecutableToolCall => toolCall !== undefined);
    //
    // for (const toolCall of skippedTools) {
    //   const result = createErrorResult(
    //     toolCall,
    //     createCoreError(CoreErrorType.ToolExecutionFailed, TOOL_SKIPPED_AFTER_BLOCKING_FAILURE, {
    //       context: { toolCallId: toolCall.id, toolName: toolCall.name },
    //       recoverable: true,
    //     }),
    //   );
    //   allResults.push(result);
    //   await emitSkippedToolError(deps, result, options?.traceContext);
    // }
    //
    // break;
  }

  // 拓扑执行顺序可能不同于模型声明顺序；回灌 history 时仍必须按声明闭合结果。
  const resultsById = new Map(allResults.map((result) => [result.toolCallId, result]));
  return toolCalls.flatMap((tool) => {
    const result = resultsById.get(tool.id);
    return result ? [result] : [];
  });
}
