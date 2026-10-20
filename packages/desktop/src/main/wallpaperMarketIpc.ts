import { ipcMain, net } from "electron";
import { PlatformChannels } from "@lcode/shared";
import { createWallpaperMarket } from "./wallpaperMarket.js";

export function registerWallpaperMarketIpc() {
  const market = createWallpaperMarket((url, options) => net.fetch(url, options));
  ipcMain.handle(PlatformChannels.SearchWallpaperMarket, (_event, request: unknown) =>
    market.search(request),
  );
  ipcMain.handle(PlatformChannels.LoadWallpaperMarketImage, (_event, request: unknown) =>
    market.image(request),
  );
}
