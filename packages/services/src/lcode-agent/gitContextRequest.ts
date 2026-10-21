import {
  gitAgentContextRequestSchema,
  gitAgentContextSchema,
  type GitAgentContext,
  type LCodeWorkspaceRef,
} from "@lcode/shared";
import { authorizeGitRequestScope, type GitRequestScopeOptions } from "./gitRequestScope.js";

export async function handleGitContextRequest(
  input: unknown,
  attached: { workspacePath: string; workspaceIdentity?: string },
  options: GitRequestScopeOptions & {
    resolve?(workspace: LCodeWorkspaceRef, sessionId: string): Promise<GitAgentContext>;
  },
): Promise<GitAgentContext> {
  const request = gitAgentContextRequestSchema.safeParse(input);
  if (!request.success || !options.resolve || !options.isActive()) return { status: "unavailable" };
  try {
    await authorizeGitRequestScope(
      request.data.workspace,
      request.data.sessionId,
      attached,
      options,
    );
    const result = gitAgentContextSchema.parse(
      await options.resolve(request.data.workspace, request.data.sessionId),
    );
    // 与凭据请求相同，旧 client 的迟到结果不得进入新的模型步骤。
    return options.isActive() ? result : { status: "unavailable" };
  } catch {
    return { status: "unavailable" };
  }
}
