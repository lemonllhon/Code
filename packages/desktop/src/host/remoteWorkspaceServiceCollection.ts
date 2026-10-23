import { getProjectNativeRoutingOwner, prepareNativeProjectContext } from "@lcode/services/node";
/* eslint-disable max-lines -- 远程 workspace 服务注册需集中维护，以保持依赖注入顺序 */
import {
  IApplicationConfigService,
  IBroadcastService,
  IClientConfigService,
  IClientScenesService,
  ICommandsService,
  IConversationShareService,
  ICredentialService,
  IFileService,
  IFileWatcherService,
  IGitBackupService,
  IGitCheckpointService,
  IGitManagementService,
  IGitService,
  IHooksService,
  ILCodeAgentService,
  ILCodeSessionService,
  ILCodeTaskService,
  IMcpSyncService,
  IMemoryService,
  IModelSelectionService,
  IOAuthService,
  IPluginManagementService,
  IPluginsService,
  IPluginSyncService,
  IProjectExecutionSetService,
  IPromptAttachmentTransferService,
  IProviderAccountService,
  IProviderSettingsService,
  IRuntimeEnvironmentService,
  type IServiceAccessor,
  ISettingService,
  ISettingsSyncService,
  ISidebarOrganizationService,
  ISkillsService,
  ISkillSyncService,
  ISubagentsService,
  ISystemService,
  ITerminalService,
  IUsageStatsService,
  IWorktreeService,
  ServiceCollection,
} from "@lcode/services";
import {
  ConversationShareHttpClient,
  ConversationShareService,
  createApplicationConfigService,
  createBroadcastService,
  createClientScenesService,
  createCredentialService,
  createHostApiNetworkTransport,
  createMemoryService,
  createNodeApiClient,
  createOAuthService,
  createRemoteConversationShareArtifactSource,
  createServiceLogger,
  createSettingService,
  createSettingsSyncService,
  createSubagentsService,
  createUsageStatsService,
  registerBorrowedServiceResources,
  registerHostApiNetworkTransportForDispose,
  registerServiceResourceDisposer,
} from "@lcode/services/node";
import {
  buildProjectContextSnapshot,
  buildRuntimeLCodeApiUrl,
  DEFAULT_LCODE_MODEL_CONTEXT_BUDGET_STRATEGY,
  type LCodeSessionRuntimePreferencesResult,
} from "@lcode/shared";
import { assertLegacyRemoteWorkspaceRpcContract } from "./legacyRemoteWorkspaceRpcContract.js";
import {
  createRemoteProviderProvisioningExecutorFromWorkspace,
  registerRemoteProviderProvisioningExecutor,
} from "./remoteProviderProvisioningService.js";

const runtimePreferencesLogger = createServiceLogger("remote-runtime-preferences");
const LCODE_JWT_TOKEN_KEY = "lcodejwttoken";

export function createRemoteWorkspaceServiceCollection(params: {
  clientConfigService: IClientConfigService;
  connectionServices: IServiceAccessor;
  sourceServices?: ServiceCollection;
  parentPort: Parameters<typeof createBroadcastService>[0];
  createReportingRemoteLCodeTaskService: <T extends object>(service: T) => T;
  createRemotePromptAttachmentTaskService: <T extends object>(service: T) => T;
  createRemotePromptAttachmentSessionService: <T extends object>(service: T) => T;
  promptAttachmentTransferService: IPromptAttachmentTransferService;
  runtimePreferencesBridge: {
    onError: (error: unknown) => void;
  };
}): ServiceCollection {
  assertLegacyRemoteWorkspaceRpcContract(params.connectionServices);
  const localSettingService = createSettingService();
  const localCredentialService = createCredentialService();
  const hostApiNetworkTransport = createHostApiNetworkTransport(async () => {
    const settings = await localSettingService.get();
    return {
      httpProxy: settings.httpProxy,
      noProxy: settings.httpProxyNoProxy,
      caCertPath: settings.httpProxyCaCertPath,
    };
  });
  const localApiClient = createNodeApiClient({
    fetchImpl: hostApiNetworkTransport.fetch,
  });
  const localBroadcastService = createBroadcastService(params.parentPort);
  const localApplicationConfigService = createApplicationConfigService({
    apiClient: localApiClient,
  });
  const conversationShareClient = new ConversationShareHttpClient({
    // 远端 workspace 的分享也必须使用真实 API；本地 Mock 仅用于单测，不生成无法跨进程访问的链接。
    apiClient: localApiClient,
    baseUrl: buildRuntimeLCodeApiUrl(process.env, "/api/v1"),
    tokenProvider: async () =>
      (await localCredentialService.load(LCODE_JWT_TOKEN_KEY))?.trim() || null,
  });
  const conversationShareService = new ConversationShareService({
    lcodeAgentService: params.connectionServices.lcodeAgentService,
    client: conversationShareClient,
    artifactSource: createRemoteConversationShareArtifactSource(
      params.connectionServices.fileService,
    ),
  });
  const reportingRemoteLCodeTaskService = params.createReportingRemoteLCodeTaskService(
    params.connectionServices.lcodeTaskService,
  );
  // 手机 remote 的 replayable mirror 在 reporting wrapper 中发布用户消息；
  // 附件物化必须包在 reporting 外层，确保 mirror 和真正发给远端 agent 的 prompt 使用同一份远端路径。
  const remoteLCodeTaskService = params.createRemotePromptAttachmentTaskService(
    reportingRemoteLCodeTaskService,
  );
  const remoteLCodeSessionService = params.createRemotePromptAttachmentSessionService(
    params.connectionServices.lcodeSessionService,
  );
  const remoteProviderProvisioningService =
    createRemoteProviderProvisioningExecutorFromWorkspace(params);

  const projectNativeSubscription =
    params.connectionServices.lcodeAgentService.onDynamicProjectNativeRequest()((request) => {
      void (async () => {
        const owner = getProjectNativeRoutingOwner();
        try {
          if (!owner) throw new Error("Window project router unavailable");
          const value = await owner.call(request.request, request.originKey);
          await params.connectionServices.lcodeAgentService.respondProjectNative({
            requestId: request.requestId,
            result: { value },
          });
        } catch (error) {
          await params.connectionServices.lcodeAgentService.respondProjectNative({
            requestId: request.requestId,
            result: { error: error instanceof Error ? error.message : String(error) },
          });
        }
      })().catch(params.runtimePreferencesBridge.onError);
    });

  // desktop-attached remote 的 Agent 运行在远端，但 app-global 设置权威仍在
  // desktop shared Host。通过窄化的 runtime-preferences 请求原路返回；
  // 只传可跨机器的全局偏好，Shell 可执行路径由远端解析。
  const { onError } = params.runtimePreferencesBridge;
  const runtimePreferencesSubscription =
    params.connectionServices.lcodeAgentService.onDynamicSessionRuntimePreferencesRequest()(
      (request) => {
        const startedAt = Date.now();
        const requestContext = {
          event: "lcode_protocol.runtime_preferences.host_request_received",
          module: "desktop.host.remote_workspace",
          requestId: request.requestId,
          scope: request.scope,
          sessionId: request.sessionId,
        };
        // 诊断：Agent 侧超时只能说明没有拿到响应；这里记录 Host 是否收到请求，
        // 用“收到但无 response”区分 transport 丢包和设置读取卡住。
        runtimePreferencesLogger.info(
          undefined,
          "runtime preferences host request received",
          requestContext,
        );
        void (async () => {
          const trackStage = <T>(stage: string, promise: Promise<T>): Promise<T> => {
            const stageStartedAt = Date.now();
            return promise.then(
              (value) => {
                runtimePreferencesLogger.debug(
                  undefined,
                  "runtime preferences host stage completed",
                  {
                    ...requestContext,
                    durationMs: Math.max(0, Date.now() - stageStartedAt),
                    stage,
                  },
                );
                return value;
              },
              (error: unknown) => {
                runtimePreferencesLogger.warn(undefined, "runtime preferences host stage failed", {
                  ...requestContext,
                  durationMs: Math.max(0, Date.now() - stageStartedAt),
                  error: error instanceof Error ? error.message : String(error),
                  stage,
                });
                throw error;
              },
            );
          };
          let resolution:
            | { status: "resolved"; preferences: LCodeSessionRuntimePreferencesResult }
            | { status: "failed"; message: string };
          try {
            // 与本地 Host 同源：固定预算不依赖配置网关，远程/手机偏好响应不再串行等待网络。
            const settings = await trackStage("settings", localSettingService.get());
            const modelContextBudgetStrategy = DEFAULT_LCODE_MODEL_CONTEXT_BUDGET_STRATEGY;
            resolution = {
              status: "resolved",
              preferences: {
                ...(request.scope === "project-admission" && request.projectContext
                  ? {
                      projectContext: await prepareNativeProjectContext(
                        buildProjectContextSnapshot(settings, request.projectContext.workspace),
                      ),
                    }
                  : {}),
                askUserQuestionAutoResolutionEnabled:
                  settings.askUserQuestionAutoResolutionEnabled !== false,
                nativeSearchEnhancementsEnabled: settings.nativeSearchEnhancementsEnabled !== false,
                memoryEnabled: settings.memoryEnabled === true,
                // 存储位置与切换版本是本机项目设置；远端继续 profile，不能传播本机 workspace/revision 或目录。
                // 因旧 Agent strict 校验也不能显式补 profile，保留原报文字段缺席。
                sessionRecallEnabled: settings.sessionRecallEnabled === true,
                modelContextBudgetStrategy,
                // 修复：本机 PowerShell 路径曾在首发时传给 Linux，触发 Selected Shell is not executable。
                // 不传播本机 integratedTerminalShell；远程 Agent 按自己的平台和环境解析并校验 Shell。
              },
            };
          } catch (error) {
            resolution = {
              status: "failed",
              message: error instanceof Error ? error.message : String(error),
            };
            runtimePreferencesLogger.warn(undefined, "runtime preferences host resolution failed", {
              ...requestContext,
              durationMs: Math.max(0, Date.now() - startedAt),
              error: resolution.message,
            });
          }
          // 只把设置读取失败编码为 -32603；发送失败交给最终 onError 记录，不能重试同一请求。
          await params.connectionServices.lcodeAgentService.respondSessionRuntimePreferences({
            requestId: request.requestId,
            resolution,
          });
          runtimePreferencesLogger.info(undefined, "runtime preferences host response sent", {
            ...requestContext,
            durationMs: Math.max(0, Date.now() - startedAt),
            resolutionStatus: resolution.status,
          });
        })().catch((error: unknown) => {
          runtimePreferencesLogger.warn(undefined, "runtime preferences host response failed", {
            ...requestContext,
            durationMs: Math.max(0, Date.now() - startedAt),
            error: error instanceof Error ? error.message : String(error),
          });
          onError(error);
        });
      },
    );

  // Web 手机远控进入 SSH task 时只连到 remote workspace host，
  // 没有桌面 renderer 那层 `baseServices + remoteServices` 合并。
  // 因此这里为 remote workspace host 补齐本地全局 channel；文件、终端、LCode Agent 仍来自远端，
  // 全局设置、旧 OAuth 与 settings-sync 继续读写本机；模型目录由远端 Registry 派生 API 配置与本机 OAuth 调用桥。
  const services = new ServiceCollection()
    .register(IFileService, params.connectionServices.fileService)
    .register(IGitService, params.connectionServices.gitService)
    .register(IWorktreeService, params.connectionServices.worktreeService)
    .register(IProjectExecutionSetService, params.connectionServices.projectExecutionSetService)
    .register(IGitCheckpointService, params.connectionServices.gitCheckpointService)
    .register(ISystemService, params.connectionServices.systemService)
    .register(ITerminalService, params.connectionServices.terminalService)
    .register(ISettingService, localSettingService)
    .register(ICredentialService, localCredentialService)
    .register(IBroadcastService, localBroadcastService)
    .register(ILCodeTaskService, remoteLCodeTaskService)
    .register(ILCodeAgentService, params.connectionServices.lcodeAgentService)
    .register(ILCodeSessionService, remoteLCodeSessionService)
    .register(IConversationShareService, conversationShareService)
    .register(IFileWatcherService, params.connectionServices.fileWatcherService)
    .register(
      IOAuthService,
      createOAuthService(localCredentialService, {
        apiClient: localApiClient,
      }),
    )
    // Provider/Model 事实属于目标 Environment。远端 workspace 的选择和设置视图
    // 必须直接读取远端 Registry，不能继续显示 Desktop 本地 Provider。
    .register(IModelSelectionService, params.connectionServices.modelSelectionService)
    .register(IProviderSettingsService, params.connectionServices.providerSettingsService)
    .register(IProviderAccountService, params.connectionServices.providerAccountService)
    .register(
      IUsageStatsService,
      createUsageStatsService({ lcodeAgentService: params.connectionServices.lcodeAgentService }),
    )
    .register(IApplicationConfigService, localApplicationConfigService)
    .register(IClientConfigService, params.clientConfigService)
    .register(IClientScenesService, createClientScenesService({ apiClient: localApiClient }))
    // 远端 workspace 的项目级 skills/plugins/commands 位于 SSH/Docker 文件系统。
    // 这里必须透出远端服务，避免本机服务拿远端 workspacePath 去本机目录扫描。
    .register(ISkillsService, params.connectionServices.skillsService)
    .register(ISkillSyncService, params.connectionServices.skillSyncService)
    .register(IMcpSyncService, params.connectionServices.mcpSyncService)
    .register(IPluginSyncService, params.connectionServices.pluginSyncService)
    .register(IPluginsService, params.connectionServices.pluginsService)
    // 远端设置页插件管理也必须打到远端 agent（插件目录在远端文件系统）。
    .register(IPluginManagementService, params.connectionServices.pluginManagementService)
    .register(ICommandsService, params.connectionServices.commandsService)
    .register(ISubagentsService, createSubagentsService({ isDesktopRuntime: true }))
    .register(IHooksService, params.connectionServices.hooksService)
    .register(IMemoryService, createMemoryService())
    .register(
      ISettingsSyncService,
      createSettingsSyncService({ settingService: localSettingService }),
    )
    .register(IPromptAttachmentTransferService, params.promptAttachmentTransferService);
  // 手机 attachment 没有 Renderer 合并层；环境缺失保持不可用，禁止注册本机第二 owner。
  if (params.connectionServices.runtimeEnvironmentService) {
    services.register(
      IRuntimeEnvironmentService,
      params.connectionServices.runtimeEnvironmentService,
    );
  }
  // 手机 attachment 没有 Renderer 合并层；这里只转发远端 owner，缺失时保持不可用。
  if (params.connectionServices.gitBackupService) {
    services.register(IGitBackupService, params.connectionServices.gitBackupService);
  }
  if (params.connectionServices.gitManagementService)
    services.register(IGitManagementService, params.connectionServices.gitManagementService);
  registerHostApiNetworkTransportForDispose(services, hostApiNetworkTransport);
  registerServiceResourceDisposer(services, () => projectNativeSubscription.dispose());
  registerServiceResourceDisposer(services, () => runtimePreferencesSubscription.dispose());
  // RPC Proxy 会动态伪造方法存在性；不能借 Host 退出调用远端非契约的 disposeAll。
  registerBorrowedServiceResources(services, [
    params.connectionServices.terminalService,
    remoteLCodeTaskService,
    params.connectionServices.lcodeAgentService,
    remoteLCodeSessionService,
    params.connectionServices.fileWatcherService,
  ]);
  registerRemoteProviderProvisioningExecutor(services, remoteProviderProvisioningService);
  const organization = params.sourceServices?.getOptional(ISidebarOrganizationService);
  if (organization) services.register(ISidebarOrganizationService, organization);
  return services;
}
