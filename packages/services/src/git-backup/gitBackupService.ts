import { createGitBackupResultRecorder } from "./gitBackupResults.js";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { acquireFileLock } from "@lcode/shared/node";
import { createServiceLogger } from "../logger/serviceLogger.js";
import type {
  GitBackupManifest,
  GitBackupConfig,
  GitBackupProvider,
  GitBackupDestinationResult,
  GitBackupMinioConfig,
  GitBackupOssConfig,
  GitBackupWorkspaceTarget,
  GitBackupManifestEntry,
  IGitBackupService,
} from "./gitBackup.js";
import {
  gitBackupWorkspaceKey,
  getSelectedGitBackupProviders,
  getGitBackupDestinationLocation,
} from "./gitBackup.js";
import { ensureKeyPair, readPrivateKey } from "./gitBackupEncryption.js";
import { testOssConnection, type OssRequestOptions } from "./gitBackupOssClient.js";
import { testMinioConnection } from "./gitBackupMinioClient.js";
import { backupDestinationFailure } from "./gitBackupDestinations.js";
import type { GitBackupSnapshotOptions } from "./gitBackupSnapshot.js";
import { createGitBackupLifecycle } from "./gitBackupLifecycle.js";
import { createBackupStateStore, type BackupSourcePort } from "../backup/node.js";
import {
  createBackupStore,
  validateBackupTarget,
  type GitBackupAdmission,
  type BackupCredentials,
} from "./gitBackupStore.js";

export interface GitBackupServiceOptions extends OssRequestOptions, GitBackupSnapshotOptions {
  credentialService?: BackupCredentials;
  schedulerPollMs?: number;
  providerBackupSource?: BackupSourcePort;
}

export type GitBackupServiceRuntime = IGitBackupService & { dispose(): void };

export function createGitBackupService(
  dataDir: string,
  options: GitBackupServiceOptions = {},
): GitBackupServiceRuntime {
  const lifecycleState = createBackupStateStore(dataDir);
  const store = createBackupStore(dataDir, options.credentialService, {
    hasLocalDestination: () => lifecycleState((state) => state.policy.localEnabled),
  });
  const logger = createServiceLogger("git-backup");
  let schedulerFailureLogged = false;
  const now = options.now ?? Date.now;
  let disposed = false;
  let polling = false;

  async function executionLock(): Promise<(() => Promise<void>) | null> {
    await mkdir(dataDir, { recursive: true });
    try {
      // 活跃进程锁不会按时间过期；非阻塞申请避免多个 Host 排队重复执行同一周期。
      return await acquireFileLock(join(dataDir, "git-backup-execution"), [10], 100, 30);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "LCODE_FILE_LOCK_TIMEOUT") return null;
      throw error;
    }
  }

  const recordResults = createGitBackupResultRecorder(store);

  async function backup(
    target: GitBackupWorkspaceTarget,
    provider?: GitBackupProvider,
    onFailure?: (
      config: GitBackupConfig | undefined,
      results: GitBackupDestinationResult[],
      message: string,
    ) => void,
  ): Promise<GitBackupManifest> {
    await store.updateState((state) => ({
      ...state,
      running: true,
      error: null,
      errorProviders: [],
    }));
    let admission: GitBackupAdmission | undefined;
    let results: GitBackupDestinationResult[] = [];
    const attemptedAt = new Date(now()).toISOString();
    let recorded = false;
    try {
      admission = await store.loadAdmission(provider);
      const hasLocal = await lifecycleState((state) => state.policy.localEnabled);
      if (!admission.destinations.length && !hasLocal)
        throw new Error("Backup destinations are not configured or no destination is selected");
      const ready = admission.destinations.filter((destination) => destination.config);
      if (!ready.length && !hasLocal)
        throw backupDestinationFailure(
          admission.destinations.map((destination) => ({
            provider: destination.provider,
            ok: false,
            error: destination.error,
          })),
        );
      const admittedStores = await lifecycle.admittedDestinations(admission, Boolean(provider));
      const snapshot = await lifecycle.git.capture(undefined, target);
      const entries = (snapshot.data as { files: GitBackupManifestEntry[] }).files.map(
        ({ path, size, sha256, mode }) => ({ path, size, sha256, mode }),
      );
      const manifest: GitBackupManifest = {
        version: "repo_backup_manifest/v1",
        ...target,
        createdAt: attemptedAt,
        totalFiles: entries.length,
        totalSize: entries.reduce((sum, entry) => sum + entry.size, 0),
        entries,
      };
      const outcome = await lifecycle.capture(
        {
          kind: "git",
          target,
          operationId: randomUUID(),
          ...(provider ? { locations: [provider] } : {}),
        },
        snapshot,
        admittedStores,
      );
      manifest.createdAt =
        outcome.results.find((result) => result.version)?.version?.createdAt ?? manifest.createdAt;
      manifest.skipped = outcome.results.every((result) => result.status === "skipped-unchanged");
      results = outcome.results
        .filter((result) => result.location !== "local")
        .map((result) => ({
          provider: result.location as GitBackupProvider,
          ok: result.status !== "failed",
          skipped: result.status === "skipped-unchanged",
          error: result.error,
        }));
      const localFailure = outcome.results.find(
        (result) => result.location === "local" && result.status === "failed",
      );
      await recordResults(
        admission,
        target,
        attemptedAt,
        results,
        manifest,
        outcome.results.find((result) => result.location === "local"),
      );
      recorded = true;
      if (localFailure) throw new Error(localFailure.error || "Local backup failed");
      if (results.some((result) => !result.ok)) throw backupDestinationFailure(results);
      return manifest;
    } catch (error) {
      if (!recorded && admission?.destinations.length) {
        results = admission.destinations.map((destination) => ({
          provider: destination.provider,
          ok: false,
          error:
            destination.error ?? (error instanceof Error ? error.message : "Git backup failed"),
        }));
        await recordResults(admission, target, attemptedAt, results);
      } else if (!recorded) {
        await store.updateState((state) => ({
          ...state,
          running: false,
          error: error instanceof Error ? error.message : "Git backup failed",
        }));
      }
      onFailure?.(
        admission?.config,
        results,
        error instanceof Error ? error.message : "Git backup failed",
      );
      throw error;
    }
  }

  async function poll(): Promise<void> {
    if (disposed || polling) return;
    polling = true;
    let release: (() => Promise<void>) | null = null;
    try {
      const initial = await store.loadConfig();
      const initialState = await store.loadState();
      schedulerFailureLogged = false;
      if (!initial.enabled || !initial.workspaces.length) return;
      if (initialState.nextDueAt !== null && initialState.nextDueAt > now()) return;
      release = await executionLock();
      if (!release || disposed) return;
      const config = await store.loadConfig();
      const state = await store.loadState();
      if (
        !config.enabled ||
        (!getSelectedGitBackupProviders(config).length &&
          !(await lifecycleState((state) => state.policy.localEnabled))) ||
        !config.workspaces.length ||
        (state.nextDueAt !== null && state.nextDueAt > now())
      )
        return;
      const cycleStarted = now();
      const failures: Array<{
        config?: GitBackupConfig;
        results: GitBackupDestinationResult[];
        message: string;
      }> = [];
      for (const target of config.workspaces) {
        // 停止只允许已开始的运行完成；每个下一个目标 admission 前重新读取权威配置。
        const fresh = await store.loadConfig();
        if (disposed || !fresh.enabled) break;
        const currentTarget = fresh.workspaces.find(
          (item) => gitBackupWorkspaceKey(item) === gitBackupWorkspaceKey(target),
        );
        if (!currentTarget) continue;
        const previousFailures = failures.length;
        try {
          await backup(currentTarget, undefined, (config, results, message) => {
            failures.push({ config, results, message });
          });
        } catch (error) {
          // 仅已记录的备份失败可继续下个工作区；持久化失败必须交给周期错误处理。
          if (failures.length === previousFailures) throw error;
        }
      }
      await store.updateState((latest, current) => {
        // 周期结束时配置可能再次变化，不能把先前工作区的旧位置错误重新写回来。
        const validFailures = failures.flatMap((failure) => {
          if (!failure.config || !failure.results.length)
            return [{ message: failure.message, providers: [] as GitBackupProvider[] }];
          const results = failure.results.filter(
            (result) =>
              !result.ok &&
              getGitBackupDestinationLocation(failure.config![result.provider]) ===
                getGitBackupDestinationLocation(current[result.provider]),
          );
          return results.length
            ? [
                {
                  message: backupDestinationFailure(results).message,
                  providers: results.map((result) => result.provider),
                },
              ]
            : [];
        });
        return {
          ...latest,
          running: false,
          ...(validFailures.length
            ? {
                error: `${validFailures.length} workspace backup(s) failed: ${validFailures.map((failure) => failure.message).join("; ")}`,
                errorProviders: [...new Set(validFailures.flatMap((failure) => failure.providers))],
              }
            : {}),
          nextDueAt: current.enabled
            ? Math.max(now(), cycleStarted) + current.intervalMinutes * 60_000
            : null,
        };
      });
    } catch (error) {
      if (!schedulerFailureLogged) {
        // 未持有执行锁时不能写另一 owner 状态；只记录无凭据和路径的诊断。
        logger.warn(undefined, "Scheduler could not read or process backup state");
        schedulerFailureLogged = true;
      }
      if (release)
        await store
          .updateState((state) => ({
            ...state,
            running: false,
            error: error instanceof Error ? error.message : "Git backup scheduler failed",
          }))
          .catch(() => undefined);
    } finally {
      await release?.();
      polling = false;
    }
  }

  const lifecycle = createGitBackupLifecycle(dataDir, store, options, executionLock);
  const runPoll = async () => {
    if (disposed) return;
    await lifecycle.resumeDeletes().catch(() => {
      if (!disposed) logger.warn(undefined, "Incomplete backup deletion could not resume");
    });
    await lifecycle.tickProviders().catch(() => {
      if (!disposed) logger.warn(undefined, "Provider backup check failed");
    });
    await poll();
  };
  const timer = setInterval(() => {
    void runPoll();
  }, options.schedulerPollMs ?? 5_000);
  timer.unref();
  void runPoll();
  return {
    ...lifecycle.service,
    configure(partial, workspace, configureOptions) {
      return store.configure(partial, workspace, now(), configureOptions);
    },
    removeWorkspace(target) {
      return store.removeWorkspace(target);
    },
    async getConfig() {
      const config = await store.loadConfig();
      return (await lifecycleState((state) => state.policy.localEnabled))
        ? { ...config, localEnabled: true }
        : config;
    },
    async getStatus() {
      const state = await store.loadState();
      if (state.running) {
        const release = await executionLock();
        if (release) {
          try {
            // 崩溃后的持久化 running 只能在确认没有活跃执行锁时清理，不能靠超时猜测。
            await store.updateState((current) =>
              current.running
                ? { ...current, running: false, error: "Previous Git backup was interrupted" }
                : current,
            );
          } finally {
            await release();
          }
        }
      }
      return store.getStatus();
    },
    async startBackup(workspacePath, workspaceIdentity, provider) {
      if (disposed) throw new Error("Git backup service is disposed");
      const target = validateBackupTarget({ workspacePath, workspaceIdentity });
      const release = await executionLock();
      if (!release) throw new Error("A Git backup is already running for this profile");
      try {
        return await backup(target, provider);
      } finally {
        await release();
      }
    },
    stopBackup() {
      return store.configure({ enabled: false }, undefined, now());
    },
    async testConnection(config, provider = "oss") {
      try {
        const resolved = await store.resolveDestination(provider, config);
        return provider === "minio"
          ? await testMinioConnection(resolved as GitBackupMinioConfig, options)
          : await testOssConnection(resolved as GitBackupOssConfig, options);
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : "Backup connection failed",
        };
      }
    },
    exportPrivateKey() {
      return readPrivateKey(dataDir);
    },
    async getPublicKey() {
      return (await ensureKeyPair(dataDir)).publicKey;
    },
    hasCompletedOnboarding() {
      return store.hasCompletedOnboarding();
    },
    markOnboardingComplete() {
      return store.markOnboardingComplete();
    },
    dispose() {
      disposed = true;
      clearInterval(timer);
      lifecycle.dispose();
    },
  };
}
