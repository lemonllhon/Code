import {
  ServiceChannels,
  type GitManagementSnapshot,
  type GitManagementMutation,
  type GitManagementDetection,
  type GitAuthorizationCommand,
  type GitAuthorizationStatus,
  type GitRepositoryAuthenticationRequest,
  type GitRepositoryAccountBinding,
  type GitRepositoryAuthentication,
} from "@lcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/** 当前 Host 的加密 Git 配置；系统认证尝试由同一 profile/锁独占，失败仅由明确保存/重选恢复。查询不暴露秘密或尝试编号。 */
export interface IGitManagementService {
  getSnapshot(): Promise<GitManagementSnapshot>;
  mutate(request: GitManagementMutation): Promise<GitManagementSnapshot>;
  detect(): Promise<GitManagementDetection>;
  authorize(request: GitAuthorizationCommand): Promise<GitAuthorizationStatus>;
  getRepositoryAuthentication?(
    request: GitRepositoryAuthenticationRequest,
  ): Promise<GitRepositoryAuthentication>;
  bindRepositoryAuthentication?(
    request: GitRepositoryAccountBinding,
  ): Promise<GitRepositoryAuthentication>;
}
export const IGitManagementService = createServiceDescriptor<IGitManagementService>(
  ServiceChannels.GitManagement,
);
