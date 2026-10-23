// Main 平台装配的窄入口；只转出原实现，不创建第二套 Service/Repo owner。
export {
  setDataBaseDir,
  getDataBaseDir,
  getLCodeDataRootDir,
  getConversationWorkspaceDir,
  getAppConfigDir,
  getExportLogStageDir,
  getExportLogDir,
  getFeedbackLogArchiveDir,
  LCODE_WINDOWS_APP_INSTALL_DIR_ENV,
} from "./paths.js";
export { maybeThrowInjectedFsFault } from "./fs/fsFaultInjection.js";
export { listSSHConfigAliasesFromLocalConfig } from "./system/sshConfigAlias.js";
export { createSettingService } from "./setting/settingService.js";
export { createCredentialService } from "./credential/credentialService.js";
export {
  readLCodeStdioTapDevState,
  setLCodeStdioTapDevEnabled,
} from "./lcode-agent/lcodeStdioTapDevConfig.js";
export {
  createCuaHelperInstaller,
  type CuaHelperInstaller,
  type CuaHelperInstallerOptions,
} from "./cua-permission-broker/index.js";
export {
  canonicalizeCuaHelperInstallerOptions,
  normalizeCuaHelperArch,
  normalizeCuaHelperArchs,
} from "./cua-permission-broker/cuaHelperInstaller.js";
export { LCODE_CUA_BUNDLED_HELPER_APP_PATH_ENV } from "./cua-permission-broker/helperEnvironment.js";
export { createTelemetryCore } from "./telemetry/telemetryCore.js";
export {
  createTelemetryUserIdLoader,
  createTelemetryAuthorizationLoader,
  createTelemetryMarketingParamsLoader,
} from "./telemetry/credentialLoaders.js";
export { createStorageService } from "./storage/app/storageService.js";
export { createRuntimePackageCacheCleaner } from "./runtime-environment/node.js";
export { createFsStorageCleaner } from "./storage/adapters/fsCleaner.js";
export { createStorageRootsResolver } from "./storage/adapters/rootsResolver.js";
export { runStorageScan } from "./storage/adapters/inProcessScanRunner.js";
export type {
  StorageScanProgress,
  ScanRunnerPort as StorageScanRunnerPort,
} from "./storage/app/ports.js";
export { createFeedbackDiagnosticArchive } from "./feedback/feedbackLogArchive.js";
export {
  buildRuntimeProcessEnvPatch,
  captureLoginShellEnvSnapshot,
  normalizeRuntimeProcessEnv,
} from "./runtime-tools/runtimeCommandEnv.js";
