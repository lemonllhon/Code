import type { Model, ModelToolContract, TraceContext } from "../deps.js";
import type { AgentTelemetryCausation, ModelApiOperation } from "@lcode/contracts";
import {
  PermissionService,
  createDenyPermissionBroker,
  createToolExecutor,
  defaultPermissionConfig,
  traceContextToLogContext,
} from "../deps.js";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import type { ReadFileStateMap } from "../../tool/types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { getSessionShellSelectionFromConfig } from "../methods/session-shell-environment.js";
import "./runtime-provider-request-messages.js";
import { createRefreshRuntimeHeadersBeforeModelAttempt } from "../methods/model-runtime-headers.js";
import { createRuntimeModel, withModelInvocationContext } from "../methods/runtime-model.js";

export interface ProjectMemoryAgentContext {
  selectMemoryCandidateOffsets?: (query: string) => Readonly<Record<string, number>>;
  selectMemoryCandidates?: (query: string) => readonly string[];
  causation?: AgentTelemetryCausation;
  memoryRoot: string;
  memoryWorkspaceIdentity?: string;
  providerEntries: readonly RuntimeMessageEntry[];
  midConversationSystem: AgentRuntimeInternal["config"]["midConversationSystem"];
  model: Model;
  operation: ModelApiOperation;
  readFileState: ReadFileStateMap;
  tools: readonly ModelToolContract[];
  traceContext: TraceContext;
  workingDirectory: string;
  workspaceRoot: string;
}

export function captureProjectMemoryReviewContext(
  runtime: AgentRuntimeInternal,
  input: {
    memoryRoot: string;
    model?: Model;
    operation: ModelApiOperation;
    traceContext: TraceContext;
  },
): Omit<
  ProjectMemoryAgentContext,
  "providerEntries" | "midConversationSystem" | "readFileState" | "tools"
> {
  const baseModel =
    input.model ??
    createRuntimeModel(runtime, {
      selection: runtime.getSessionModelSelection(),
    });
  const model = withModelInvocationContext(baseModel, (request) => ({
    // Extraction 是 transcript 的消费者；不把它自己的请求写回同一 model-io 目录，
    // 避免后台链路占用 rollout 槽位并在后续 Extraction 中自反馈。
    metadata: {
      ...traceContextToLogContext(input.traceContext),
      querySource: input.operation,
      skipTranscript: true,
    },
    modelRequestSessionType: "other",
    modelCall: { operation: input.operation },
    refreshRuntimeHeadersBeforeAttempt: createRefreshRuntimeHeadersBeforeModelAttempt(runtime, {
      abortSignal: request.abortSignal,
      model,
      traceContext: input.traceContext,
    }),
    traceContext: input.traceContext,
  }));
  return {
    causation: runtime.agentTelemetry.captureCausation(),
    selectMemoryCandidateOffsets: runtime.projectMemoryRecallIndex?.createCandidateOffsetSelector(
      input.memoryRoot,
    ),
    selectMemoryCandidates: runtime.projectMemoryRecallIndex?.createCandidateSelector(
      input.memoryRoot,
    ),
    memoryRoot: input.memoryRoot,
    memoryWorkspaceIdentity: runtime.config.memory?.workspaceIdentity,
    model,
    operation: input.operation,
    traceContext: input.traceContext,
    workingDirectory: runtime.workingDirectory,
    workspaceRoot: runtime.workspaceRoot,
  };
}

export function createProjectMemoryAgentToolExecutor(
  runtime: AgentRuntimeInternal,
  context: ProjectMemoryAgentContext,
) {
  return createToolExecutor({
    artifactStore: runtime.artifactStore,
    emitEvent: async () => {},
    executionPort: runtime.executionPort,
    fileSystemPort: runtime.fileSystemPort,
    getBashShellSelection: () => getSessionShellSelectionFromConfig(runtime.config),
    getMode: () => "yolo",
    getMemoryRoot: () => context.memoryRoot,
    getMemoryWorkspaceIdentity: () => context.memoryWorkspaceIdentity,
    getWorkingDirectory: () => context.workingDirectory,
    getWorkspaceRoot: () => context.workspaceRoot,
    imageProcessorPort: runtime.imageProcessorPort,
    pdfDocumentPort: runtime.pdfDocumentPort,
    videoProcessorPort: runtime.videoProcessorPort,
    maxConcurrency: runtime.config.toolConcurrency?.maxConcurrency,
    model: context.model,
    permissionBroker: createDenyPermissionBroker(),
    permissionService: new PermissionService(defaultPermissionConfig),
    // Memory agent 必须继承 Main 已完成的 Read；否则 provider context 说文件已读，
    // Edit 执行边界却会拒绝同一文件，和基线的 cloned tool context 不一致。
    readFileState: new Map(context.readFileState),
    registry: runtime.registry,
    runtimeScope: "main",
    sessionId: runtime.sessionId,
    sessionStore: runtime.sessionStore,
    skillPort: runtime.skillPort,
    traceContext: context.traceContext,
  });
}
