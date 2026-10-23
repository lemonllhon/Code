import { watch, type FSWatcher } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { RoutingError, type SharedQuotaInput } from "@lcode/provider";
import { sharedInputSchema, type SharedQuotaState } from "./api-key-shared-quota-state.js";

export function waitForSharedQuotaCapacity(
  input: Pick<SharedQuotaInput, "providerId" | "poolId" | "keyId" | "maxInFlight">,
  signal: AbortSignal,
  host: {
    directory: string;
    now(): number;
    read<T>(key: string, project: (state: SharedQuotaState) => T): Promise<T>;
  },
): Promise<void> {
  const parsed = sharedInputSchema
    .pick({ providerId: true, poolId: true, keyId: true, maxInFlight: true })
    .parse(input);
  const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const poolKey = hash([parsed.providerId, parsed.poolId]),
    keyIdentity = hash(parsed.keyId);
  return waitForSharedApiKeyCapacity({
    directory: host.directory,
    filename: `${poolKey}.json`,
    signal,
    now: host.now,
    read: () =>
      host.read(poolKey, (state) => {
        const active = Object.values(state.leases).filter(
          (lease) =>
            lease.keyId === keyIdentity &&
            (lease.state === "reserved" || lease.state === "dispatched"),
        );
        const expiries = active
          .filter((lease) => lease.state === "reserved")
          .map((lease) => lease.expiresAt);
        return {
          available: active.length < parsed.maxInFlight,
          ...(expiries.length ? { expiresAt: Math.min(...expiries) } : {}),
        };
      }),
  });
}

/** 文件事件只唤醒原 owner 重读；不保存额度，不把 watcher 事件当作释放证明。 */
export async function waitForSharedApiKeyCapacity(input: {
  directory: string;
  filename: string;
  signal: AbortSignal;
  now(): number;
  read(): Promise<{ available: boolean; expiresAt?: number }>;
}): Promise<void> {
  input.signal.throwIfAborted();
  try {
    await mkdir(input.directory, { recursive: true, mode: 0o700 });
  } catch (cause) {
    throw new RoutingError("quota-owner-unavailable", { cause });
  }
  input.signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    let watcher: FSWatcher | undefined;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    let settled = false,
      reading = false,
      dirty = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      watcher?.close();
      clearTimeout(expiry);
      input.signal.removeEventListener("abort", cancel);
      if (error !== undefined) reject(error);
      else resolve();
    };
    const cancel = () => finish(input.signal.reason);
    const check = async () => {
      dirty = true;
      if (reading || settled) return;
      reading = true;
      try {
        do {
          dirty = false;
          const capacity = await input.read();
          if (settled) return;
          if (capacity.available) {
            finish();
            return;
          }
          clearTimeout(expiry);
          // 只按原未派发预留的真实 expiresAt 重读；dispatched 没有超时释放路径。
          if (capacity.expiresAt !== undefined)
            expiry = setTimeout(() => void check(), Math.max(1, capacity.expiresAt - input.now()));
        } while (dirty && !settled);
      } catch (cause) {
        finish(
          cause instanceof RoutingError
            ? cause
            : new RoutingError("quota-owner-unavailable", { cause }),
        );
      } finally {
        reading = false;
      }
    };
    try {
      // 先监听目录，再在文件锁内重读；兼容原子 rename 和订阅前已完成的释放。
      watcher = watch(input.directory, (_event, filename) => {
        if (filename === null || filename.toString() === input.filename) void check();
      });
      watcher.on("error", (cause) =>
        finish(new RoutingError("quota-owner-unavailable", { cause })),
      );
      input.signal.addEventListener("abort", cancel, { once: true });
      void check();
    } catch (cause) {
      finish(new RoutingError("quota-owner-unavailable", { cause }));
    }
  });
}
