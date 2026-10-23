// desktop main 侧的 cron scheduler 进程管理器。
// 职责：拉起/销毁常驻 scheduler 进程；把 scheduler 的派发请求路由给某个本地 host（转成 CronRun）；
// 把 host 回报的 CronRunResult 转回 scheduler 结算。scheduler 只碰 tasks-index，createTask 在 host 域执行。
import { HostMessageTypes } from "@lcode/shared";
import type { UtilityProcess as ElectronUtilityProcess } from "electron";
import { utilityProcess as electronUtilityProcess } from "electron";
import {
  schedulerToMainMessageSchema,
  type MainToSchedulerMessage,
} from "../scheduler/schedulerProtocol.js";
import { buildHostProcessEnv, schedulerModulePath } from "./desktopRuntimeEnv.js";
import { ingestSchedulerSelfResourceSample } from "./processResourceSelfHeapSource.js";
import { registerSchedulerProcess, unregisterSchedulerProcess } from "./resourceManagerWindow.js";

interface CronRunResultPayload {
  runId: string;
  ok: boolean;
  taskId?: string;
  sessionId?: string;
  error?: string;
  failureKind?: "transient" | "permanent";
}

interface CronSchedulerDeps {
  hostProcessLocalEnv: Record<string, string>;
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  /** 选一个能执行本地 workspace 派发的 host；无可用 host 时返回 null（scheduler 会退避重试）。 */
  resolveDispatchHost: () => ElectronUtilityProcess | null;
  onExit?: (idle: boolean) => void;
}

export interface CronSchedulerHandle {
  /** host 回报派发结果时调用，转交给 scheduler 结算。 */
  handleCronRunResult: (result: CronRunResultPayload) => void;
  /** manual run 落库后立即唤醒 scheduler，不等待下一次轮询。 */
  wake: (automationId: string) => void;
  /** app 退出前优雅收尾（通知 scheduler 释放认领 + 关库，兜底强杀）。 */
  dispose: () => Promise<void>;
}

const DISPOSE_FORCE_KILL_MS = 1_500;

export function spawnCronScheduler(deps: CronSchedulerDeps): CronSchedulerHandle {
  const child = electronUtilityProcess.fork(schedulerModulePath, [], {
    serviceName: "lcode-cron-scheduler",
    execArgv: ["--no-warnings"],
    env: {
      ...buildHostProcessEnv(deps.hostProcessLocalEnv),
      LCODE_PROCESS_LABEL: "scheduler",
    },
  });

  deps.logger.info(`[cron-scheduler] forked scheduler process pid=${child.pid}`);
  // 资源遥测的 scheduler 角色 pid 只有 spawn 点知道，这里登记到进程角色注册表。
  registerSchedulerProcess(child);
  let isDisposing = false;
  let disposePromise: Promise<void> | null = null;
  let exited = false;
  let idleExit = false;

  const postToScheduler = (message: MainToSchedulerMessage): void => {
    try {
      child.postMessage(message);
    } catch (error) {
      deps.logger.warn("[cron-scheduler] postMessage to scheduler failed:", error);
    }
  };

  child.on("message", (raw: unknown) => {
    const parsed = schedulerToMainMessageSchema.safeParse(raw);
    if (!parsed.success) return;
    const msg = parsed.data;
    if (msg.type === "scheduler-idle-exit") {
      idleExit = true;
      deps.logger.info("[cron-scheduler] idle; waiting for physical exit");
      return;
    }

    if (msg.type === "scheduler-log") {
      const level = msg.level === "warn" ? "warn" : msg.level === "error" ? "error" : "info";
      deps.logger[level](`[cron-scheduler] ${msg.message}`);
      return;
    }
    // scheduler 自采的 60 秒样本：main 只取 heap 作 scheduler 角色事件的 heap 维度，
    // 非法样本在入口按 schema 丢弃。
    if (msg.type === "scheduler-resource-sample") {
      ingestSchedulerSelfResourceSample(msg.sample);
      return;
    }

    if (msg.type === "cron-dispatch-request") {
      if (isDisposing) {
        // App 退出时 Cron 与 Host 并行收口；进入 disposing 后继续派发会把新任务
        // 发送给正在关闭的 Host。明确拒绝派发，避免为了保持串行而额外增加 1.5 秒退出延迟。
        postToScheduler({
          type: "cron-dispatch-result",
          runId: msg.runId,
          ok: false,
          failureKind: "transient",
          error: "app is shutting down",
        });
        return;
      }
      const host = deps.resolveDispatchHost();
      if (!host) {
        // 没有可派发的本地 host（无窗口/未就绪）：按 transient 回执，scheduler 退避后重试。
        postToScheduler({
          type: "cron-dispatch-result",
          runId: msg.runId,
          ok: false,
          failureKind: "transient",
          error: "no local host available",
        });
        return;
      }
      try {
        host.postMessage({
          type: HostMessageTypes.CronRun,
          automationId: msg.automationId,
          runId: msg.runId,
          prompt: msg.prompt,
          targetTaskId: msg.targetTaskId,
          modelSelection: msg.modelSelection,
          mode: msg.mode,
          workspacePath: msg.workspacePath,
          workspaceIdentity: msg.workspaceIdentity,
        });
      } catch (error) {
        deps.logger.warn("[cron-scheduler] forward CronRun to host failed:", error);
        postToScheduler({
          type: "cron-dispatch-result",
          runId: msg.runId,
          ok: false,
          failureKind: "transient",
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
  });

  child.on("exit", (code) => {
    exited = true;
    unregisterSchedulerProcess(child);
    deps.logger.info(`[cron-scheduler] scheduler process exited code=${code}`);
    deps.onExit?.(idleExit);
  });

  return {
    handleCronRunResult(result) {
      postToScheduler({ type: "cron-dispatch-result", ...result });
    },
    wake(automationId) {
      if (isDisposing) return;
      postToScheduler({ type: "scheduler-wake", automationId });
    },
    dispose() {
      if (exited) return Promise.resolve();
      if (disposePromise) return disposePromise;
      isDisposing = true;
      postToScheduler({ type: "scheduler-dispose" });
      disposePromise = new Promise<void>((resolve) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          try {
            child.kill();
          } catch {
            // 忽略。
          }
          done();
        }, DISPOSE_FORCE_KILL_MS);
        child.once("exit", done);
      });
      return disposePromise;
    },
  };
}
