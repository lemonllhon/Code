import {
  gitCredentialRequestSchema,
  gitCredentialResultSchema,
  type GitCredentialRequest,
  type GitCredentialResult,
  type LCodeWorkspaceRef,
} from "@lcode/shared";
import { authorizeGitRequestScope } from "./gitRequestScope.js";
import type { IWorktreeService } from "../worktree/contract.js";
import type { ProjectExecutionSetHostService } from "../project-execution-set/contract.js";

export async function handleGitCredentialRequest(
  input: unknown,
  attached: { workspacePath: string; workspaceIdentity?: string },
  options: {
    isActive(): boolean;
    resolve?(
      workspace: LCodeWorkspaceRef,
      request: GitCredentialRequest,
    ): Promise<GitCredentialResult>;
    worktrees?: IWorktreeService;
    executionSets?: ProjectExecutionSetHostService;
  },
): Promise<GitCredentialResult> {
  const parsed = gitCredentialRequestSchema.safeParse(input);
  if (!parsed.success || !options.isActive() || !options.resolve)
    return { kind: "error", error: "git-account-scope-unavailable" };
  try {
    const request = parsed.data;
    await authorizeGitRequestScope(request.workspace, request.sessionId, attached, options);
    const result = gitCredentialResultSchema.parse(
      await options.resolve(request.workspace, request),
    );
    // 中文依据：退出/换代后迟到的认证响应也不得把凭据交给旧运行实例。
    return options.isActive() ? result : { kind: "error", error: "git-account-scope-unavailable" };
  } catch {
    return { kind: "error", error: "git-account-scope-unavailable" };
  }
}
