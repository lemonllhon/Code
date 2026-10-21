import {
  ServiceChannels,
  type GitManagementSnapshot,
  type GitManagementMutation,
  type GitManagementDetection,
  type GitAuthorizationCommand,
  type GitAuthorizationStatus,
} from "@lcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/** 当前 Host 的加密 Git 配置；不通过查询接口暴露令牌。 */
export interface IGitManagementService {
  getSnapshot(): Promise<GitManagementSnapshot>;
  mutate(request: GitManagementMutation): Promise<GitManagementSnapshot>;
  detect(): Promise<GitManagementDetection>;
  authorize(request: GitAuthorizationCommand): Promise<GitAuthorizationStatus>;
}
export const IGitManagementService = createServiceDescriptor<IGitManagementService>(
  ServiceChannels.GitManagement,
);
