import { useCallback, useEffect, useRef, useState } from "react";
import type { AppUsageRange, AppUsageSnapshot } from "@lcode/shared";
import { logger } from "@/logger.js";
import { useServices } from "@/hooks/useServices.js";
import { useUsageModelAliases } from "./useUsageModelAliases.js";

interface AppUsageStatsState {
  snapshot: AppUsageSnapshot | null;
  loading: boolean;
  error: string | null;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name || String(error);
  }
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) {
      return message;
    }
  }
  return String(error);
}

export function useAppUsageStats(range: AppUsageRange) {
  const modelAliases = useUsageModelAliases();
  const { usageStatsService } = useServices();
  const key = JSON.stringify({ range, modelAliases });
  const [state, setState] = useState<
    AppUsageStatsState & { service: typeof usageStatsService; key: string }
  >({
    service: usageStatsService,
    key,
    snapshot: null,
    loading: false,
    error: null,
  });
  const requestVersionRef = useRef(0);

  const refresh = useCallback(async () => {
    const requestVersion = requestVersionRef.current + 1;
    requestVersionRef.current = requestVersion;
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    setState((current) => ({
      service: usageStatsService,
      key,
      snapshot:
        current.service === usageStatsService && current.key === key ? current.snapshot : null,
      loading: true,
      error: null,
    }));
    try {
      const snapshot = await usageStatsService.getAppUsageSnapshot({
        range,
        timeZone,
        connectionType: "api-key",
        modelAliases,
      });
      if (requestVersionRef.current !== requestVersion) {
        return;
      }
      setState({ service: usageStatsService, key, snapshot, loading: false, error: null });
    } catch (error) {
      if (requestVersionRef.current !== requestVersion) {
        return;
      }
      const message = getErrorMessage(error);
      logger.warn("[useAppUsageStats] 读取本地使用统计失败", {
        range,
        timeZone,
        error: message,
      });
      setState((current) => ({
        service: usageStatsService,
        key,
        snapshot:
          current.service === usageStatsService && current.key === key ? current.snapshot : null,
        loading: false,
        error: message,
      }));
    }
  }, [range, usageStatsService, modelAliases, key]);

  useEffect(() => {
    void refresh();
    return () => {
      requestVersionRef.current++;
    };
  }, [refresh]);

  // 别名或 Host 改变时首帧就隐藏旧投影，晚到请求由原版本栅栏拦截。
  return {
    ...(state.service === usageStatsService && state.key === key
      ? state
      : { snapshot: null, loading: true, error: null }),
    refresh,
  };
}
