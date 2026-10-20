import { build, preview } from "vite";
import { resolve } from "node:path";

export async function openWallpaperFixture({ page, electron, userData, desktopRoot, common, t }) {
  // 设置页沿用生产打包链路，避免 dev noDiscovery 把既有 CJS 依赖直接作为 ESM 加载。
  const outDir = resolve(userData, "wallpaper-build");
  await build({
    ...common,
    publicDir: false,
    build: {
      outDir,
      emptyOutDir: true,
      rollupOptions: { input: resolve(desktopRoot, "src/renderer/index.html") },
    },
  });
  if (electron) {
    await electron.evaluate(
      async ({ BrowserWindow }, path) =>
        BrowserWindow.getAllWindows()[0].loadFile(path, {
          query: { ready: "1", settings: "1", locale: "zh-CN" },
        }),
      resolve(outDir, "index.html"),
    );
  } else {
    const staticServer = await preview({
      configFile: false,
      root: desktopRoot,
      build: { outDir },
      preview: { host: "127.0.0.1", port: 0 },
    });
    t.after(() => new Promise((resolve) => staticServer.httpServer.close(resolve)));
    await page.goto(`${staticServer.resolvedUrls.local[0]}?ready=1&settings=1&locale=zh-CN`);
  }
  await page.getByRole("combobox", { name: "壁纸选择", exact: true }).waitFor();
}
