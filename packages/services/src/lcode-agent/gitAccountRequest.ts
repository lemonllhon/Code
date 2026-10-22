import {
  gitAccountOperationRequestSchema,
  gitAccountOperationResultSchema,
  type GitAccountOperationResult,
} from "@lcode/shared";
import { authorizeGitRequestScope, type GitRequestScopeOptions } from "./gitRequestScope.js";
import type { createHostGitAccountOperator } from "../git-management/gitAccountHost.js";

export async function handleGitAccountRequest(
  input: unknown,
  attached: { workspacePath: string; workspaceIdentity?: string },
  options: GitRequestScopeOptions & { resolve?: ReturnType<typeof createHostGitAccountOperator> },
): Promise<GitAccountOperationResult> {
  const denied = { status: "error", error: "git-account-scope-unavailable" } as const;
  const parsed = gitAccountOperationRequestSchema.safeParse(input);
  if (!parsed.success || !options.resolve || !options.isActive()) return denied;
  try {
    await authorizeGitRequestScope(parsed.data.workspace, parsed.data.sessionId, attached, options);
    const result = gitAccountOperationResultSchema.parse(
      await options.resolve(parsed.data.workspace, parsed.data, options.isActive),
    );
    return options.isActive() ? result : denied;
  } catch {
    return denied;
  }
}
