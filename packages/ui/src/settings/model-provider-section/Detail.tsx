import type { ProviderApiKeyProbeRunOptions } from "@/hooks/providerApiKeyProbe.js";
import {
  getProviderFormApiKeyManagementUrl,
  type ProviderSettingsFormProvider,
} from "@/lib/providerSettingsFormTypes.js";
import { Button } from "@/components/ui/button.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import type { ModelProviderNavItem } from "./constants.js";
import { InlineEditableProviderCard } from "./InlineEditableProviderCard.js";
import { ProviderAccountsDetails } from "./ProviderAccountsContent.js";
import type { TestProviderModelConnectivity } from "@/hooks/useModelProviders.js";
import type { ProviderApiKeyProbeResult, ProviderSettingsView } from "@lcode/services";
import type { SavePersonalModelDraftInput } from "@lcode/provider";
export function ModelProviderSectionDetail({
  selectedNavItem,
  presetLoading,
  onAddProvider,
  onSave,
  onAddPersonalModel,
  onSavePersonalModelDraft,
  onSetPersonalModelEnabled,
  onDeletePersonalModel,
  onDelete,
  onReorderProviderModels,
  onTestModel,
  onListRemoteModels,
  onProbeApiKeys,
  onOpenApiKeyUrl,
  providerSettingsView,
}: {
  selectedNavItem: ModelProviderNavItem | null;
  presetLoading: boolean;
  onAddProvider?: () => void;
  providerSettingsView?: ProviderSettingsView | null;
  onOpenApiKeyUrl: (url: string) => void;
  onSave: (config: ProviderSettingsFormProvider) => void | Promise<void>;
  onAddPersonalModel?: (
    providerId: string,
    modelId: string,
    config: ProviderSettingsFormProvider["models"][number]["personalConfig"],
    useRecommendedConfig?: boolean,
  ) => Promise<unknown>;
  onSavePersonalModelDraft?: (input: SavePersonalModelDraftInput) => Promise<unknown>;
  onSetPersonalModelEnabled?: (
    providerId: string,
    modelId: string,
    enabled: boolean,
  ) => Promise<unknown>;
  onDeletePersonalModel?: (providerId: string, modelId: string) => Promise<unknown>;
  onDelete: (provider: ProviderSettingsFormProvider) => Promise<void>;
  onReorderProviderModels?: (providerId: string, modelIds: string[]) => Promise<void>;
  onTestModel: TestProviderModelConnectivity;
  onListRemoteModels?: (providerId: string) => Promise<readonly string[]>;
  onProbeApiKeys?: (
    providerId: string,
    keyIds: readonly string[],
    options?: ProviderApiKeyProbeRunOptions,
  ) => Promise<readonly ProviderApiKeyProbeResult[]>;
}) {
  const { intl } = useLCodeIntl();
  if (!selectedNavItem?.provider)
    return (
      <div className="flex flex-col items-center gap-3 p-4">
        <p>
          {intl.formatMessage({
            id: presetLoading ? "common.loading" : "settings.modelProvider.empty",
          })}
        </p>
        {!presetLoading && onAddProvider ? (
          <Button variant="outline" onClick={onAddProvider}>
            {intl.formatMessage({ id: "settings.modelProvider.addProviderAction" })}
          </Button>
        ) : null}
      </div>
    );
  const modelEditingProps = {
    onAddPersonalModel,
    onSavePersonalModelDraft,
    onSetPersonalModelEnabled,
    onDeletePersonalModel,
    onListRemoteModels,
    onProbeApiKeys,
    settingsRevision: providerSettingsView?.revision,
  };
  const customProvider = selectedNavItem.provider;
  if (customProvider.config.access?.type === "oauth-account") {
    const channelId = customProvider.config.access.channelId;
    return (
      <ProviderAccountsDetails
        key={channelId}
        channelId={channelId}
        title={selectedNavItem.label}
        modelEditor={(listModels) => (
          <InlineEditableProviderCard
            provider={customProvider}
            onSave={onSave}
            {...modelEditingProps}
            onListRemoteModels={listModels}
            onTestModel={onTestModel}
            onReorderModelIds={
              onReorderProviderModels
                ? (ids) => onReorderProviderModels(customProvider.providerId, ids)
                : undefined
            }
            hideConnectionSettings
            readOnlyEndpoints
            headerVisible={false}
          />
        )}
      />
    );
  }
  const customApiKeyUrl = customProvider.templateId
    ? getProviderFormApiKeyManagementUrl(customProvider)
    : undefined;
  return (
    // 仅展示预设模板声明的入口，不根据地址猜测自定义 Provider 的 Key 控制台。
    <InlineEditableProviderCard
      provider={customProvider}
      onSave={onSave}
      {...modelEditingProps}
      onDelete={() => onDelete(customProvider)}
      onReorderModelIds={
        onReorderProviderModels
          ? (modelIds) => onReorderProviderModels(customProvider.providerId, modelIds)
          : undefined
      }
      onTestModel={onTestModel}
      presetApiKeyUrl={customApiKeyUrl}
      readOnlyEndpoints={false}
      nameEditable
      onOpenPresetApiKey={
        customApiKeyUrl
          ? () => {
              onOpenApiKeyUrl(customApiKeyUrl);
            }
          : undefined
      }
    />
  );
}
