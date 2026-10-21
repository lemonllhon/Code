import type { LCodeWorkspaceRef } from "@lcode/shared";
import { authorizeProjectContextRequest } from "./projectContextScope.js";
import type { IWorktreeService } from "../worktree/contract.js";
import type { ProjectExecutionSetHostService } from "../project-execution-set/contract.js";

export interface GitRequestScopeOptions {
  isActive(): boolean;
  worktrees?: IWorktreeService;
  executionSets?: ProjectExecutionSetHostService;
}
export async function authorizeGitRequestScope(
  workspace: LCodeWorkspaceRef,
  sessionId: string,
  attached: { workspacePath: string; workspaceIdentity?: string },
  options: GitRequestScopeOptions,
) {
  if (!options.isActive()) throw new Error("git-account-scope-unavailable");
  await authorizeProjectContextRequest(
    workspace,
    sessionId,
    attached,
    options.worktrees,
    options.executionSets,
  );
  if (workspace.executionBindingId) {
    const binding = await options.worktrees?.getBinding({ ...attached, taskId: sessionId });
    if (binding?.status !== "ready") throw new Error("git-account-scope-unavailable");
  }
  if (!options.isActive()) throw new Error("git-account-scope-unavailable");
}
