import { AppUsagePanel } from "@/settings/usage-stats/AppUsagePanel.js";
import { ProviderUsagePanel } from "@/settings/usage-stats/ProviderUsagePanel.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { UsageModelAliasesEditor } from "@/settings/usage-stats/UsageModelAliasesEditor.js";

export type UsageStatsSectionTab = "app" | "oauth";

export function UsageStatsSection({ activeTab }: { activeTab: UsageStatsSectionTab }) {
  const { intl } = useLCodeIntl();
  const editor = <UsageModelAliasesEditor />;
  if (activeTab === "app") {
    return (
      <section data-testid="api-usage-panel" className="space-y-4">
        {editor}
        <p className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "settings.usage.apiScopeNote" })}
        </p>
        <AppUsagePanel />
      </section>
    );
  }
  return (
    <div className="space-y-4">
      {editor}
      <ProviderUsagePanel />
    </div>
  );
}
