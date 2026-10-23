import { ProxyChannel, type IChannel, type IChannelClient } from "@lcode/rpc";
import {
  IApplicationConfigService,
  IBroadcastService,
  IClientConfigService,
  IClientScenesService,
  ICommandsService,
  IConversationShareService,
  ICredentialService,
  ICuaPermissionService,
  IFeedbackService,
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
  IMediaPreviewService,
  IMemoryService,
  IModelSelectionService,
  IOAuthService,
  IOnboardingRecordService,
  IPluginManagementService,
  IPluginsService,
  IPluginSyncService,
  IProjectExecutionSetService,
  IPromptAttachmentTransferService,
  IProviderAccountService,
  IProviderProvisioningTargetService,
  IProviderSettingsService,
  IRuntimeEnvironmentService,
  ISettingService,
  ISettingsSyncService,
  ISidebarOrganizationService,
  ISkillsService,
  ISkillSyncService,
  ISubagentsService,
  ISystemService,
  ITerminalService,
  IUsageStatsService,
  IWindowControllerService,
  IWindowWorkspaceService,
  IWorktreeService,
  type IServiceAccessor,
} from "@lcode/services";
import type { WindowWorkspaceScope } from "@lcode/shared";

/**
 * RemoteServiceAccess — 通过 ChannelClient 自动创建类型安全的服务代理
 *
 * 新增服务只需在此添加一个 getter。
 */
export class RemoteServiceAccess implements IServiceAccessor {
  readonly sidebarOrganizationService: ISidebarOrganizationService;
  readonly fileService: IFileService;
  readonly mediaPreviewService: IMediaPreviewService;
  readonly gitService: IGitService;
  readonly gitManagementService: IGitManagementService;
  readonly worktreeService: IWorktreeService;
  readonly projectExecutionSetService: IProjectExecutionSetService;
  readonly runtimeEnvironmentService: IRuntimeEnvironmentService;
  readonly gitCheckpointService: IGitCheckpointService;
  readonly gitBackupService: IGitBackupService;
  readonly systemService: ISystemService;
  readonly terminalService: ITerminalService;
  readonly settingService: ISettingService;
  readonly onboardingRecordService: IOnboardingRecordService;
  readonly credentialService: ICredentialService;
  readonly broadcastService: IBroadcastService;
  readonly lcodeTaskService: ILCodeTaskService;
  readonly windowControllerService: IWindowControllerService;
  readonly windowWorkspaceService: IWindowWorkspaceService;
  readonly lcodeAgentService: ILCodeAgentService;
  readonly lcodeSessionService: ILCodeSessionService;
  // cuaPermissionService 在 IServiceAccessor 上是可选（远端 host 不提供），但桌面 renderer
  // 经 RPC 一定能拿到（main host 始终注册此 descriptor；非 macOS / 未启用时方法返回 available:false）。
  readonly cuaPermissionService: ICuaPermissionService;
  readonly conversationShareService: IConversationShareService;
  readonly fileWatcherService: IFileWatcherService;
  readonly oauthService: IOAuthService;
  readonly providerSettingsService: IProviderSettingsService;
  readonly providerAccountService: IProviderAccountService;
  readonly modelSelectionService: IModelSelectionService;
  /** Host-only target proxy；不属于 IServiceAccessor，避免向 Renderer 暴露 Secret 写入接口。 */
  readonly providerProvisioningTargetService!: IProviderProvisioningTargetService;
  readonly usageStatsService: IUsageStatsService;
  readonly applicationConfigService: IApplicationConfigService;
  readonly clientConfigService: IClientConfigService;
  readonly clientScenesService: IClientScenesService;
  readonly skillsService: ISkillsService;
  readonly skillSyncService: ISkillSyncService;
  readonly mcpSyncService: IMcpSyncService;
  readonly pluginSyncService: IPluginSyncService;
  readonly pluginsService: IPluginsService;
  readonly pluginManagementService: IPluginManagementService;
  readonly subagentsService: ISubagentsService;
  readonly commandsService: ICommandsService;
  readonly hooksService: IHooksService;
  readonly memoryService: IMemoryService;
  readonly settingsSyncService: ISettingsSyncService;
  readonly feedbackService: IFeedbackService;
  readonly promptAttachmentTransferService: IPromptAttachmentTransferService;

  constructor(private readonly channelClient: IChannelClient) {
    this.projectExecutionSetService = ProxyChannel.toService<IProjectExecutionSetService>(
      channelClient.getChannel(IProjectExecutionSetService.channelName),
    );
    this.sidebarOrganizationService = ProxyChannel.toService<ISidebarOrganizationService>(
      channelClient.getChannel(ISidebarOrganizationService.channelName),
    );
    this.windowWorkspaceService = ProxyChannel.toService<IWindowWorkspaceService>(
      channelClient.getChannel(IWindowWorkspaceService.channelName),
    );
    this.fileService = ProxyChannel.toService<IFileService>(
      channelClient.getChannel(IFileService.channelName),
    );
    // Host 已注册 media-preview channel，但遗漏 renderer proxy 时，PreviewPane
    // 会静默回退到 8 MiB 的 file.readMediaPreview，导致大 MP4 无法打开。
    this.mediaPreviewService = ProxyChannel.toService<IMediaPreviewService>(
      channelClient.getChannel(IMediaPreviewService.channelName),
    );
    this.gitService = ProxyChannel.toService<IGitService>(
      channelClient.getChannel(IGitService.channelName),
    );
    this.gitManagementService = ProxyChannel.toService<IGitManagementService>(
      channelClient.getChannel(IGitManagementService.channelName),
    );
    this.worktreeService = ProxyChannel.toService<IWorktreeService>(
      channelClient.getChannel(IWorktreeService.channelName),
    );
    this.runtimeEnvironmentService = ProxyChannel.toService<IRuntimeEnvironmentService>(
      channelClient.getChannel(IRuntimeEnvironmentService.channelName),
    );
    this.gitCheckpointService = ProxyChannel.toService<IGitCheckpointService>(
      channelClient.getChannel(IGitCheckpointService.channelName),
    );
    this.gitBackupService = ProxyChannel.toService<IGitBackupService>(
      channelClient.getChannel(IGitBackupService.channelName),
    );
    this.systemService = ProxyChannel.toService<ISystemService>(
      channelClient.getChannel(ISystemService.channelName),
    );
    this.terminalService = ProxyChannel.toService<ITerminalService>(
      channelClient.getChannel(ITerminalService.channelName),
    );
    this.settingService = ProxyChannel.toService<ISettingService>(
      channelClient.getChannel(ISettingService.channelName),
    );
    this.onboardingRecordService = ProxyChannel.toService<IOnboardingRecordService>(
      channelClient.getChannel(IOnboardingRecordService.channelName),
    );
    this.credentialService = ProxyChannel.toService<ICredentialService>(
      channelClient.getChannel(ICredentialService.channelName),
    );
    this.broadcastService = ProxyChannel.toService<IBroadcastService>(
      channelClient.getChannel(IBroadcastService.channelName),
    );
    this.lcodeTaskService = ProxyChannel.toService<ILCodeTaskService>(
      channelClient.getChannel(ILCodeTaskService.channelName),
    );
    this.windowControllerService = ProxyChannel.toService<IWindowControllerService>(
      channelClient.getChannel(IWindowControllerService.channelName),
    );
    this.lcodeAgentService = ProxyChannel.toService<ILCodeAgentService>(
      channelClient.getChannel(ILCodeAgentService.channelName),
    );
    this.lcodeSessionService = ProxyChannel.toService<ILCodeSessionService>(
      channelClient.getChannel(ILCodeSessionService.channelName),
    );
    this.cuaPermissionService = ProxyChannel.toService<ICuaPermissionService>(
      channelClient.getChannel(ICuaPermissionService.channelName),
    );
    this.conversationShareService = ProxyChannel.toService<IConversationShareService>(
      channelClient.getChannel(IConversationShareService.channelName),
    );
    this.fileWatcherService = ProxyChannel.toService<IFileWatcherService>(
      channelClient.getChannel(IFileWatcherService.channelName),
    );
    this.oauthService = ProxyChannel.toService<IOAuthService>(
      channelClient.getChannel(IOAuthService.channelName),
    );
    this.providerSettingsService = ProxyChannel.toService<IProviderSettingsService>(
      channelClient.getChannel(IProviderSettingsService.channelName),
    );
    this.providerAccountService = ProxyChannel.toService<IProviderAccountService>(
      channelClient.getChannel(IProviderAccountService.channelName),
    );
    this.modelSelectionService = ProxyChannel.toService<IModelSelectionService>(
      channelClient.getChannel(IModelSelectionService.channelName),
    );
    Object.defineProperty(this, "providerProvisioningTargetService", {
      value: ProxyChannel.toService<IProviderProvisioningTargetService>(
        channelClient.getChannel(IProviderProvisioningTargetService.channelName),
      ),
      enumerable: false,
    });
    this.usageStatsService = ProxyChannel.toService<IUsageStatsService>(
      channelClient.getChannel(IUsageStatsService.channelName),
    );
    this.applicationConfigService = ProxyChannel.toService<IApplicationConfigService>(
      channelClient.getChannel(IApplicationConfigService.channelName),
    );
    this.clientConfigService = ProxyChannel.toService<IClientConfigService>(
      channelClient.getChannel(IClientConfigService.channelName),
    );
    this.clientScenesService = ProxyChannel.toService<IClientScenesService>(
      channelClient.getChannel(IClientScenesService.channelName),
    );
    this.skillsService = ProxyChannel.toService<ISkillsService>(
      channelClient.getChannel(ISkillsService.channelName),
    );
    this.skillSyncService = ProxyChannel.toService<ISkillSyncService>(
      channelClient.getChannel(ISkillSyncService.channelName),
    );
    this.mcpSyncService = ProxyChannel.toService<IMcpSyncService>(
      channelClient.getChannel(IMcpSyncService.channelName),
    );
    this.pluginSyncService = ProxyChannel.toService<IPluginSyncService>(
      channelClient.getChannel(IPluginSyncService.channelName),
    );
    this.pluginsService = ProxyChannel.toService<IPluginsService>(
      channelClient.getChannel(IPluginsService.channelName),
    );
    this.pluginManagementService = ProxyChannel.toService<IPluginManagementService>(
      channelClient.getChannel(IPluginManagementService.channelName),
    );
    this.subagentsService = ProxyChannel.toService<ISubagentsService>(
      channelClient.getChannel(ISubagentsService.channelName),
    );
    this.commandsService = ProxyChannel.toService<ICommandsService>(
      channelClient.getChannel(ICommandsService.channelName),
    );
    this.hooksService = ProxyChannel.toService<IHooksService>(
      channelClient.getChannel(IHooksService.channelName),
    );
    this.memoryService = ProxyChannel.toService<IMemoryService>(
      channelClient.getChannel(IMemoryService.channelName),
    );
    this.settingsSyncService = ProxyChannel.toService<ISettingsSyncService>(
      channelClient.getChannel(ISettingsSyncService.channelName),
    );
    this.feedbackService = ProxyChannel.toService<IFeedbackService>(
      channelClient.getChannel(IFeedbackService.channelName),
    );
    this.promptAttachmentTransferService = ProxyChannel.toService<IPromptAttachmentTransferService>(
      channelClient.getChannel(IPromptAttachmentTransferService.channelName),
    );
  }

  createWorkspaceServiceAccessor(scope: WindowWorkspaceScope): IServiceAccessor {
    const owner = this.windowWorkspaceService;
    const upstream = this.channelClient;
    // 所有 workspace facade 仍共用已授权窗口的 transport，scope 由 Host 严格验证。
    return new RemoteServiceAccess({
      getChannel<T extends IChannel>(channel: string): T {
        if (
          channel === IWindowWorkspaceService.channelName ||
          channel === IWindowControllerService.channelName
        )
          return upstream.getChannel<T>(channel);
        return {
          call: (command: string, args?: unknown[]) =>
            owner.call({ scope, channel, command, args }),
          listen: (event: string, arg?: unknown) =>
            owner.onDynamicScopedEvent({ scope, channel, event, arg }),
        } as unknown as T;
      },
    });
  }
}
