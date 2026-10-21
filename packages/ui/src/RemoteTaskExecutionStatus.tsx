import type { LCodeTaskMeta } from "@lcode/shared";
import { getRemoteTaskExecutionState } from "@/lib/remoteTaskExecutionState.js";
import { cn } from "@/components/lib/utils.js";

export function RemoteTaskExecutionStatus({
  task,
  formatMessage,
}: {
  task: LCodeTaskMeta;
  formatMessage: (descriptor: { id: string }) => string;
}) {
  const state = getRemoteTaskExecutionState(task);
  if (!state) return null;
  return (
    <span
      role="status"
      data-task-execution-state={state}
      className={cn(
        "shrink-0 text-ui-xs",
        state === "failed"
          ? "text-destructive"
          : state === "completed"
            ? "text-success"
            : "text-foreground-subtle",
      )}
    >
      {formatMessage({ id: `taskList.remoteStatus.${state}` })}
    </span>
  );
}
