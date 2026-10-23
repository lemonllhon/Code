// ============================================================
// Tool Types - Core tool types for registry and executor
// ============================================================

import type {
  AutomationPort,
  BrowserControlPort,
  CoordinatorResponsePort,
  DynamicWorkflowRunPort,
  DynamicWorkflowSnippetPort,
  EmbeddedSearchBackend,
  ExecutionPort,
  ExecutionShellSelection,
  FileSystemPort,
  HttpClientPort,
  ImageProcessorPort,
  Model,
  ModelCatalogPort,
  PdfDocumentPort,
  SessionEvent,
  SessionId,
  SessionModePort,
  SessionStorePort,
  SkillPort,
  SkillTelemetryMetadata,
  SubagentPort,
  SubagentRunOptions,
  ToolArtifactStorePort,
  ToolExecutionSpanWriter,
  TraceContext,
  TraceId,
  TurnId,
  VideoProcessorPort,
  WorkflowEscalatePort,
  WorkflowPort,
  WorkflowSubmitPort,
} from "@lcode/contracts";
import type { RuntimeTaskRegistry } from "../runtime-task/registry.js";
import type { PersistedReadFileStateMetadata } from "./read-file-state-metadata.js";

export type ToolRuntimeScope = "main" | "subagent";

export interface BackgroundTaskControlStopOptions {
  /** 谁在停：TaskStop 填 "model"，终态通知据此措辞。 */
  initiator?: "user" | "model";
  strict: true;
  traceContext?: TraceContext;
}

export interface BackgroundTaskControlStopResult {
  command?: string;
  ok: boolean;
  reason?:
    | "background_task_cancel_not_supported"
    | "background_task_not_found"
    | "background_task_not_running";
  status?: string;
  taskId: string;
  type?: string;
}

export interface BackgroundTaskControlPort {
  stopBackgroundTask(
    taskId: string,
    options: BackgroundTaskControlStopOptions,
  ): Promise<BackgroundTaskControlStopResult>;
}

export interface ToolExecutionContext {
  resolveProjectGitAccount?: import("../runtime/types.js").AgentRuntimeDeps["resolveGitAccount"];
  /** 仅记录无正文的用量偏差；不是审批、消费或重试入口。 */
  observeMemoryReviewDiagnostic?: (diagnostic: {
    phase: "generation" | "verification";
    reason: "output-token-usage";
    actual: number;
    limit: number;
  }) => void;
  /** 仅可信运行时观测阶段，不参与权限、工具输入或消费状态判断。 */
  observeMemoryReviewPhase?: (
    phase: "admission" | "generation" | "verification" | "commit" | "finish",
  ) => void;
  toolCallId: string;
  /**
   * 当前 Tool 的实时观测写入器。Handler 只能通过窄接口写事实，不能接触原始 OTel Span。
   */
  telemetry?: ToolExecutionSpanWriter;
  /** 当前工具调用是否属于 automation 派发轮；写工具 handler 用它做最终权限校验。 */
  automationTurn?: boolean;
  /** 本轮可信 admission 身份；不得从工具输入或持久化会话绑定推断，用于仅删除自身。 */
  automationId?: string;
  traceContext?: TraceContext;
  traceId: TraceId;
  spanId?: string;
  parentSpanId?: string;
  abortSignal: AbortSignal;
  backgroundTaskControlPort?: BackgroundTaskControlPort;
  emitEvent?: (event: SessionEvent) => Promise<void>;
  executionPort?: ExecutionPort;
  /** browser-use 控制端口；node_repl 的 agent.browsers.* 经此执行。缺省则 browser 不可用。 */
  browserControlPort?: BrowserControlPort;
  /** 官方 browser-use plugin docs 资产目录；只在 browser-use 启用时用于 agent.browsers.documentation()。 */
  browserDocumentationRoot?: string;
  fileSystemPort?: FileSystemPort;
  httpClientPort?: HttpClientPort;
  imageProcessorPort?: ImageProcessorPort;
  pdfDocumentPort?: PdfDocumentPort;
  videoProcessorPort?: VideoProcessorPort;
  model?: Model;
  /** Core Server 对前台 child 的 Selection override。 */
  subagentModelOverride?: SubagentRunOptions["modelOverride"];
  skillPort?: SkillPort;
  subagentPort?: SubagentPort;
  coordinatorResponsePort?: CoordinatorResponsePort;
  /** 工作流 actor 提交终态结果并等待引擎裁决的端口；仅在 workflow actor 会话注入。 */
  workflowSubmitPort?: WorkflowSubmitPort;
  /** 工作流 actor 升级阻塞问题并等待主代理作答的端口；仅在 workflow actor 会话注入。 */
  workflowEscalatePort?: WorkflowEscalatePort;
  artifactStore?: ToolArtifactStorePort;
  automationPort?: AutomationPort;
  sessionStore?: SessionStorePort;
  sessionModePort?: SessionModePort;
  workflowPort?: WorkflowPort;
  /** workflow run 提交端口；缺席则 CreateWorkflow 回占位诊断而不启动。 */
  dynamicWorkflowRunPort?: DynamicWorkflowRunPort;
  /** dwf snippet 同步执行端口；缺席则 EvalWorkflowSnippet 报能力缺席的业务失败。 */
  dynamicWorkflowSnippetPort?: DynamicWorkflowSnippetPort;
  /** 模型目录端口；缺席则 ListModels 报能力缺席，CreateWorkflow 的 subagent_model 被拒。 */
  modelCatalogPort?: ModelCatalogPort;
  runtimeTaskRegistry?: RuntimeTaskRegistry;
  readFileState?: ReadFileStateMap;
  recordReadFileStateMetadata?: (metadata: PersistedReadFileStateMetadata) => void;
  /** 记录 Skill resolved metadata；仅用于 telemetry，不改变模型可见结果。 */
  recordSkillTelemetryMetadata?: (metadata: SkillTelemetryMetadata) => void;
  bashShellSelection?: ExecutionShellSelection;
  embeddedSearch?: ToolEmbeddedSearchContext;
  setWorkingDirectory?: (cwd: string) => Promise<void> | void;
  workingDirectory: string;
  workspaceRoot: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  clientMode?: "desktop-continuous" | "web-remote-replayable";
  deliveryKind?: "desktop-continuous" | "web-remote-replayable";
  memoryRoot?: string;
  /** Identity of the registered Project Memory root, supplied by its Runtime owner. */
  memoryWorkspaceIdentity?: string;
  /** 后台记忆复盘冻结的已完成会话边界；不属于模型工具输入。 */
  reviewBoundary?: { sessionId: string; messageId: string; startMessageId?: string };
  /** 可信 core 分段控制，不能由工具或模型入参覆盖。 */
  reviewSegment?: import("@lcode/contracts").ProjectMemoryReviewSource["segment"];
  selectMemoryCandidateOffsets?: (query: string) => Readonly<Record<string, number>>;
  /** 自动维护只读取本轮增量；显式跨会话复盘不设置此字段。 */
  reviewMode?: "incremental";
  /** Runtime 提供的冻结派生候选，只返回文件名；完整证据由复盘独立重读。 */
  selectMemoryCandidates?: (query: string) => readonly string[];
  runtimeScope?: ToolRuntimeScope;
  providerVisibleToolNames?: readonly string[];
  sessionId: SessionId;
  turnId?: TurnId;
}

export interface ToolEmbeddedSearchContext {
  backend?: EmbeddedSearchBackend;
  enabled: boolean;
  findAndGrepEnabled?: boolean;
}

export interface ReadFileStateEntry {
  path: string;
  content: string;
  offset?: number;
  limit?: number;
  isPartialView: boolean;
  readAt: Date;
  sourceTool?: "Read" | "Write" | "Edit";
  revisionId?: string;
  mtimeMs?: number;
  sizeBytes?: number;
}

export type ReadFileStateMap = Map<string, ReadFileStateEntry>;
