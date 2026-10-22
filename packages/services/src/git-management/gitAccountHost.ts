import {
  gitAccountOperationResultSchema,
  type GitAccountOperationRequest,
  type GitAccountOperationResult,
  type LCodeWorkspaceRef,
} from "@lcode/shared";
import type { GitManagementOwner } from "./gitManagementService.js";
import { gitAccountMatches, gitAuthenticationUrl } from "./gitAccountRouting.js";
import {
  resolveAuthorizedGitDirectory,
  type createHostGitCredentialResolver,
} from "./gitCredentialHost.js";

export function createHostGitAccountOperator(
  owner: GitManagementOwner,
  directories: Parameters<typeof createHostGitCredentialResolver>[1],
) {
  return async (
    scope: LCodeWorkspaceRef,
    request: GitAccountOperationRequest,
    isActive: () => boolean,
  ): Promise<GitAccountOperationResult> => {
    try {
      const operation = request.operation;
      const workspacePath = await resolveAuthorizedGitDirectory(
        operation.cwd,
        await directories(scope, request.sessionId),
      );
      const target = { workspacePath, workspaceIdentity: scope.workspaceIdentity };
      let snapshot = await owner.getRepositoryAuthentication!(target);
      const targetUrl = gitAuthenticationUrl(operation.url);
      const canonical = (value: string) => {
        const parsed = gitAuthenticationUrl(value);
        if (["http:", "https:"].includes(parsed.protocol)) parsed.username = "";
        return parsed.href.replace(/\/$/, "");
      };
      const targets = snapshot.remotes
        .flatMap((r) => r.urls)
        .filter((u) => canonical(u.url) === canonical(operation.url));
      const url =
        targets.find((u) => u.url === operation.url) ??
        (!targetUrl.username &&
        new Set(targets.map((u) => gitAuthenticationUrl(u.url).username).filter(Boolean)).size <= 1
          ? targets[0]
          : undefined);
      if (!url) throw new Error("git-account-remote-changed");
      const choices = snapshot.choices.filter(
        (c) =>
          gitAccountMatches(c, url.url) && (!url.usernameHint || c.username === url.usernameHint),
      );
      if (!isActive()) throw new Error("git-account-scope-unavailable");
      if (operation.action === "bind") {
        const matches = choices.filter(
          (c) =>
            c.username === operation.username && (!operation.auth || c.auth === operation.auth),
        );
        if (matches.length !== 1)
          throw new Error(
            matches.length ? "git-account-selection-required" : "git-account-selection-unavailable",
          );
        // 复用原 CAS 写入口；旧 client 在 profile 锁内提交前再次检查，不新增账号配置 owner。
        snapshot = await owner.bindRepositoryAuthentication!(
          {
            ...target,
            url: url.url,
            selection: matches[0]!.key,
            expectedRevision: operation.expectedRevision,
          },
          isActive,
        );
      }
      if (!isActive()) throw new Error("git-account-scope-unavailable");
      return gitAccountOperationResultSchema.parse({
        status: "ok",
        revision: snapshot.revision,
        choices: choices.map(({ username, auth, provider }) => ({ username, auth, provider })),
        repository: await owner.readRepositoryContext(target),
      });
    } catch (error) {
      const parsed = gitAccountOperationResultSchema.safeParse({
        status: "error",
        error: error instanceof Error ? error.message : "",
      });
      return parsed.success
        ? parsed.data
        : { status: "error", error: "git-account-repository-unavailable" };
    }
  };
}
