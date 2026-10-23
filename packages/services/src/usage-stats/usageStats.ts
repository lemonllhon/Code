import type {
  AppUsageRequest,
  AppUsageSnapshot,
  ProviderUsageRequest,
  ProviderUsageSnapshot,
} from "@lcode/shared";
import { ServiceChannels } from "@lcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface IUsageStatsService {
  getAppUsageSnapshot(request: AppUsageRequest): Promise<AppUsageSnapshot>;
  getProviderUsageSnapshot(request: ProviderUsageRequest): Promise<ProviderUsageSnapshot>;
}

export const IUsageStatsService = createServiceDescriptor<IUsageStatsService>(
  ServiceChannels.UsageStats,
);
