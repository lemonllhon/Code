import type { ReactNode } from "react";
import type { IServiceAccessor } from "@lcode/services";
import { ServiceProvider } from "@/hooks/useServices.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { StoreProvider } from "@/store/StoreProvider.js";
import { TabStoreProvider } from "@/store/TabStoreProvider.js";
import { LCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { platform } from "./git-backup-platform.js";
const broadcast = { send: async () => {}, onMessage: () => ({ dispose() {} }) };
export function WorktreeFixtureProviders({
  services,
  children,
}: {
  services: IServiceAccessor;
  children: ReactNode;
}) {
  return (
    <PlatformProvider platform={platform}>
      <ServiceProvider services={services}>
        <StoreProvider broadcastService={broadcast}>
          <TabStoreProvider>
            <LCodeIntlProvider
              initialLocale={location.search.includes("english") ? "en-US" : "zh-CN"}
            >
              <TooltipProvider>{children}</TooltipProvider>
            </LCodeIntlProvider>
          </TabStoreProvider>
        </StoreProvider>
      </ServiceProvider>
    </PlatformProvider>
  );
}
