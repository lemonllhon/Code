import "@lcode/ui/styles.css";
import { createRoot } from "react-dom/client";
import type { IServiceAccessor } from "@lcode/services";
import type { IPlatformService } from "@lcode/shared";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { LCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ModelProviderSection } from "@/settings/ModelProviderSection.js";
import { applyTheme } from "@/useTheme.js";
import { fixture } from "./model-provider-settings-service.js";

applyTheme(new URLSearchParams(location.search).has("light") ? "zai-light" : "zai-dark");
Object.assign(window, { __retainedProviders: { getView: () => fixture.service.getView() } });
const services = {
  providerSettingsService: fixture.service,
  providerAccountService: {
    getView: async () => ({ revision: 0, channels: [], accounts: [] }),
    onDidChange: () => ({ dispose() {} }),
  },
} as unknown as IServiceAccessor;
createRoot(document.getElementById("root")!).render(
  <PlatformProvider platform={{ openExternal() {} } as unknown as IPlatformService}>
    <ServiceProvider services={services}>
      <LCodeIntlProvider initialLocale="en-US">
        <TooltipProvider>
          <main className="h-dvh p-3">
            <ModelProviderSection workspacePath="/fixture/providers" />
          </main>
        </TooltipProvider>
      </LCodeIntlProvider>
    </ServiceProvider>
  </PlatformProvider>,
);
