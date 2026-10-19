import type { MessageId } from "@lcode/contracts";
import type { MemoryExtractionScheduler, MemoryExtractionSnapshot } from "./extraction.js";
export type MemoryExtractionExecutionStatus =
  | "success"
  | "no-op"
  | "skipped"
  | "deferred"
  | "error"
  | "aborted";
const PENDING_EXTRACTION_LIMIT = 8;

export function createMemoryExtractionSchedulerInternal<
  TSnapshot extends MemoryExtractionSnapshot = MemoryExtractionSnapshot,
>(
  execute: (input: {
    abortSignal: AbortSignal;
    messageCount: number;
    snapshot: TSnapshot;
  }) => Promise<MemoryExtractionExecutionStatus>,
  options: { onOverflow?: (boundary?: MessageId) => void } | undefined,
  policy: {
    normalize(snapshot: TSnapshot): TSnapshot;
    decide(
      snapshot: TSnapshot,
      cursor?: MessageId,
    ): { decision: "run" | "skip"; messageCount: number };
  },
): MemoryExtractionScheduler<TSnapshot> {
  let cursor: MessageId | undefined;
  type Work = TSnapshot | Promise<TSnapshot> | (() => Promise<TSnapshot>);
  const pending: Work[] = [];
  let running: Promise<void> | undefined;
  let shuttingDown = false;
  const shutdownController = new AbortController();

  const processSnapshot = async (snapshot: TSnapshot): Promise<void> => {
    const safeSnapshot = policy.normalize(snapshot);
    const decision = snapshot.evidenceOnly
      ? { decision: "run", messageCount: 0 }
      : policy.decide(safeSnapshot, cursor);
    const snapshotEnd = snapshot.boundaryMessageId;

    if (decision.decision === "skip") {
      if (snapshotEnd) cursor = snapshotEnd;
      return;
    }

    let status: MemoryExtractionExecutionStatus;
    try {
      status = await execute({
        abortSignal: shutdownController.signal,
        messageCount: decision.messageCount,
        snapshot: safeSnapshot,
      });
    } catch {
      return;
    }

    if (
      !shuttingDown &&
      (status === "success" || status === "no-op" || status === "skipped") &&
      snapshotEnd
    ) {
      cursor = snapshotEnd;
    }
  };

  const run = async (first: Work): Promise<void> => {
    try {
      let current: Work | undefined = first;
      while (current && !shuttingDown) {
        const acquisition = await waitForSnapshotAcquisitionOrShutdown(
          acquireSnapshot(
            typeof current === "function" ? Promise.resolve().then(current) : current,
          ),
          shutdownController.signal,
        );
        if (acquisition.status === "shutdown" || shuttingDown) break;
        if (acquisition.status === "acquired") {
          try {
            await processSnapshot(acquisition.snapshot);
          } catch {
            // 本次 error 不推进 cursor；已完成的中间轮次仍按顺序处理，不能被新快照覆盖。
          }
        }
        current = shuttingDown ? undefined : pending.shift();
      }
    } finally {
      if (shuttingDown) pending.length = 0;
      running = undefined;
    }
  };

  return {
    async drain() {
      while (running) {
        await running;
      }
    },
    getCursor() {
      return cursor;
    },
    hasPendingWork() {
      return running !== undefined || pending.length > 0;
    },
    schedule(snapshot) {
      if (shuttingDown) return;
      // 旧调用方可传已启动的 Promise；立即挂错误处理，但排队描述符仍只在出队时执行读取。
      let work: Work = snapshot;
      if (snapshot instanceof Promise) {
        const settled = acquireSnapshot(snapshot);
        work = async () => {
          const result = await settled;
          if (result.status !== "acquired") throw new Error("Memory snapshot acquisition failed");
          return result.snapshot;
        };
      }
      if (running) {
        if (pending.length >= PENDING_EXTRACTION_LIMIT) {
          const dropped = pending.pop();
          options?.onOverflow?.(
            dropped && typeof dropped === "object" && "boundaryMessageId" in dropped
              ? dropped.boundaryMessageId
              : undefined,
          );
        }
        pending.push(work);
        return;
      }

      running = run(work);
    },
    shutdown() {
      if (shuttingDown) return;
      // LCode 关闭单个 session 后进程仍继续运行；旧 scheduler 只让调用方
      // 放弃等待，running/pending Extraction 仍可能继续请求模型和写 Memory。
      shuttingDown = true;
      pending.length = 0;
      shutdownController.abort();
    },
  };
}

type SnapshotAcquisition<TSnapshot> =
  | { status: "acquired"; snapshot: TSnapshot }
  | { status: "error" };

type SnapshotAcquisitionWait<TSnapshot> = SnapshotAcquisition<TSnapshot> | { status: "shutdown" };

function acquireSnapshot<TSnapshot>(
  snapshot: TSnapshot | Promise<TSnapshot>,
): Promise<SnapshotAcquisition<TSnapshot>> {
  return Promise.resolve(snapshot).then(
    (value) => ({ status: "acquired", snapshot: value }),
    () => ({ status: "error" }),
  );
}

function waitForSnapshotAcquisitionOrShutdown<TSnapshot>(
  acquisition: Promise<SnapshotAcquisition<TSnapshot>>,
  signal: AbortSignal,
): Promise<SnapshotAcquisitionWait<TSnapshot>> {
  if (signal.aborted) return Promise.resolve({ status: "shutdown" });

  return new Promise((resolve) => {
    const onAbort = (): void => {
      cleanup();
      resolve({ status: "shutdown" });
    };
    const cleanup = (): void => {
      signal.removeEventListener("abort", onAbort);
    };

    signal.addEventListener("abort", onAbort, { once: true });
    void acquisition.then((result) => {
      cleanup();
      resolve(result);
    });
  });
}
