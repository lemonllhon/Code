import { refreshBranchAwareBuiltInTools } from "./embedded-search-branch.js";
import { formatProjectContextSnapshot, projectContextSnapshotSchema } from "@lcode/shared";
import type { TurnInputIntentMetadata } from "@lcode/contracts";
import type { TraceContext } from "@lcode/contracts";
import type { AgentRuntimeInternal } from "../internal.js";
import { prepareProjectFilesystemMcp } from "./project-filesystem-mcp.js";

/** 原生工具只使用 admission 固定的范围，历史 workspaceRoot 与本轮默认 cwd 分离。 */
export async function prepareTurnProjectContext(
  runtime: AgentRuntimeInternal,
  intent: TurnInputIntentMetadata | undefined,
  signal: AbortSignal,
  traceContext?: TraceContext,
  options?: { preserveCurrentScope?: boolean },
): Promise<void> {
  signal.throwIfAborted();
  // 后台/子智能体消息不是新用户准入；清空范围会让同一会话续跑失去目录路由。
  // 只保留当前 Runtime 已接受的范围，冷恢复历史和通知文本均不能授予新能力。
  if (options?.preserveCurrentScope && !intent?.projectContext && runtime.projectContextForTools)
    return;
  const entries = runtime.messageHistory.borrowReadOnlyRuntimeEntries();
  const previousScope = entries.some((entry) => entry.metadata?.source === "project_scope");
  if (previousScope)
    runtime.messageHistory.replaceMessages(
      entries.filter((entry) => entry.metadata?.source !== "project_scope"),
    );
  const previousRouting = Boolean(runtime.projectContextForTools);
  runtime.projectContextForTools = undefined;
  if (previousRouting && runtime.registry) refreshBranchAwareBuiltInTools(runtime);
  const inherited = intent?.projectContext ?? runtime.inheritedProjectContext;
  if (!inherited) {
    if (previousScope && traceContext)
      await prepareProjectFilesystemMcp(runtime, undefined, traceContext);
    return;
  }
  const snapshot = projectContextSnapshotSchema.parse(inherited);
  if (!runtime.fileSystemPort)
    throw new Error("Project context requires the filesystem capability");
  for (const member of snapshot.members) {
    if (member.routeToken) continue;
    if (signal.aborted) throw new Error("Project context preparation cancelled");
    const status = await runtime.fileSystemPort.stat(
      { path: member.workspacePath, trace: traceContext },
      { signal },
    );
    if (status.kind !== "directory")
      throw new Error(`${member.workspacePath}: project member is not a directory`);
  }
  if (
    !snapshot.execution.routeToken &&
    !snapshot.members.some((member) => member.workspacePath === snapshot.execution.workspacePath)
  ) {
    const status = await runtime.fileSystemPort.stat(
      { path: snapshot.execution.workspacePath, trace: traceContext },
      { signal },
    );
    if (status.kind !== "directory") throw new Error("Project execution folder is not a directory");
  }
  if (traceContext && !snapshot.members.some((member) => member.routeToken))
    await prepareProjectFilesystemMcp(runtime, snapshot, traceContext);
  // 最后一次 stat/MCP await 可能在取消后才完成，发布范围与 cwd 前必须再验证本轮仍有效。
  signal.throwIfAborted();
  runtime.projectContextForTools = snapshot;
  if (snapshot.members.some((member) => member.routeToken) && runtime.registry)
    refreshBranchAwareBuiltInTools(runtime);
  // 主要目录曾仅改变标记，Bash 仍使用历史主路径；在原串行 turn 边界应用已准入的 cwd，不能读取新草稿。
  runtime.setWorkingDirectory(snapshot.execution.workspacePath);
  runtime.messageHistory.addUser(formatProjectContextSnapshot(snapshot), {
    source: "project_scope",
  });
}
