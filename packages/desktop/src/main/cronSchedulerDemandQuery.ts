import { randomUUID } from "node:crypto";
import { HostMessageTypes, hostCronSchedulerDemandResultSchema } from "@lcode/shared";

interface DemandHost {
  postMessage: (message: { type: string; requestId: string }) => void;
  on(event: "message", listener: (message: unknown) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  removeListener(event: "message", listener: (message: unknown) => void): unknown;
  removeListener(event: "exit", listener: (code: number) => void): unknown;
}

/** 查询只绑定本次 Host；退出、错误和超时均为 unknown，不能当作空库回收依据。 */
export function queryCronSchedulerDemand(host: DemandHost): Promise<boolean | null> {
  return new Promise((resolve, reject) => {
    const requestId = randomUUID();
    const cleanup = () => {
      clearTimeout(timer);
      host.removeListener("message", onMessage);
      host.removeListener("exit", onExit);
    };
    const fail = () => {
      cleanup();
      reject(new Error("Scheduler demand source unavailable"));
    };
    const onExit = fail;
    const onMessage = (raw: unknown) => {
      const parsed = hostCronSchedulerDemandResultSchema.safeParse(raw);
      if (!parsed.success || parsed.data.requestId !== requestId) return;
      if (parsed.data.demand === "unknown") {
        fail();
        return;
      }
      cleanup();
      resolve(parsed.data.demand === "not-ready" ? null : parsed.data.demand === "needed");
    };
    const timer = setTimeout(fail, 5_000);
    timer.unref();
    host.on("message", onMessage);
    host.on("exit", onExit);
    try {
      host.postMessage({ type: HostMessageTypes.CronSchedulerDemandQuery, requestId });
    } catch {
      fail();
    }
  });
}
