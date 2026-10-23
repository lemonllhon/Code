import { useCallback, useEffect, useMemo, useState } from "react";
import { type ProviderSettingsFormProvider } from "@/lib/providerSettingsFormTypes.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useModelProviders } from "@/hooks/useModelProviders.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { ModelProviderSectionDetail } from "./model-provider-section/Detail.js";
import { ModelProviderSectionLayout } from "./model-provider-section/SectionLayout.js";
import { ProviderTemplatePicker } from "./model-provider-section/ProviderTemplatePicker.js";
import { ProviderAccountsDialog } from "./model-provider-section/ProviderAccountsDialog.js";
import { InlineEditableProviderCard } from "./model-provider-section/InlineEditableProviderCard.js";
import { useProviderAccountsDialog } from "@/hooks/useProviderAccountsDialog.js";
import { confirmAndDeleteModelProvider } from "./model-provider-section/modelProviderActions.js";
import { sortModelProvidersForDisplay } from "@/lib/modelProviderOrdering.js";
import {
  addPendingSettingsSectionListener,
  type SettingsModelProviderTarget,
} from "@/lib/settingsNavigation.js";
import type {
  ModelProviderNavGroup,
  ModelProviderNavItem,
} from "./model-provider-section/constants.js";
import { createCustomProviderNodeKey } from "./model-provider-section/utils.js";
export {
  fuzzyMatch,
  handleEndpointSuggestionPopoverOpenAutoFocus,
  resolveEndpointSuggestionOpenRequest,
} from "./model-provider-section/utils.js";
export function ModelProviderSection({
  workspacePath = "",
  connectivityWorkspacePath,
  connectivityWorkspaceRequired = false,
  pendingModelProviderTarget,
  onConsumePendingModelProviderTarget,
}: {
  workspacePath?: string;
  connectivityWorkspacePath?: string;
  connectivityWorkspaceRequired?: boolean;
  pendingModelProviderTarget?: SettingsModelProviderTarget;
  onConsumePendingModelProviderTarget?: () => void;
} = {}) {
  const { intl, locale } = useLCodeIntl();
  const confirmDialog = useConfirmDialog();
  const platform = usePlatform();
  const {
    modelProviders,
    providerTemplates,
    displayOrder,
    loading,
    loadError,
    reload,
    refreshing: modelProvidersRefreshing,
    refresh,
    saveProvider,
    createPersonalProvider,
    addPersonalModel,
    savePersonalModelDraft,
    setPersonalModelEnabled,
    deletePersonalModel,
    deleteProvider,
    reorderProviderModels,
    saveDisplayOrder,
    reorderableProviderIds,
    testModelConnectivity,
    listRemoteModels,
    probeApiKeys,
    providerSettingsView,
  } = useModelProviders({
    workspacePath,
    connectivityWorkspacePath,
    connectivityWorkspaceRequired,
    connectivityUnavailableMessage: intl.formatMessage({
      id: "settings.modelProvider.testModel.localWorkspaceUnavailable",
    }),
  });

  const [selectedNodeKey, setSelectedNodeKey] = useState<string | null>(null);
  const [pendingCreatedProviderId, setPendingCreatedProviderId] = useState<string | null>(null);
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const [creatingProvider, setCreatingProvider] = useState(false);
  const [invalidProviderTarget, setInvalidProviderTarget] = useState(false);
  const {
    selection: oauthDialogSelection,
    openChannel: openOAuthAccounts,
    close: closeOAuthAccounts,
  } = useProviderAccountsDialog();
  const navigationItems = useMemo<ModelProviderNavItem[]>(
    () =>
      sortModelProvidersForDisplay(
        modelProviders.filter((p) => p.config.access?.type !== "zhipu-account"),
        displayOrder,
      ).map((provider) => ({
        key: createCustomProviderNodeKey(provider.providerId),
        type: "custom",
        label: provider.providerName ?? provider.providerId,
        provider,
        statusActive: provider.enabled,
      })),
    [modelProviders, displayOrder],
  );
  const navigationGroups: ModelProviderNavGroup[] = [
    {
      id: "custom",
      title: intl.formatMessage({ id: "settings.modelProvider.customTitle" }),
      items: navigationItems,
    },
  ];
  const selectedNavItem =
    navigationItems.find((item) => item.key === selectedNodeKey) ?? navigationItems[0] ?? null;
  useEffect(() => {
    if (
      !pendingCreatedProviderId ||
      !modelProviders.some((p) => p.providerId === pendingCreatedProviderId)
    )
      return;
    setSelectedNodeKey(createCustomProviderNodeKey(pendingCreatedProviderId));
    setPendingCreatedProviderId(null);
  }, [modelProviders, pendingCreatedProviderId]);
  const applyTarget = useCallback(
    (target: SettingsModelProviderTarget | undefined) => {
      if (!target) return;
      setSelectedNodeKey(createCustomProviderNodeKey(target.providerId));
      setInvalidProviderTarget(
        !modelProviders.some(
          (p) => p.providerId === target.providerId && p.config.access?.type !== "zhipu-account",
        ),
      );
      setTemplatePickerOpen(false);
    },
    [modelProviders],
  );
  useEffect(() => {
    if (pendingModelProviderTarget) {
      applyTarget(pendingModelProviderTarget);
      onConsumePendingModelProviderTarget?.();
    }
  }, [applyTarget, pendingModelProviderTarget, onConsumePendingModelProviderTarget]);
  useEffect(
    () =>
      addPendingSettingsSectionListener((section, detail) => {
        if (section === "modelProvider" && detail?.modelProviderId)
          applyTarget({ providerId: detail.modelProviderId });
      }),
    [applyTarget],
  );
  const handleSave = async (provider: ProviderSettingsFormProvider) => {
    await saveProvider(provider);
  };
  const handleDelete = (provider: ProviderSettingsFormProvider) =>
    confirmAndDeleteModelProvider({ provider, confirmDialog, intl, deleteProvider });
  const handleOpenApiKeyUrl = (url: string) => {
    if (url.trim()) platform.openExternal(url.trim());
  };
  const handleCreateProvider = useCallback(
    async (input: { templateId?: string; providerName?: string }) => {
      setCreatingProvider(true);
      try {
        const created = await createPersonalProvider({ ...input, locale });
        setPendingCreatedProviderId(created.providerId);
        setSelectedNodeKey(createCustomProviderNodeKey(created.providerId));
        setTemplatePickerOpen(false);
      } catch (error) {
        setPendingCreatedProviderId(null);
        throw error;
      } finally {
        setCreatingProvider(false);
      }
    },
    [createPersonalProvider, locale],
  );

  const handleReorderProviderIds = useCallback(
    async (orderedGroupProviderIds: string[]) => {
      const groupProviderIdSet = new Set(orderedGroupProviderIds);
      const currentProviderIds = sortModelProvidersForDisplay(modelProviders, displayOrder).map(
        (provider) => provider.providerId,
      );
      const insertionIndex = currentProviderIds.findIndex((providerId) =>
        groupProviderIdSet.has(providerId),
      );
      if (insertionIndex < 0) {
        return;
      }
      const nextProviderIds = currentProviderIds.filter(
        (providerId) => !groupProviderIdSet.has(providerId),
      );
      nextProviderIds.splice(insertionIndex, 0, ...orderedGroupProviderIds);
      await saveDisplayOrder({
        providerIds: nextProviderIds,
      });
    },
    [displayOrder, modelProviders, saveDisplayOrder],
  );

  if (loadError)
    return (
      <div role="alert">
        <p>{loadError.message}</p>
        <Button variant="outline" onClick={reload}>
          {intl.formatMessage({ id: "common.retry" })}
        </Button>
      </div>
    );
  return (
    <ModelProviderSectionLayout
      description={intl.formatMessage({ id: "settings.modelProviderDescription" })}
      refreshLabel={intl.formatMessage({ id: "settings.modelProvider.refresh" })}
      loadingLabel={intl.formatMessage({ id: "common.loading" })}
      presetLoading={loading || modelProvidersRefreshing}
      customLoading={loading || modelProvidersRefreshing}
      onRefresh={() => {
        void refresh();
      }}
      addProviderLabel={intl.formatMessage({ id: "settings.modelProvider.addProviderAction" })}
      onAddProvider={() => setTemplatePickerOpen(true)}
      navigationGroups={navigationGroups}
      selectedNodeKey={selectedNavItem?.key ?? null}
      onSelectNavItem={(item) => {
        setSelectedNodeKey(item.key);
        setTemplatePickerOpen(false);
        setInvalidProviderTarget(false);
      }}
      onReorderProviderIds={handleReorderProviderIds}
      reorderableProviderIds={reorderableProviderIds}
    >
      {invalidProviderTarget && !templatePickerOpen ? (
        <p role="alert" className="text-destructive">
          {intl.formatMessage({ id: "settings.modelProvider.navigationUnavailable" })}
        </p>
      ) : null}
      {templatePickerOpen ? (
        <ProviderTemplatePicker
          onManageOAuthAccounts={openOAuthAccounts}
          templates={providerTemplates}
          creating={creatingProvider}
          onBack={() => setTemplatePickerOpen(false)}
          onCreateFromTemplate={(templateId) => handleCreateProvider({ templateId })}
          onCreateCustom={(providerName) => handleCreateProvider({ providerName })}
        />
      ) : (
        <ModelProviderSectionDetail
          providerSettingsView={providerSettingsView}
          selectedNavItem={selectedNavItem}
          presetLoading={loading || modelProvidersRefreshing}
          onAddProvider={() => setTemplatePickerOpen(true)}
          onSave={handleSave}
          onAddPersonalModel={addPersonalModel}
          onSavePersonalModelDraft={savePersonalModelDraft}
          onSetPersonalModelEnabled={setPersonalModelEnabled}
          onDeletePersonalModel={deletePersonalModel}
          onDelete={handleDelete}
          onReorderProviderModels={reorderProviderModels}
          onTestModel={testModelConnectivity}
          onListRemoteModels={(id) => listRemoteModels(id).then((c) => c.models)}
          onProbeApiKeys={probeApiKeys}
          onOpenApiKeyUrl={handleOpenApiKeyUrl}
        />
      )}
      {oauthDialogSelection ? (
        <ProviderAccountsDialog
          key={oauthDialogSelection.channelId}
          {...oauthDialogSelection}
          onClose={closeOAuthAccounts}
          modelEditor={(listOAuthModels) => {
            const provider = modelProviders.find(
              (item) =>
                item.config.access?.type === "oauth-account" &&
                item.config.access.channelId === oauthDialogSelection.channelId,
            );
            return provider ? (
              <InlineEditableProviderCard
                provider={provider}
                onSave={handleSave}
                onAddPersonalModel={addPersonalModel}
                onSavePersonalModelDraft={savePersonalModelDraft}
                onSetPersonalModelEnabled={setPersonalModelEnabled}
                onDeletePersonalModel={deletePersonalModel}
                onTestModel={testModelConnectivity}
                onListRemoteModels={listOAuthModels}
                onReorderModelIds={(ids) => reorderProviderModels(provider.providerId, ids)}
                settingsRevision={providerSettingsView?.revision}
                hideConnectionSettings
                readOnlyEndpoints
                headerVisible={false}
              />
            ) : null;
          }}
        />
      ) : null}
    </ModelProviderSectionLayout>
  );
}
