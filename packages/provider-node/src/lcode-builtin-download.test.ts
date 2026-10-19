import assert from "node:assert/strict";
import test from "node:test";
import {
  describeProviderProvisioningFailure,
  formatProviderProvisioningFailure,
} from "@lcode/shared";
import { downloadLCodeBuiltinRelease } from "./lcode-builtin-download.js";

const sensitive = "fixture-secret https://private.example.invalid/?token=fixture /private/account";
const config = {
  code: 0,
  data: { configs: { builtin_provider_config_json: "https://fixture.invalid/release" } },
};

const cases = [
  {
    name: "控制面 HTTP",
    stage: "client-config",
    reason: "http-error",
    httpStatus: 403,
    code: "network-error",
    request: async () => new Response(sensitive, { status: 403 }),
  },
  {
    name: "CDN HTTP",
    stage: "cdn",
    reason: "http-error",
    httpStatus: 502,
    code: "network-error",
    request: async (_url: string | URL, _init: RequestInit, call: number) =>
      call === 0 ? Response.json(config) : new Response(sensitive, { status: 502 }),
  },
  {
    name: "无效 JSON",
    stage: "client-config",
    reason: "invalid-response",
    code: "invalid-config",
    request: async () => new Response(sensitive),
  },
  {
    name: "无效 schema",
    stage: "client-config",
    reason: "invalid-schema",
    code: "invalid-config",
    request: async () => Response.json({ code: sensitive }),
  },
  {
    name: "空正文",
    stage: "client-config",
    reason: "empty-body",
    code: "invalid-config",
    request: async () => new Response(null),
  },
  {
    name: "正文过大",
    stage: "client-config",
    reason: "body-limit",
    code: "invalid-config",
    request: async () => new Response(new Uint8Array(10_000_001)),
  },
  {
    name: "网络异常",
    stage: "client-config",
    reason: "network-error",
    code: "network-error",
    request: async () => {
      throw new Error(sensitive, {
        cause: Object.assign(new Error(sensitive), { code: "ENOTFOUND" }),
      });
    },
  },
] as const;

for (const scenario of cases) {
  test(`Built-in 下载诊断保留${scenario.name}原因，不包含原始请求材料`, async () => {
    let call = 0;
    await assert.rejects(
      downloadLCodeBuiltinRelease({
        endpointOrigin: "https://fixture.invalid",
        platform: "linux-x64",
        appVersion: "0.0.0-fixture",
        request: (url, init) => scenario.request(url, init, call++),
      }),
      (error: unknown) => {
        const failure = describeProviderProvisioningFailure("provider-runtime", error);
        assert.equal(failure.code, scenario.code);
        assert.deepEqual(failure.download, {
          stage: scenario.stage,
          reason: scenario.reason,
          ...("httpStatus" in scenario ? { httpStatus: scenario.httpStatus } : {}),
        });
        if (scenario.name === "网络异常") assert.equal(failure.systemCode, "ENOTFOUND");
        const output =
          JSON.stringify(error) +
          JSON.stringify(failure) +
          formatProviderProvisioningFailure(failure);
        for (const secret of ["fixture-secret", "private.example", "/private/account", "token="])
          assert.ok(!output.includes(secret));
        if ("httpStatus" in scenario) assert.ok(output.includes(String(scenario.httpStatus)));
        return true;
      },
    );
  });
}

test("Built-in 下载取消保留固定原因，不复制任意 Abort reason", async () => {
  const controller = new AbortController();
  controller.abort(new Error(sensitive));
  await assert.rejects(
    downloadLCodeBuiltinRelease({
      endpointOrigin: "https://fixture.invalid",
      platform: "linux-x64",
      appVersion: "0.0.0-fixture",
      signal: controller.signal,
      request: async () => {
        throw new Error("不应发送请求");
      },
    }),
    (error: unknown) => {
      const failure = describeProviderProvisioningFailure("provider-runtime", error);
      assert.equal(failure.code, "cancelled");
      assert.deepEqual(failure.download, { stage: "client-config", reason: "cancelled" });
      assert.ok(!JSON.stringify(error).includes("fixture-secret"));
      return true;
    },
  );
});
