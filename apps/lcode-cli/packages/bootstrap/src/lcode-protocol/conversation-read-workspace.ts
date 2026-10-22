import type { SessionId, SessionInfo } from "@lcode/contracts";
import { lcodeWorkspaceRefSchema, type LCodeWorkspaceRef } from "@lcode/shared";
import type { LCodeProtocolAgentServerContext } from "./server-types.js";
import { buildWorkspaceRef, originWorkspaceRef } from "./workspace.js";
import { WORKTREE_BINDING_ENTRY } from "./worktree-execution.js";

export const conversationWorkspaceKey = (workspace: LCodeWorkspaceRef) =>
  workspace.workspaceIdentity?.trim() || workspace.workspacePath;

export class ConversationReadWorkspaceError extends Error {
  constructor(
    readonly reasonCode:
      | "fault.history.sessionNotFound"
      | "fault.history.workspaceMismatch"
      | "fault.history.remoteSessionMismatch",
    sessionId?: string,
  ) {
    super(sessionId ? `${reasonCode}: ${sessionId}` : reasonCode);
    this.name = "ConversationReadWorkspaceError";
  }
}

/** 只读入口与辅助请求共用 origin / execution / attachment 的身份判断。 */
export function conversationReadScopeFault(
  execution: LCodeWorkspaceRef,
  requested: LCodeWorkspaceRef,
): "fault.history.workspaceMismatch" | "fault.history.remoteSessionMismatch" | null {
  const key = conversationWorkspaceKey(requested);
  if (
    key !== conversationWorkspaceKey(execution) &&
    key !== conversationWorkspaceKey(originWorkspaceRef(execution))
  )
    return "fault.history.workspaceMismatch";
  if (
    execution.remoteSessionId &&
    requested.remoteSessionId &&
    execution.remoteSessionId !== requested.remoteSessionId
  )
    return "fault.history.remoteSessionMismatch";
  return null;
}

async function resolveExecutionWorkspace(
  context: LCodeProtocolAgentServerContext,
  sessionId: string,
  stored: SessionInfo | null | undefined,
  visited: Set<string>,
): Promise<LCodeWorkspaceRef | undefined> {
  if (visited.has(sessionId)) throw new Error("fault.history.parentCycle");
  visited.add(sessionId);
  const direct = context.sessions.get(sessionId)?.workspace;
  if (direct) return direct;
  const entries = stored
    ? await context.deps.sessionStore?.sessionEntries?.({
        sessionID: sessionId as SessionId,
        type: WORKTREE_BINDING_ENTRY,
      })
    : undefined;
  const binding = entries?.filter((entry) => entry.type === WORKTREE_BINDING_ENTRY).at(-1);
  // 已声明但损坏的绑定不是“旧记录缺失”，不能降级继承另一工作区。
  if (binding) return lcodeWorkspaceRefSchema.parse(binding.data);
  if (!stored) return undefined;
  // 旧 Agent child 只保存了执行 cwd，丢失父 workspacePath/identity/binding。
  // 仅对无显式身份的真实 subagent 关系沿持久 parentID 还原，不能用请求路径放宽校验。
  if (stored.taskType === "subagent_child" && !stored.workspaceID?.trim() && stored.parentID) {
    const parent = await context.deps.sessionStore?.getSession(stored.parentID);
    const inherited = await resolveExecutionWorkspace(context, stored.parentID, parent, visited);
    if (inherited) return inherited;
  }
  return buildWorkspaceRef({
    workspacePath: stored.path || stored.directory,
    workspaceIdentity: stored.workspaceID,
  });
}

/** 沿用执行绑定的 schema 与 origin 语义，不能把详情入口路径当作文件执行 cwd。 */
export async function resolveConversationReadWorkspace(
  context: LCodeProtocolAgentServerContext,
  sessionId: string,
  stored: SessionInfo | null | undefined,
  requested?: LCodeWorkspaceRef,
): Promise<LCodeWorkspaceRef> {
  const execution = await resolveExecutionWorkspace(context, sessionId, stored, new Set());
  if (!execution)
    throw new ConversationReadWorkspaceError("fault.history.sessionNotFound", sessionId);
  if (requested) {
    const fault = conversationReadScopeFault(execution, requested);
    if (fault) throw new ConversationReadWorkspaceError(fault);
  }
  return {
    ...execution,
    ...(requested?.remoteSessionId ? { remoteSessionId: requested.remoteSessionId } : {}),
  };
}
