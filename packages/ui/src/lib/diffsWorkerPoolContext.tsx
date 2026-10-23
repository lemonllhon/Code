import { createContext, type ReactNode, useContext, useEffect, useSyncExternalStore } from "react";
import type { WorkerPoolManager } from "@pierre/diffs/worker";
import type { DiffsWorkerPoolOwner } from "./diffsWorkerPoolOwner.js";

export const LeaseContext = createContext<DiffsWorkerPoolOwner<WorkerPoolManager> | undefined>(
  undefined,
);

/** 只 gate 第三方查看器，不重挂 Root、批注状态或用户草稿。 */
export function DiffsWorkerLease({
  children,
  fallback,
  enabled = true,
}: {
  children: ReactNode;
  fallback: ReactNode;
  enabled?: boolean;
}) {
  const owner = useContext(LeaseContext);
  return owner && enabled ? (
    <ActiveDiffsWorkerLease owner={owner} fallback={fallback}>
      {children}
    </ActiveDiffsWorkerLease>
  ) : (
    <>{children}</>
  );
}

function ActiveDiffsWorkerLease({
  owner,
  children,
  fallback,
}: {
  owner: DiffsWorkerPoolOwner<WorkerPoolManager>;
  children: ReactNode;
  fallback: ReactNode;
}) {
  const { ready } = useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot);
  useEffect(() => owner.acquire(), [owner]);
  return <>{ready ? children : fallback}</>;
}
