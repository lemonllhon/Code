import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { dirname } from "node:path";
import type { GitRepositoryRequest } from "@lcode/shared";
import type { CheckoutCoordinator } from "../worktree/node.js";
import type { IGitService } from "./git.js";
import {
  gitAcquireRepositoryRequestSchema,
  gitCompleteOperationRequestSchema,
  gitSaveConflictRequestSchema,
  gitMarkConflictRequestSchema,
  gitIntegrationActionRequestSchema,
} from "@lcode/shared";
import { gitOperationKey } from "./gitNetworkJournal.js";

const mutations = new Set<keyof IGitService>([
  "switchBranch",
  "createBranchAndSwitch",
  "deleteBranch",
  "stagePaths",
  "unstagePaths",
  "discardPaths",
  "commit",
  "commitAndSwitchBranch",
  "push",
  "createTag",
  "mutateRemote",
  "setBranchTracking",
  "fetchRemotes",
  "fastForward",
  "acquireRepository",
  "saveStash",
  "applyStash",
  "dropStash",
  "completeGitOperation",
  "beginConflictResolution",
  "saveConflictResult",
  "markConflictResolved",
  "startIntegration",
  "continueIntegration",
  "abortIntegration",
  "createHistoryTag",
  "resetHistory",
]);
const repositoryOnly = new Set([
  "mutateRemote",
  "setBranchTracking",
  "fetchRemotes",
  "dropStash",
  "createHistoryTag",
]);
const filesOnly = new Set([
  "stagePaths",
  "unstagePaths",
  "discardPaths",
  "acquireRepository",
  "completeGitOperation",
]);
const receipted = new Set([
  "mutateRemote",
  "setBranchTracking",
  "fetchRemotes",
  "fastForward",
  "acquireRepository",
  "saveStash",
  "applyStash",
  "dropStash",
  "completeGitOperation",
  "beginConflictResolution",
  "saveConflictResult",
  "markConflictResolved",
  "startIntegration",
  "continueIntegration",
  "abortIntegration",
  "createHistoryTag",
  "resetHistory",
]);

/** 应用 Git mutation 与 Agent 整轮写入共用 checkout owner，读操作保持可并行。 */
export function coordinateGitCheckoutWrites(
  service: IGitService,
  coordinator: CheckoutCoordinator,
): IGitService {
  return new Proxy(service, {
    get(target, property, receiver) {
      const method = Reflect.get(target, property, receiver);
      if (!mutations.has(property as keyof IGitService) || typeof method !== "function")
        return method;
      return async (params: GitRepositoryRequest) => {
        const scope =
          property === "acquireRepository"
            ? gitAcquireRepositoryRequestSchema.parse(params).options
            : params;
        const requestId = (params as GitRepositoryRequest & { requestId?: string }).requestId;
        // 已有收据时只进入原 journal 校验参数并返回事实；冲突保留不能遮蔽同请求的已发生结果。
        if (
          receipted.has(String(property)) &&
          typeof requestId === "string" &&
          typeof target.getNetworkOperation === "function" &&
          (await target.getNetworkOperation({
            workspacePath: scope.workspacePath,
            workspaceIdentity: scope.workspaceIdentity,
            requestId,
          }))
        )
          return Reflect.apply(method, target, [params]);
        let path = scope.workspacePath;
        let allowReservationKey: string | undefined;
        if (
          [
            "completeGitOperation",
            "saveConflictResult",
            "markConflictResolved",
            "continueIntegration",
            "abortIntegration",
          ].includes(String(property))
        ) {
          const command =
            property === "saveConflictResult"
              ? gitSaveConflictRequestSchema.parse(params)
              : property === "markConflictResolved"
                ? gitMarkConflictRequestSchema.parse(params)
                : property === "continueIntegration" || property === "abortIntegration"
                  ? gitIntegrationActionRequestSchema.parse(params)
                  : gitCompleteOperationRequestSchema.parse(params);
          const query = {
            workspacePath: command.workspacePath,
            workspaceIdentity: command.workspaceIdentity,
            requestId: command.sourceRequestId,
          };
          const original = await target.getNetworkOperation(query);
          if (!original?.targetPath) throw new Error("Missing original Git operation");
          path = original.targetPath;
          if (original.kind === "repository-clone") {
            const exists = await lstat(path).catch((error: NodeJS.ErrnoException) => {
              if (error.code !== "ENOENT") throw error;
              return null;
            });
            if (!exists) path = dirname(path);
          }
          allowReservationKey = gitOperationKey(query);
        }
        // 用户命令不能在旧确认后排队写入；Agent/其它 Host 占用时明确 busy，重试需重新确认。
        const lease = await coordinator.acquire({
          // RPC 可携带类型外字段；展开请求会让 mode=shared 绕过独占 writer。
          workspacePath: path,
          workspaceIdentity: scope.workspaceIdentity,
          ownerId: `git:${randomUUID()}`,
          waitMs: 0,
          mode: "exclusive",
          ...(allowReservationKey ? { allowReservationKey } : {}),
          resource: repositoryOnly.has(String(property))
            ? "repository"
            : filesOnly.has(String(property))
              ? "checkout"
              : "repository-checkout",
        });
        let settled = true;
        try {
          const result = await Reflect.apply(method, target, [params]);
          // 原生命令未确认退出时仍可能写入；当前 Host 保留许可，不能只因 RPC 已返回就放行后继 writer。
          if (
            typeof result === "object" &&
            result !== null &&
            "unsettled" in result &&
            result.unsettled === true
          )
            settled = false;
          return result;
        } finally {
          if (settled) await coordinator.release(lease);
        }
      };
    },
  });
}
