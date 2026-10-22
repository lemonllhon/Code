import { realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import type { GitCredentialRequest, GitCredentialResult, LCodeWorkspaceRef } from "@lcode/shared";
import type { GitManagementOwner } from "./gitManagementService.js";
import { gitAuthenticationUrl } from "./gitAccountRouting.js";

export async function resolveAuthorizedGitDirectory(cwd: string, allowed: string[]) {
  const directory = await realpath(cwd);
  const roots = await Promise.all(allowed.map((p) => realpath(p).catch(() => null)));
  if (
    !roots.some((root) => {
      if (root === null) return false;
      const part = relative(root, directory);
      return part !== ".." && !part.startsWith(".." + sep) && !isAbsolute(part);
    })
  )
    throw new Error("git-account-scope-unavailable");
  return directory;
}

export function createHostGitCredentialResolver(
  owner: GitManagementOwner,
  allowedDirectories: (scope: LCodeWorkspaceRef, sessionId: string) => Promise<string[]>,
) {
  return async (
    scope: LCodeWorkspaceRef,
    request: GitCredentialRequest,
  ): Promise<GitCredentialResult> => {
    try {
      const protocol = gitAuthenticationUrl(request.url).protocol;
      if (
        (request.transport === "ssh") !== (protocol === "ssh:") ||
        !["https:", "http:", "ssh:"].includes(protocol)
      )
        throw new Error("git-account-invalid-url");
      const cwd = await resolveAuthorizedGitDirectory(
        request.cwd,
        await allowedDirectories(scope, request.sessionId),
      );
      // 中文依据：cwd 只用于文件/仓库解析，identity 来自已授权的 workspace；远端不能回落本机 profile。
      return await owner.repositoryCredential(
        { workspacePath: cwd, workspaceIdentity: scope.workspaceIdentity },
        request.url,
      );
    } catch (error) {
      const text = error instanceof Error ? error.message : "";
      return {
        kind: "error",
        error: /^git-account-[a-z-]+$/.test(text) ? text : "git-account-credential-unavailable",
      };
    }
  };
}
