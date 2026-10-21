import { realpath } from "node:fs/promises";
import type { GitAgentContext, LCodeWorkspaceRef } from "@lcode/shared";
import type { GitManagementOwner } from "./gitManagementService.js";
import type { createHostGitCredentialResolver } from "./gitCredentialHost.js";

export function createHostGitContextProvider(
  owner: Pick<GitManagementOwner, "readRepositoryContext">,
  allowedDirectories: Parameters<typeof createHostGitCredentialResolver>[1],
) {
  return async (scope: LCodeWorkspaceRef, sessionId: string): Promise<GitAgentContext> => {
    const directories = [...new Set(await allowedDirectories(scope, sessionId))];
    const repositories: Extract<GitAgentContext, { status: "available" }>["repositories"] = [];
    // 与认证复用同一目录授权来源；有界并发读取，单个源离线不会借用其他 Host。
    const read = async (path: string): Promise<(typeof repositories)[number]> => {
      try {
        const workspacePath = await realpath(path);
        return await owner.readRepositoryContext({
          workspacePath,
          workspaceIdentity: scope.workspaceIdentity,
        });
      } catch {
        return {
          workspacePath: path,
          revision: null,
          status: "unavailable",
          partial: false,
          remotes: [],
        };
      }
    };
    for (let offset = 0; offset < Math.min(directories.length, 20); offset += 4)
      repositories.push(
        ...(await Promise.all(directories.slice(offset, Math.min(offset + 4, 20)).map(read))),
      );
    return { status: "available", repositories, partial: directories.length > 20 };
  };
}
