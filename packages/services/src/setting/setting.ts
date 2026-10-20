import type { AppSettings, ProjectMutationRequest, ProjectMutationResult } from "@lcode/shared";
import { ServiceChannels } from "@lcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface ISettingService {
  get(): Promise<AppSettings>;
  mutateProject(request: ProjectMutationRequest): Promise<ProjectMutationResult>;
  update(
    patch: Partial<AppSettings>,
    expectedAccountSettings?: Pick<
      AppSettings,
      "providerFamilyDomain" | "providerFamilyConnectionSelections"
    >,
  ): Promise<void>;
  /** Snapshot the full .lcode root (including SQLite/WAL data and artifacts) to an unused target, then persist for restart. */
  updateDataBaseDir(newDir: string | undefined): Promise<void>;
  ensureDefaultProject(homedir: string): Promise<{ path: string; created: boolean }>;
}

export const ISettingService = createServiceDescriptor<ISettingService>(ServiceChannels.Setting);
