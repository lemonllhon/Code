import {
  SESSION_ENTRY_MODEL_SELECTION,
  type Model,
  type ModelSelection,
  type TraceContext,
  type TurnInputIntentMetadata,
} from "@lcode/contracts";
import { getCurrentModelInvocationContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { cloneModelSelection } from "../model-selection.js";
import type { RuntimeModelFactory } from "../types.js";
import { createRefreshRuntimeHeadersBeforeModelAttempt } from "./model-runtime-headers.js";
import { createRuntimeModel, withModelInvocationContext } from "./runtime-model.js";
import { applyRuntimeExecutionState } from "../execution-state.js";

export function createTurnModel(
  runtime: AgentRuntimeInternal,
  options: {
    rawModelFactory?: RuntimeModelFactory;
    selection?: ModelSelection;
    requestDependencies?: import("@lcode/contracts").ModelRequestDependencies;
  } = {},
): Model {
  const selection = options.selection ?? runtime.getSessionModelSelection();
  const model = createRuntimeModel(runtime, {
    rawModelFactory: options.rawModelFactory,
    selection,
    requestDependencies: options.requestDependencies,
  });
  return withModelInvocationContext(model, (request) => ({
    refreshRuntimeHeadersBeforeAttempt: createRefreshRuntimeHeadersBeforeModelAttempt(runtime, {
      abortSignal: request.abortSignal,
      model,
      traceContext: getCurrentModelInvocationContext()?.traceContext ?? runtime.rootTraceContext,
    }),
  }));
}

/**
 * 在 Submission 真正开始执行或 Guide 被下一次 model step 消费时应用其执行配置。
 * 选择只决定新创建的 Model；已经被其他 Loop 持有的 Model 不会被修改。
 */
export async function applySubmissionExecutionState(
  runtime: AgentRuntimeInternal,
  intent: TurnInputIntentMetadata | undefined,
  traceContext: TraceContext,
  modelExecution?: import("../types.js").ModelExecutionContext,
  preparedModel?: Model,
): Promise<Model | undefined> {
  const selection = intent?.modelSelection;
  const previousSelection = runtime.getSessionModelSelection();
  let model = preparedModel;

  if (selection) {
    model ??= createTurnModel(runtime, {
      selection,
      requestDependencies: modelExecution?.requestDependencies,
    });
    if (modelExecution?.selectionScope !== "execution") {
      const appliedSelection = cloneModelSelection(selection);
      runtime.setSessionModelSelection(appliedSelection);
      await persistRuntimeModelSelection(runtime, appliedSelection);
      if (!sameModelSelection(previousSelection, appliedSelection)) {
        await runtime.emitModelSelected({
          model,
          modelSelection: appliedSelection,
          effectiveReasoningLevel: model.options.reasoningLevel,
          previousModelSelection: previousSelection,
          supportedThoughtLevels: model.optionSpecs.reasoningLevel.values,
          traceContext,
        });
      }
    }
  }

  if (intent?.mode !== undefined || intent?.planEnabled !== undefined) {
    await applyRuntimeExecutionState(runtime, intent, { source: "command", traceContext });
  }

  return model;
}

export function sameModelSelection(
  left: ModelSelection | undefined,
  right: ModelSelection,
): boolean {
  return (
    left?.providerId === right.providerId &&
    left.modelId === right.modelId &&
    left.options?.reasoningLevel === right.options?.reasoningLevel &&
    left.options?.speed === right.options?.speed
  );
}

type SelectionPersistenceOutcome = Awaited<
  ReturnType<AgentRuntimeInternal["persistSessionModelSelection"]>
>;
const selectionWrites = new WeakMap<AgentRuntimeInternal, Promise<SelectionPersistenceOutcome>>();

export async function persistSessionModelSelection(
  this: AgentRuntimeInternal,
): Promise<SelectionPersistenceOutcome> {
  const selection = this.getSessionModelSelection();
  return selection ? persistRuntimeModelSelection(this, selection) : "unavailable";
}

export async function persistRuntimeModelSelection(
  runtime: AgentRuntimeInternal,
  selection: ModelSelection,
): Promise<SelectionPersistenceOutcome> {
  // 草稿没有父 session；唯一 Runtime owner 在父记录创建后补写最新选型，避免外键失败。
  if (!runtime.sessionPersisted) return "deferred";
  if (!runtime.sessionStore?.saveSessionEntry) return "unavailable";
  const snapshot = cloneModelSelection(selection);
  // 所有入口串行覆盖同一稳定 entry，较慢的旧写入不能覆盖新选型。
  const write = (selectionWrites.get(runtime) ?? Promise.resolve()).then(
    async (): Promise<SelectionPersistenceOutcome> => {
      const timestamp = Date.now();
      try {
        await runtime.sessionStore!.saveSessionEntry!({
          id: `${runtime.sessionId}:runtime-model-selection`,
          sessionID: runtime.sessionId,
          type: SESSION_ENTRY_MODEL_SELECTION,
          touchSession: false,
          time: { created: timestamp, updated: timestamp },
          data: snapshot,
        });
        return "persisted";
      } catch (error) {
        runtime.logger?.warn("Session model selection persistence failed", {
          error: error instanceof Error ? error.message : String(error),
          event: "session.model_selection.persist_failed",
          modelId: snapshot.modelId,
          module: "core.runtime",
          providerId: snapshot.providerId,
          status: "failed",
        });
        return "failed";
      }
    },
  );
  selectionWrites.set(runtime, write);
  const outcome = await write;
  if (selectionWrites.get(runtime) === write) selectionWrites.delete(runtime);
  return outcome;
}
