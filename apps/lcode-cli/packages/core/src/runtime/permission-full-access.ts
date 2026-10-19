import {
  PERMISSION_FULL_ACCESS_ENTRY,
  permissionFullAccessReceiptSchema,
  SessionEventType,
  type SessionEvent,
  type SessionModeChangedPayload,
  type SessionPermissionMode,
} from "@lcode/contracts";
import type { AgentRuntimeInternal } from "./internal.js";
import { buildExecutionStateEntry, readRuntimeExecutionState } from "./execution-state.js";
import {
  unpublishedPermissionGrants,
  recoverPendingPermissionGrant,
} from "./permission-grant-recovery.js";

const appliedGrants = new WeakMap<AgentRuntimeInternal, Set<string>>();

export async function grantPermissionFullAccess(
  this: AgentRuntimeInternal,
  interactionId: string,
  signal?: AbortSignal,
): Promise<string> {
  return setPermissionMode.call(this, "yolo", interactionId, signal);
}

/** 菜单与审批共用唯一事务；receipt 固定目标集合，重试不能扩大到后来队列。 */
export async function setPermissionMode(
  this: AgentRuntimeInternal,
  mode: SessionPermissionMode,
  interactionId: string,
  signal?: AbortSignal,
): Promise<string> {
  if (!["build", "edit", "yolo"].includes(mode) || !interactionId.trim())
    throw new Error("Invalid permission change");
  if (!this.sessionStore?.commitPermissionFullAccess) throw new Error("Full access is unsupported");
  if (
    this.permissionFullAccessPending ||
    this.pendingInputReservations.size > 0 ||
    this.pendingInputDrains
  ) {
    throw new Error("Queue mutation is busy; retry approval");
  }
  const unpublished = unpublishedPermissionGrants.get(this);
  if (unpublished && unpublished.interactionId !== interactionId)
    await recoverPendingPermissionGrant(this);
  this.permissionFullAccessPending = true;
  try {
    signal?.throwIfAborted();
    const receiptId = `${this.sessionId}:permission-full-access:${interactionId}`;
    const entries = await this.sessionStore.sessionEntries?.({
      sessionID: this.sessionId,
      type: PERMISSION_FULL_ACCESS_ENTRY,
    });
    const saved = entries?.find((entry) => entry.id === receiptId);
    let event: SessionEvent;
    if (saved) {
      const data = permissionFullAccessReceiptSchema.parse(saved.data);
      if (
        data.event.sessionId !== this.sessionId ||
        data.interactionId !== interactionId ||
        data.event.payload.mode !== mode
      ) {
        throw new Error("Permission receipt scope mismatch");
      }
      event = data.event as SessionEvent;
      // 冷恢复或旧命令重投时，已发布 receipt 只是幂等事实，不能覆盖后来的执行权限。
      if (
        !unpublished &&
        (await this.eventStore.getEvents(this.sessionId)).some((item) => item.id === event.id)
      ) {
        return String(event.id);
      }
    } else {
      const projection = await this.rebuildProjection();
      const queueItemIds = projection.pendingSteerInputs.map((item) => item.pendingInputId);
      const previous = readRuntimeExecutionState(this);
      const next = { ...previous, mode };
      event = this.createEvent(
        SessionEventType.SessionModeChanged,
        {
          ...next,
          previousMode: previous.mode,
          previousPlanEnabled: previous.planEnabled,
          source: "command",
          permissionGrant: { interactionId, queueItemIds },
        },
        this.rootTraceContext,
      );
      signal?.throwIfAborted();
      await this.sessionStore.commitPermissionFullAccess({
        sessionID: this.sessionId,
        queueItemIds,
        mode,
        signal,
        execution: buildExecutionStateEntry(this.sessionId, next),
        receipt: {
          id: receiptId,
          sessionID: this.sessionId,
          type: PERMISSION_FULL_ACCESS_ENTRY,
          touchSession: false,
          time: { created: Date.now(), updated: Date.now() },
          data: { interactionId, event },
        },
      });
    }
    const payload = event.payload as SessionModeChangedPayload;
    unpublishedPermissionGrants.set(this, {
      interactionId,
      recover: () => setPermissionMode.call(this, mode, interactionId),
    });
    const ids = new Set(payload.permissionGrant!.queueItemIds);
    // 事务已提交：之后即使传输取消也必须完成内存和投影发布，不能制造半个授权。
    const applied = appliedGrants.get(this) ?? new Set<string>();
    if (!applied.has(interactionId)) {
      this.lastPermissionGrantId = interactionId;
      this.lastPermissionGrantMode = mode;
      this.config.mode = payload.mode;
      this.config.planEnabled = payload.planEnabled;
      for (const item of this.activeTurn?.pendingInputs ?? []) {
        if (ids.has(item.id) && item.intent) item.intent = { ...item.intent, mode };
      }
      applied.add(interactionId);
      appliedGrants.set(this, applied);
    }
    const existing = (await this.eventStore.getEvents(this.sessionId)).find(
      (item) => item.id === event.id,
    );
    if (existing) await this.notifyEventSinks(existing, this.rootTraceContext);
    else await this.appendEvent(event, this.rootTraceContext);
    unpublishedPermissionGrants.delete(this);
    return String(event.id);
  } finally {
    this.permissionFullAccessPending = false;
  }
}
