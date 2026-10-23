import type { DynamicWorkflowClientConfig, ForceUpdateConfig } from "@lcode/shared";
import { ServiceChannels } from "@lcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface IApplicationConfigService {
  getDynamicWorkflowClientConfig(options?: {
    forceRefresh?: boolean;
  }): Promise<DynamicWorkflowClientConfig>;
  getForceUpdateConfig(): Promise<ForceUpdateConfig | null>;
}

export const IApplicationConfigService = createServiceDescriptor<IApplicationConfigService>(
  ServiceChannels.ApplicationConfig,
);
