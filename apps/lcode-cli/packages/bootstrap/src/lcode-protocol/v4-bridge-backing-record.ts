import type { SessionId, SessionInfo } from "@lcode/contracts";
import type { LCodeWorkspaceRef } from "@lcode/shared";
import {
  ConversationReadWorkspaceError,
  conversationWorkspaceKey,
  resolveConversationReadWorkspace,
} from "./conversation-read-workspace.js";

import type {
  LCodeProtocolAgentServerContext,
  LCodeProtocolSessionRecord,
} from "./server-types.js";

export async function resolveConversationBackingRecord(
  context: LCodeProtocolAgentServerContext,
  sessionId: string,
  workspace: LCodeWorkspaceRef,
): Promise<LCodeProtocolSessionRecord | undefined> {
  let current = sessionId;
  const workspaceKey = conversationWorkspaceKey(workspace);
  const visited = new Set<string>();
  const ancestors: SessionInfo[] = [];
  while (!visited.has(current)) {
    visited.add(current);
    const direct = context.sessions.get(current);
    if (direct) {
      if (direct.workspace && conversationWorkspaceKey(direct.workspace) !== workspaceKey)
        throw new ConversationReadWorkspaceError("fault.history.workspaceMismatch");
      // 仅在确实借用 live 能力时核对整条父链；没有 live owner 的独立 fork
      // 仍可读取自身冷历史，不能因它的父会话属于另一工作区而拒绝。
      for (const ancestor of ancestors) {
        const ancestorWorkspace = await resolveConversationReadWorkspace(
          context,
          ancestor.id,
          ancestor,
        );
        if (conversationWorkspaceKey(ancestorWorkspace) !== workspaceKey)
          throw new ConversationReadWorkspaceError("fault.history.workspaceMismatch");
      }
      return direct;
    }
    const stored = await context.deps.sessionStore?.getSession(current as SessionId);
    if (!stored?.parentID) return undefined;
    // 父能力借用与请求入口必须共用工作区解析；原实现直接比较 child cwd，
    // 且只核对第一层和 live 根，会误拒绝旧子会话并漏过中间显式跨域绑定。
    ancestors.push(stored);
    current = String(stored.parentID);
  }
  throw new Error("fault.history.parentCycle");
}
