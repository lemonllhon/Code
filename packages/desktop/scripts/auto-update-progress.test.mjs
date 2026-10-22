import assert from "node:assert/strict";
import test from "node:test";
import { loadMacUpdateRuntime } from "./main-runtime-test-fixture.mjs";

test("progress storms keep product completion while production logs remain bounded per download", async (t) => {
  const runtime = await loadMacUpdateRuntime(t, {
    "./logger.js": `import {events} from 'electron'; export const logger={info:message=>events.push(message),warn(){},error(){},debug(){}};`,
    "./verifiedUpdateArtifact.js": `
      export const selectVerifiedUpdateArtifact=()=>({url:'https://fixture.invalid/LCode.dmg',fileName:'LCode.dmg',size:10000,sha512:'fixture'});
      export const downloadVerifiedUpdateArtifact=async options=>{for(let i=0;i<=10000;i++)options.onProgress(i,10000);return '/fixture/verified-LCode.dmg'};
    `,
  });
  t.after(() => runtime.initAutoUpdater({ enabled: false }));
  await runtime.initAutoUpdater({});
  for (const version of ["4.0.0", "4.0.1"]) {
    runtime.testElectron.events.length = 0;
    runtime.testElectron.updater.emit("update-available", { version });
    await new Promise((resolve) => setImmediate(resolve));
    runtime.testElectron.handlers.get("lcode:download-update")();
    await new Promise((resolve) => setImmediate(resolve));
    const progress = runtime.testElectron.events.filter((message) =>
      message.includes("download progress:"),
    );
    assert.equal(progress.length, 11);
    assert.match(progress[0], /0%/);
    assert.match(progress.at(-1), /100%/);
    assert.equal(runtime.getAutoUpdaterState().kind, "update-downloaded");
  }
});
