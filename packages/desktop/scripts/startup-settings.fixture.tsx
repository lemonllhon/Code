import { createRoot } from "react-dom/client";
import { useState } from "react";
import type { IServiceAccessor } from "@lcode/services";
import { appSettingsSchema, type AppSettings, type IPlatformService } from "@lcode/shared";
import { ServiceProvider } from "../../ui/src/hooks/useServices.js";
import { PlatformProvider } from "../../ui/src/hooks/usePlatform.js";
import { LCodeIntlProvider } from "../../ui/src/i18n/IntlProvider.js";
import { TooltipProvider } from "../../ui/src/components/ui/tooltip.js";
import { StartupAnimationSettingsSection } from "../../ui/src/settings/StartupAnimationSettingsSection.js";
import { WallpaperSettingsSection } from "../../ui/src/settings/WallpaperSettingsSection.js";
import { WorkspaceShellSurface } from "../../ui/src/app-shell/WorkspaceShellSurface.js";
import {
  getBuiltinWallpaperUrl,
  getStartupAnimationPresets,
} from "../src/renderer/src/startup/media.js";
import { previewStartupAnimation } from "../src/renderer/src/startup/bridge.js";
import { mountStartupScenePreview } from "../src/renderer/src/startup/scene.js";
import { mountAemeathWallpaper } from "../src/renderer/src/startup/aemeathWallpaper.js";
import { validateStartupSceneMedia } from "../src/renderer/src/startup/sceneResource.js";
import { saveStartupSceneImage } from "../src/renderer/src/startup/sceneImages.js";
import "../../ui/src/styles.css";

let settings = appSettingsSchema.parse(
  JSON.parse(localStorage.getItem("startup-settings-fixture") ?? "{}"),
);
const services = {
  settingService: {
    get: async () => settings,
    update: async (patch: Partial<AppSettings>) => {
      if ((globalThis as typeof globalThis & { startupSettingsFail?: boolean }).startupSettingsFail)
        throw new Error("Simulated settings failure");
      settings = appSettingsSchema.parse({ ...settings, ...patch });
      localStorage.setItem("startup-settings-fixture", JSON.stringify(settings));
    },
  },
  broadcastService: { send: async () => {} },
} as unknown as IServiceAccessor;
const platform = {
  mountStartupScenePreview,
  mountAemeathWallpaper,
  validateStartupSceneMedia,
  saveStartupSceneImage,
  previewStartupAnimation,
  getBuiltinWallpaperUrl,
  getStartupAnimationPresets,
} as IPlatformService;
// 市场网络由 E2E 路由控制；生产 UI、hook、解码及 IndexedDB 提交路径保持真实。
platform.searchWallpaperMarket = async (request) => {
  const url = new URL("https://wallpaper-market.test/search");
  url.search = new URLSearchParams({
    query: request.query ?? "",
    category: request.category ?? "all",
    color: request.color ?? "",
    page: String(request.page ?? 1),
  }).toString();
  const response = await fetch(url);
  if (!response.ok) throw new Error("Market fixture unavailable");
  return response.json();
};
platform.loadWallpaperMarketImage = async (request) => {
  const response = await fetch(
    `https://wallpaper-market.test/image?url=${encodeURIComponent(request.url)}&thumbnail=${Boolean(request.thumbnail)}`,
  );
  if (!response.ok) throw new Error("Market image fixture unavailable");
  return {
    mime: response.headers.get("content-type") as "image/png",
    bytes: new Uint8Array(await response.arrayBuffer()),
  };
};
if (new URLSearchParams(location.search).get("web") === "1") {
  delete platform.getBuiltinWallpaperUrl;
  delete platform.mountStartupScenePreview;
  delete platform.mountAemeathWallpaper;
  delete platform.validateStartupSceneMedia;
  delete platform.saveStartupSceneImage;
  delete platform.searchWallpaperMarket;
  delete platform.loadWallpaperMarketImage;
}

function AppearanceFixture() {
  const [project, setProject] = useState(false);
  return (
    <div className="p-6 bg-background text-foreground min-h-dvh">
      <button type="button" onClick={() => setProject(!project)}>
        {project ? "打开外观设置" : "返回项目"}
      </button>
      <div hidden={project} className="space-y-6 mt-6">
        <StartupAnimationSettingsSection />
        <WallpaperSettingsSection />
      </div>
      <div
        hidden={!project}
        style={{ height: 600 }}
        className="mt-6"
        data-testid="wallpaper-project"
      >
        <WorkspaceShellSurface isNativeDesktop isNarrowWebLayout={false} wallpaperVisible={project}>
          <aside
            data-workspace-sidebar-panel="true"
            data-testid="wallpaper-panel-probe"
            className="w-24 shrink-0 bg-sidebar"
          >
            Sidebar
          </aside>
          <section
            data-workspace-conversation-frame="true"
            className="h-full min-w-0 flex-1 bg-background"
          >
            <div className="h-full bg-background">
              <main className="h-full bg-background p-6">
                <p>Project</p>
                <textarea aria-label="Wallpaper project input" className="bg-input" />
              </main>
            </div>
          </section>
        </WorkspaceShellSurface>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <ServiceProvider services={services}>
    <PlatformProvider platform={platform}>
      <LCodeIntlProvider initialLocale="zh-CN">
        <TooltipProvider>
          <AppearanceFixture />
        </TooltipProvider>
      </LCodeIntlProvider>
    </PlatformProvider>
  </ServiceProvider>,
);
