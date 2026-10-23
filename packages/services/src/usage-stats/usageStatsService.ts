import type { AppUsageRequest, AppUsageSnapshot } from "@lcode/shared";
import { providerUsageRequestSchema, providerUsageSnapshotSchema } from "@lcode/shared";
import type { ILCodeAgentService } from "../lcode-agent/lcodeAgent.js";
import type { IUsageStatsService } from "./usageStats.js";

interface UsageStatsServiceDependencies {
  /** App Usage 经 LCode Protocol 读取 agent 数据库真实统计。 */
  lcodeAgentService: Pick<ILCodeAgentService, "getAppUsageStats"> &
    Partial<Pick<ILCodeAgentService, "getProviderUsageStats">>;
}

export function createUsageStatsService(
  dependencies: UsageStatsServiceDependencies,
): IUsageStatsService {
  return {
    async getProviderUsageSnapshot(request) {
      const query = providerUsageRequestSchema.parse(request);
      if (!dependencies.lcodeAgentService.getProviderUsageStats)
        throw new Error("provider_usage_unavailable");
      return providerUsageSnapshotSchema.parse(
        await dependencies.lcodeAgentService.getProviderUsageStats(query),
      );
    },
    async getAppUsageSnapshot(request: AppUsageRequest): Promise<AppUsageSnapshot> {
      // App Usage 现读取 agent 数据库真实统计（model_usage/turn_usage/tool_usage），
      // 经 LCode Protocol usage/stats 取回。不再读本地 session JSON 估算。
      return dependencies.lcodeAgentService.getAppUsageStats({
        range: request.range,
        timeZone: request.timeZone,
        connectionType: request.connectionType,
      });
    },
  };
}
