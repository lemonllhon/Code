import { useCallback, useEffect, useRef, useState } from "react";
import type { IServiceAccessor } from "@lcode/services";
import {
  gitManagementSnapshotSchema,
  gitManagementDetectionSchema,
  type GitManagementSnapshot,
  type GitManagementDetection,
  type GitManagementMutation,
} from "@lcode/shared";
import { useBaseWorkspaceServices } from "./useWorkspaceServices.js";

/** 设置默认读取 Base Host，项目仓库向导显式使用其来源 Host；断连时不能借本地账号回落。 */
export function useGitManagement({
  autoDetect = false,
  services,
}: { autoDetect?: boolean; services?: IServiceAccessor } = {}) {
  const baseServices = useBaseWorkspaceServices();
  const { gitManagementService: service } = services ?? baseServices;
  const [snapshot, setSnapshot] = useState<GitManagementSnapshot | null>(null),
    [detection, setDetection] = useState<GitManagementDetection | null>(null);
  const [pending, setPending] = useState(false),
    [error, setError] = useState<string | null>(null);
  const [detecting, setDetecting] = useState(false),
    [detectionError, setDetectionError] = useState<string | null>(null);
  const epoch = useRef(0),
    busy = useRef(false);
  const detectionRequest = useRef(0),
    detectionBusy = useRef(false);
  const detect = useCallback(async () => {
    if (!service || detectionBusy.current) return;
    const current = epoch.current,
      request = ++detectionRequest.current;
    detectionBusy.current = true;
    setDetecting(true);
    setDetectionError(null);
    try {
      const next = gitManagementDetectionSchema.parse(await service.detect());
      if (epoch.current === current && detectionRequest.current === request) setDetection(next);
    } catch {
      if (epoch.current === current && detectionRequest.current === request)
        setDetectionError("detectFailed");
    } finally {
      // 旧 Host 的请求完成后不能释放新 Host 的忙碌标记，也不能用检测错误覆盖保存结果。
      if (epoch.current === current && detectionRequest.current === request) {
        detectionBusy.current = false;
        setDetecting(false);
      }
    }
  }, [service]);
  useEffect(() => {
    const current = ++epoch.current;
    setSnapshot(null);
    setDetection(null);
    setError(null);
    setDetectionError(null);
    detectionBusy.current = false;
    setDetecting(false);
    busy.current = false;
    setPending(false);
    if (service)
      void service
        .getSnapshot()
        .then((v) => {
          if (epoch.current === current) setSnapshot(gitManagementSnapshotSchema.parse(v));
        })
        .catch(() => {
          if (epoch.current === current) setError("loadFailed");
        });
    if (autoDetect) void detect();
    return () => {
      epoch.current++;
    };
  }, [service, autoDetect, detect]);
  const reload = useCallback(async () => {
    if (!service || busy.current) return;
    const current = epoch.current;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      const next = gitManagementSnapshotSchema.parse(await service.getSnapshot());
      if (epoch.current === current) setSnapshot(next);
    } catch {
      if (epoch.current === current) setError("loadFailed");
    } finally {
      if (epoch.current === current) {
        busy.current = false;
        setPending(false);
      }
    }
  }, [service]);
  const mutate = async (
    request: GitManagementMutation,
    applied?: (next: GitManagementSnapshot) => void,
  ) => {
    if (!service || busy.current) return false;
    const current = epoch.current;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      const next = gitManagementSnapshotSchema.parse(await service.mutate(request));
      if (epoch.current !== current) return false;
      setSnapshot(next);
      applied?.(next);
      return true;
    } catch (failure) {
      if (epoch.current === current) {
        const text = failure instanceof Error ? failure.message : "";
        setError(
          text.includes("oauth-invalid")
            ? "oauth-invalid"
            : text.includes("oauth-expired")
              ? "oauth-expired"
              : text.includes("revision-conflict")
                ? "conflict"
                : text.includes("token-required")
                  ? "tokenRequired"
                  : "saveFailed",
        );
      }
      return false;
    } finally {
      if (epoch.current === current) {
        busy.current = false;
        setPending(false);
      }
    }
  };
  return {
    snapshot,
    detection,
    pending,
    error,
    detecting,
    detectionError,
    available: Boolean(service),
    mutate,
    detect,
    reload,
    async selectDetected(candidateId: string) {
      const candidate = detection?.accounts.find((a) => a.candidateId === candidateId);
      if (!candidate || !snapshot) return null;
      let reference: { id: string; revision: string } | null = null;
      await mutate({ type: "import", expectedRevision: snapshot.revision, candidateId }, (next) => {
        const account = next.accounts.find(
          (a) =>
            a.serverUrl === candidate.serverUrl &&
            a.username === candidate.username &&
            a.auth === candidate.auth &&
            a.privateKeyPath === candidate.privateKeyPath,
        );
        if (account) reference = { id: account.id, revision: account.revision };
      });
      return reference;
    },
  };
}
