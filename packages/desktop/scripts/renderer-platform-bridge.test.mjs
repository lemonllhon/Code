import assert from "node:assert/strict";
import "./preload-sandbox.test.mjs";
import test from "node:test";
import { loadSource } from "./main-runtime-test-fixture.mjs";

test("legacy preload returns shared Chrome import and guest admission failures", async (t) => {
  const { desktopBrowserPlatformBridge: bridge } = await loadSource(
    t,
    "src/renderer/src/desktopBrowserPlatformBridge.ts",
    {},
    { banner: { js: "const window={lcode:{}};" } },
  );
  const result = await bridge.importChromeBrowserData();
  assert.equal(result.success, false);
  assert.equal(result.error, "chrome_import_not_supported");
  assert.deepEqual(await bridge.browserViewAttachGuest({ key: "tab", webContentsId: 1 }), {
    ok: false,
    reason: "not-found",
    recoveryRequested: false,
  });
  assert.equal(bridge.printPageToPdf, undefined);
  assert.equal(bridge.getPathForFile({}), null);
});
