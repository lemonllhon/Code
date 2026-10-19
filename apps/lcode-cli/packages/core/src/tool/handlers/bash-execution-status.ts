import type { BashOutput } from "@lcode/contracts";

/** Goal 事件与持久记忆证据使用同一解释；后台启动、取消和超时都不是成功退出。 */
export function bashExecutionStatus(result?: BashOutput): {
  exitCode: number | null;
  cancelled: boolean;
} {
  const cancelled =
    result?.cancelled === true || result?.interrupted === true || result?.status === "cancelled";
  const incomplete =
    cancelled ||
    result?.timedOut ||
    result?.status === "timed_out" ||
    result?.status === "backgrounded" ||
    result?.status === "spawn_error";
  return { exitCode: incomplete ? null : (result?.exitCode ?? null), cancelled };
}
