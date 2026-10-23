import assert from "node:assert/strict";
import test from "node:test";
import type { ApiClient } from "@lcode/shared";
import { LCODE_DYNAMIC_WORKFLOW_MODE_ENV } from "@lcode/shared";
import { createApplicationConfigService } from "./applicationConfigService.js";

test("应用配置合并并发请求并复用快照，不请求账号或套餐接口", async () => {
  const urls: URL[] = [];
  const service = createApplicationConfigService({
    apiClient: {
      request: async (input: string | URL) => {
        urls.push(new URL(input));
        return Response.json({
          code: 0,
          data: {
            configs: {
              forceUpdate: { minimalVersion: " 3.0 " },
              dynamicWorkflow: { mode: "disabled" },
            },
          },
        });
      },
    } as ApiClient,
  });
  const [update, workflow] = await Promise.all([
    service.getForceUpdateConfig(),
    service.getDynamicWorkflowClientConfig(),
  ]);
  assert.deepEqual(update, { minimalVersion: "3.0" });
  assert.equal(workflow.enabled, false);
  await service.getForceUpdateConfig();
  assert.equal(urls.length, 1);
  assert.equal(urls[0]?.pathname, "/api/v1/client/configs");
  assert.equal(urls[0]?.searchParams.get("platform"), `${process.platform}-${process.arch}`);
  await service.getDynamicWorkflowClientConfig({ forceRefresh: true });
  assert.equal(urls.length, 2);
});

test("合并的应用配置请求必须共享业务错误校验", async () => {
  let requests = 0;
  const service = createApplicationConfigService({
    apiClient: {
      request: async () => {
        requests++;
        return Response.json({ code: 123, msg: "fixture config rejected" });
      },
    } as unknown as ApiClient,
  });
  const results = await Promise.allSettled([
    service.getForceUpdateConfig(),
    service.getForceUpdateConfig(),
  ]);
  assert.equal(requests, 1);
  for (const result of results) {
    assert.equal(result.status, "rejected");
    if (result.status === "rejected")
      assert.match(String(result.reason), /fixture config rejected/);
  }
});

test("本地工作流覆盖无需网络，远端失败使用默认工作流且更新查询保留失败", async (t) => {
  const original = process.env[LCODE_DYNAMIC_WORKFLOW_MODE_ENV];
  t.after(() => {
    if (original === undefined) delete process.env[LCODE_DYNAMIC_WORKFLOW_MODE_ENV];
    else process.env[LCODE_DYNAMIC_WORKFLOW_MODE_ENV] = original;
  });
  let calls = 0;
  const service = createApplicationConfigService({
    apiClient: {
      request: async () => {
        calls++;
        throw new Error("fixture unavailable");
      },
    } as unknown as ApiClient,
  });
  process.env[LCODE_DYNAMIC_WORKFLOW_MODE_ENV] = "disabled";
  assert.equal((await service.getDynamicWorkflowClientConfig()).enabled, false);
  assert.equal(calls, 0);
  delete process.env[LCODE_DYNAMIC_WORKFLOW_MODE_ENV];
  assert.equal((await service.getDynamicWorkflowClientConfig()).enabled, true);
  await assert.rejects(service.getForceUpdateConfig(), /fixture unavailable/);
});
