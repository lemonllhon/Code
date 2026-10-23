import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("独立 API Key 供应商模板保留 Coding Plan 接入", async () => {
  const { config } = JSON.parse(await read("config/provider/lcode-builtin.json"));
  const templates = config.providerConfigRules.templateRules;
  for (const [id, name, endpoint] of [
    ["zai-api", "Z.ai Coding Plan", "https://api.z.ai/api/anthropic"],
    ["bigmodel-api", "BigModel Coding Plan", "https://open.bigmodel.cn/api/anthropic"],
  ]) {
    const template = templates.find((item) => item.templateId === id);
    assert.ok(template, `${id} 模板仍可添加`);
    assert.equal(template.templateNameMap["zh-CN"], name);
    assert.equal(template.config.access.type, "zhipu-coding-plan-api-key");
    assert.equal(template.config.api.baseUrl, endpoint);
    assert.ok(template.config.builtinModelIds.length > 0);
  }
});

test("应用不再装配订阅支付服务、购买 WebView 或闲时调度协议", async () => {
  for (const path of [
    "packages/services/src/node.ts",
    "packages/services/src/accessor.ts",
    "packages/client/src/remoteServiceAccess.ts",
    "packages/shared/src/channels.ts",
    "packages/desktop/src/main/desktopWindowChrome.ts",
    "packages/desktop/src/main/desktopCommandHandlers.ts",
    "packages/desktop/src/main/desktopDataBaseDirBootstrap.ts",
    "packages/desktop/src/scheduler/schedulerProtocol.ts",
    "packages/ui/src/settings/ModelProviderSection.tsx",
  ]) {
    assert.doesNotMatch(
      await read(path),
      /CodingPlanSubscription|codingPlanSubscription|CodingPlanWebview|codingPlanWebview|persist:(?:zcode|lcode)-coding-plan|offpeak-(?:dispatch-(?:request|result)|active-count)/,
    );
  }
});
