import { RoutingError, type RoutingRecovery } from "@lcode/provider";

/** 目录拒绝可能早于 recovery.reserve；从同一 owner 补安全状态，不从 deadline 猜测原因。 */
export function apiKeyRecoveryError(
  error: unknown,
  recovery: RoutingRecovery,
  ids: readonly string[],
  resources: (id: string) => readonly string[],
  now: number,
): unknown {
  if (!(error instanceof RoutingError) || error.code !== "route-cooling") return error;
  const provider = recovery.blockingInfo(["provider"], now);
  if (provider)
    return new RoutingError("route-cooling", {
      ...error.details,
      ...provider,
      retryAt: provider.retryAt,
      scope: "provider",
      dispatch: "unsent",
    });
  let blocking: ReturnType<RoutingRecovery["blockingInfo"]>;
  const priority = { cooling: 0, probing: 1, uncertain: 2 };
  for (const id of ids) {
    const info = recovery.blockingInfo(resources(id), now);
    if (
      info?.recoveryState &&
      (!blocking?.recoveryState || priority[info.recoveryState] > priority[blocking.recoveryState])
    )
      blocking = info;
    if (blocking?.recoveryState === "uncertain") break;
  }
  return new RoutingError("route-cooling", {
    ...error.details,
    ...blocking,
    dispatch: "unsent",
    retryAt:
      blocking?.recoveryState === "cooling"
        ? Math.max(error.details.retryAt ?? 0, blocking.retryAt ?? 0) || undefined
        : blocking
          ? undefined
          : error.details.retryAt,
  });
}
