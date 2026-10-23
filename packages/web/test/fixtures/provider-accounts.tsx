import "@/styles.css";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { IPlatformService } from "@lcode/shared";
import type { IProviderAccountService } from "@lcode/services";
import {
  fixture,
  service,
  services,
  templates,
  navigationScenario,
  scrollScenario,
} from "./provider-accounts-service.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { LCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ProviderTemplatePicker } from "@/settings/model-provider-section/ProviderTemplatePicker.js";
import { ModelProviderSectionDetail } from "@/settings/model-provider-section/Detail.js";
import { ModelProviderSectionLayout } from "@/settings/model-provider-section/SectionLayout.js";
import { useProviderDetailFeedback } from "@/settings/model-provider-section/ProviderDetailFeedback.js";
import { useModelProviders } from "@/hooks/useModelProviders.js";
import { useProviderAccountsDialog } from "@/hooks/useProviderAccountsDialog.js";
import { ProxySettingsSection } from "@/settings/ProxySettingsSection.js";
import { ProviderAccountsDialog } from "@/settings/model-provider-section/ProviderAccountsDialog.js";
import { applyTheme } from "@/useTheme.js";
applyTheme(
  new URLSearchParams(location.search).get("theme") === "light" ? "zai-light" : "zai-dark",
);

function FixtureNavigation() {
  const [selectedNodeKey, setSelectedNodeKey] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const providers = useModelProviders({ workspacePath: "/fixture/provider-accounts" });
  const { navigationGroups, selectedNavItem } = (() => {
    const items = providers.modelProviders
      .filter((p) => p.config.access?.type !== "zhipu-account")
      .map((provider) => ({
        key: "custom:" + provider.providerId,
        type: "custom" as const,
        label: provider.providerName ?? provider.providerId,
        provider,
        statusActive: provider.enabled,
      }));
    return {
      navigationGroups: [{ id: "custom" as const, title: "供应商", items }],
      selectedNavItem: items.find((i) => i.key === selectedNodeKey) ?? items[0] ?? null,
    };
  })();
  return (
    <ModelProviderSectionLayout
      description="Fixture model providers"
      refreshLabel="刷新"
      loadingLabel="加载中"
      addProviderLabel="添加供应商"
      onRefresh={() => {}}
      onAddProvider={() => setPickerOpen(true)}
      navigationGroups={navigationGroups}
      selectedNodeKey={selectedNodeKey}
      presetLoading={false}
      customLoading={providers.loading}
      onSelectNavItem={(item) => {
        setSelectedNodeKey(item.key);
        setPickerOpen(false);
      }}
    >
      <section className="min-w-0">
        {scrollScenario ? <FixtureFeedback /> : null}
        <output data-testid="fixture-has-personal-config">
          {String(providers.modelProviders[0]?.hasPersonalConfig)}
        </output>
        {pickerOpen ? (
          <FixturePicker onBack={() => setPickerOpen(false)} />
        ) : (
          <ModelProviderSectionDetail
            selectedNavItem={selectedNavItem}
            presetLoading={false}
            onSave={async (provider) => {
              await providers.saveProvider(provider);
            }}
            onAddPersonalModel={providers.addPersonalModel}
            onSavePersonalModelDraft={providers.savePersonalModelDraft}
            onSetPersonalModelEnabled={providers.setPersonalModelEnabled}
            onDeletePersonalModel={providers.deletePersonalModel}
            onListRemoteModels={(id) => providers.listRemoteModels(id).then((c) => c.models)}
            onDelete={async () => {}}
            onTestModel={providers.testModelConnectivity}
            onOpenApiKeyUrl={() => {}}
            providerSettingsView={providers.providerSettingsView}
          />
        )}
      </section>
    </ModelProviderSectionLayout>
  );
}
function FixtureFeedback() {
  const { showFeedback } = useProviderDetailFeedback();
  return (
    <button
      type="button"
      onClick={() =>
        showFeedback({
          key: "scroll-fixture",
          message: "Fixture feedback",
          state: "success",
          durationMs: 0,
        })
      }
    >
      Show fixture feedback
    </button>
  );
}
function FixturePicker({ onBack = () => {} }: { onBack?: () => void }) {
  const dialog = useProviderAccountsDialog();
  return (
    <>
      <ProviderTemplatePicker
        templates={templates}
        creating={false}
        onBack={onBack}
        onManageOAuthAccounts={dialog.openChannel}
        onCreateCustom={async (name) => {
          fixture.apiCreates.push(name);
        }}
        onCreateFromTemplate={async (id) => {
          fixture.apiCreates.push(id);
        }}
      />
      {dialog.selection ? (
        <ProviderAccountsDialog {...dialog.selection} onClose={dialog.close} />
      ) : null}
    </>
  );
}
function FixtureProxy() {
  const [proxy, setProxy] = useState("http://127.0.0.1:7890");
  const [noProxy, setNoProxy] = useState("localhost,127.0.0.1");
  const [ca, setCa] = useState("");
  return (
    <ProxySettingsSection
      httpProxy={proxy}
      httpProxyNoProxy={noProxy}
      httpProxyCaCertPath={ca}
      onHttpProxyChange={async (value) => setProxy(value)}
      onHttpProxyNoProxyChange={async (value) => setNoProxy(value)}
      onHttpProxyCaCertPathChange={async (value) => setCa(value)}
    />
  );
}
function FixtureApp() {
  const proxyScenario = new URLSearchParams(location.search).has("proxy");
  const [showProxy, setShowProxy] = useState(proxyScenario);
  const [alternateHost, setAlternateHost] = useState(false);
  fixture.switchHost = () => setAlternateHost(true);
  const [alternateServices] = useState(() => ({
    ...services,
    providerAccountService: {
      ...service,
      startAuthorization: async (
        input: Parameters<IProviderAccountService["startAuthorization"]>[0],
      ) => {
        fixture.alternateHostReads++;
        return service.startAuthorization(input);
      },
    },
  }));
  return (
    <PlatformProvider
      platform={
        {
          openExternal: (url: string) => {
            fixture.opened.push(url);
          },
        } as IPlatformService
      }
    >
      <ServiceProvider services={alternateHost ? alternateServices : services}>
        <LCodeIntlProvider
          initialLocale={
            new URLSearchParams(location.search).get("locale") === "en-US" ? "en-US" : "zh-CN"
          }
        >
          <TooltipProvider>
            <div
              className="h-full overflow-y-auto bg-background text-foreground"
              data-testid="fixture-settings-scroll"
            >
              <main className="mx-auto max-w-4xl p-4">
                {proxyScenario ? (
                  <nav aria-label="测试设置导航" className="mb-4 flex gap-4">
                    <button type="button" onClick={() => setShowProxy(true)}>
                      代理
                    </button>
                    <button type="button" onClick={() => setShowProxy(false)}>
                      模型设置
                    </button>
                  </nav>
                ) : null}
                {showProxy ? (
                  <FixtureProxy />
                ) : navigationScenario ? (
                  <FixtureNavigation />
                ) : (
                  <FixturePicker />
                )}
              </main>
              {/* 留出真实外层可滚动空间，验证子栏滚到边界后不会继续带动设置页。 */}
              {scrollScenario ? <div className="h-screen" aria-hidden="true" /> : null}
            </div>
          </TooltipProvider>
        </LCodeIntlProvider>
      </ServiceProvider>
    </PlatformProvider>
  );
}
createRoot(document.getElementById("root")!).render(<FixtureApp />);
