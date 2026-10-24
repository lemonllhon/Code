import { watch } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

type FailurePhase = "watch" | "refresh";
interface Options {
  filePath: string;
  initialRead?: boolean;
  onInvalidate: (signal: AbortSignal) => Promise<void>;
  onError: (error: unknown, phase: FailurePhase) => void;
}
interface Dependencies {
  createDirectory?: (directory: string) => Promise<void>;
  watchDirectory?: (
    directory: string,
    change: (filename: string | null) => void,
    error: (error: unknown) => void,
  ) => { close(): void };
}
export interface FileInvalidationWatch {
  /** 完成监听安装尝试；失败通过 onError 明确报告，不阻塞原 owner 的按需读取。 */
  ready: Promise<void>;
  dispose(): void;
}
const normalize = (path: string) => (process.platform === "win32" ? path.toLowerCase() : path);

class Subscriber {
  readonly controller = new AbortController();
  private dirty = false;
  private running = false;
  private refreshFailed = false;
  constructor(
    readonly filename: string,
    private readonly options: Options,
  ) {}

  invalidate(): void {
    if (this.controller.signal.aborted) return;
    this.dirty = true;
    if (!this.running) {
      this.running = true;
      void this.drain();
    }
  }
  private async drain(): Promise<void> {
    try {
      while (this.dirty && !this.controller.signal.aborted) {
        this.dirty = false;
        try {
          await this.options.onInvalidate(this.controller.signal);
          this.refreshFailed = false;
        } catch (error) {
          // 读取失败不是文件监听终止：继续接收后续失效，但连续失败只报告一次。
          if (!this.controller.signal.aborted && !this.refreshFailed) {
            this.refreshFailed = true;
            this.report(error, "refresh");
          }
        }
      }
    } finally {
      this.running = false;
    }
  }
  report(error: unknown, phase: FailurePhase): void {
    try {
      this.options.onError(error, phase);
    } catch {
      /* 诊断异常不能成为文件事件的未处理拒绝。 */
    }
  }
  dispose(): void {
    this.dirty = false;
    this.controller.abort();
  }
}

interface DirectoryOwner {
  clients: Set<Subscriber>;
  closed: boolean;
  handle?: { close(): void };
  ready: Promise<void>;
}
// 这里仅复用物理目录句柄；每个业务订阅保留自己的刷新/取消域，不缓存账号或会话状态。
const directories = new Map<string, DirectoryOwner>();

function closeDirectory(key: string, owner: DirectoryOwner, failure?: { error: unknown }): void {
  if (owner.closed) return;
  owner.closed = true;
  if (directories.get(key) === owner) directories.delete(key);
  owner.handle?.close();
  owner.handle = undefined;
  for (const subscriber of owner.clients) {
    subscriber.dispose();
    if (failure) subscriber.report(failure.error, "watch");
  }
  owner.clients.clear();
}

function nativeWatch(
  directory: string,
  change: (filename: string | null) => void,
  error: (error: unknown) => void,
) {
  const handle = watch(directory, { persistent: false }, (_kind, filename) => change(filename));
  handle.on("error", error);
  // close 与已经排入事件循环的 error 可能交错；保留受 owner.closed 保护的监听以接住迟到错误。
  return {
    close: () => {
      handle.close();
    },
  };
}

/** 文件事件只表示“快照已失效”，不能在等待业务 IO 时积累无界的文件事件队列。 */
export function watchFileInvalidation(
  options: Options,
  dependencies: Dependencies = {},
): FileInvalidationWatch {
  const path = resolve(options.filePath),
    directory = dirname(path),
    key = normalize(directory);
  let owner = directories.get(key);
  if (!owner) {
    const created: DirectoryOwner = { clients: new Set(), closed: false, ready: Promise.resolve() };
    owner = created;
    directories.set(key, created);
    created.ready = (async () => {
      try {
        // 先让调用方登记订阅；同步抛出的目录准备错误也必须通知到这一代订阅者。
        await Promise.resolve();
        await (
          dependencies.createDirectory ??
          (async (directory) => {
            await mkdir(directory, { recursive: true });
          })
        )(directory);
        if (created.closed) return;
        // Node 的 async-iterator watcher 先排队、后过滤；慢读取会使每次溢出都发 warning。
        // 回调同步过滤，读取独立串行并用 dirty 位合并，根除该队列与日志反馈放大。
        const handle = (dependencies.watchDirectory ?? nativeWatch)(
          directory,
          (filename) => {
            if (created.closed) return;
            const target = filename ? normalize(filename) : undefined;
            // 通知中允许退订或换代；固定接收者，不能让新订阅接收旧代事件。
            for (const subscriber of Array.from(created.clients))
              if (target === undefined || target === subscriber.filename) subscriber.invalidate();
          },
          (error) => closeDirectory(key, created, { error }),
        );
        if (created.closed) handle.close();
        else created.handle = handle;
      } catch (error) {
        closeDirectory(key, created, { error });
      }
    })();
  }
  const subscriber = new Subscriber(normalize(basename(path)), options);
  owner.clients.add(subscriber);
  const current = owner;
  if (options.initialRead)
    void current.ready.then(() => {
      if (!current.closed) subscriber.invalidate();
    });
  return {
    ready: current.ready,
    dispose() {
      subscriber.dispose();
      current.clients.delete(subscriber);
      if (!current.clients.size) closeDirectory(key, current);
    },
  };
}
