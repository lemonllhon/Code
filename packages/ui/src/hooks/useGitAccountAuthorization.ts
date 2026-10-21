import { useCallback, useEffect, useRef, useState } from "react";
import {
  gitAuthorizationStatusSchema,
  type GitAuthorizationCommand,
  type GitAuthorizationStatus,
} from "@lcode/shared";
import { useBaseWorkspaceServices } from "./useWorkspaceServices.js";

export function useGitAccountAuthorization() {
  const { gitManagementService: service } = useBaseWorkspaceServices();
  const [status, setStatus] = useState<GitAuthorizationStatus | null>(null),
    [pending, setPending] = useState(false),
    [error, setError] = useState<string | null>(null);
  const epoch = useRef(0),
    active = useRef<string | null>(null),
    busy = useRef(false);
  const execute = useCallback(
    async (command: GitAuthorizationCommand) => {
      if (!service || busy.current) return null;
      const current = epoch.current;
      busy.current = true;
      setPending(true);
      setError(null);
      try {
        const next = gitAuthorizationStatusSchema.parse(await service.authorize(command));
        if (epoch.current !== current) return null;
        setStatus(next);
        return next;
      } catch (failure) {
        if (epoch.current === current)
          setError(
            failure instanceof Error &&
              /not a function|unknown.*method|method.*not.*found/i.test(failure.message)
              ? "oauth-unavailable"
              : "oauth-failed",
          );
        return null;
      } finally {
        if (epoch.current === current) {
          busy.current = false;
          setPending(false);
        }
      }
    },
    [service],
  );
  useEffect(() => {
    epoch.current++;
    active.current = null;
    busy.current = false;
    setPending(false);
    setStatus(null);
    setError(null);
    return () => {
      epoch.current++;
      const id = active.current;
      active.current = null;
      if (id && service) void service.authorize({ type: "cancel", requestId: id }).catch(() => {});
    };
  }, [service]);
  useEffect(() => {
    if (status?.status !== "pending" || pending || error) return;
    // OAuth 的服务端 interval/slow_down 决定查询节奏；Host 仍独立限制频率，UI 不承担授权事实。
    const timer = setTimeout(
      () => void execute({ type: "poll", requestId: status.requestId }),
      Math.max(1000, status.pollAfterMs),
    );
    return () => clearTimeout(timer);
  }, [status, pending, error, execute]);
  return {
    status,
    pending,
    error,
    start: (
      input: Omit<Extract<GitAuthorizationCommand, { type: "start" }>, "type" | "requestId">,
    ) => {
      if (busy.current) return Promise.resolve(null);
      const requestId = crypto.randomUUID();
      active.current = requestId;
      return execute({ type: "start", requestId, ...input });
    },
    retry: () =>
      active.current ? execute({ type: "poll", requestId: active.current }) : Promise.resolve(null),
    callback: (url: string) =>
      active.current
        ? execute({ type: "callback", requestId: active.current, url })
        : Promise.resolve(null),
    cancel: async () => {
      const id = active.current;
      epoch.current++;
      active.current = null;
      busy.current = false;
      setPending(false);
      setStatus(null);
      setError(null);
      if (id && service) await service.authorize({ type: "cancel", requestId: id }).catch(() => {});
    },
  };
}
