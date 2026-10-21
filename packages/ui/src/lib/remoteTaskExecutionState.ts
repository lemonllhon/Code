import type { LCodeTaskMeta } from "@lcode/shared";
import type { WindowHostControllerTaskListItem } from "@lcode/services";
import { getTaskListAttention, getTaskListRowActivity } from "../v4/taskListRowActivity.js";

export function getTaskListSourceAvailability(task: LCodeTaskMeta) {
  return (task as Partial<WindowHostControllerTaskListItem>).sourceAvailability;
}

export function getRemoteTaskExecutionState(task: LCodeTaskMeta) {
  if (!task.workspaceIdentity?.trim()) return null;
  // 断连后 Controller 会保留可信历史行；冻结的 running/waiting 不能当作当前执行证明。
  if (getTaskListSourceAvailability(task) === "offline") return "offline";
  if (task.pendingInteraction || getTaskListAttention(task)) return null;
  const activity = getTaskListRowActivity(task);
  if (activity) {
    if (activity.phase === "error") return "failed";
    if (activity.phase === "prewarming") return "preparing";
    if (activity.phase === "running") return "running";
    if (activity.hasBackgroundWork) return "background";
    if (activity.phase === "completedSuccess") return "completed";
    if (activity.phase === "completedInterrupted") return "interrupted";
    return null;
  }
  // 历史终态可以读取；持久 running 只代表上次落盘，实时状态尚需 Controller 同步。
  if (task.status === "completed") return "completed";
  if (task.status === "error") return "failed";
  return task.status === "running" ? "syncing" : null;
}
