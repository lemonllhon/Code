import assert from "node:assert/strict";
import test from "node:test";
import {
  describeProviderProvisioningFailure,
  formatProviderProvisioningFailure,
  providerProvisioningFailureSchema,
  runProviderProvisioningStage,
} from "./provider-provisioning-diagnostics.js";

const sensitive =
  "fixture-token https://private.example.invalid/?key=fixture-secret /home/fixture/account.json\npassword=fixture";

test("Provisioning 诊断只保留阶段、受限错误码和候选状态，不转抄任意文本", () => {
  const error = Object.assign(new Error(sensitive), {
    code: "LCODE_BUILTIN_CONFIG_UNAVAILABLE",
    availability: { bundled: "missing", active: "permission-denied" },
    stack: sensitive,
  });
  const failure = describeProviderProvisioningFailure("remote-runtime", error);
  assert.deepEqual(failure, {
    stage: "remote-runtime",
    code: "builtin-unavailable",
    availability: { bundled: "missing", active: "permission-denied" },
  });
  const output = JSON.stringify(failure) + formatProviderProvisioningFailure(failure);
  for (const part of [
    "fixture-token",
    "private.example",
    "/home/fixture",
    "password=",
    "fixture-secret",
  ])
    assert.ok(!output.includes(part));
  assert.match(output, /内置 Provider 配置|随包配置/);
});

test("包装错误的 cause 保留文件/解密诊断，未知 message 不作为匹配依据", async () => {
  const error = new Error(sensitive, {
    cause: Object.assign(new Error(sensitive), { code: "EACCES" }),
  });
  assert.deepEqual(describeProviderProvisioningFailure("local-personal", error), {
    stage: "local-personal",
    code: "permission-denied",
    systemCode: "EACCES",
  });
  await assert.rejects(
    runProviderProvisioningStage("local-credentials", async () => {
      throw Object.assign(new Error(sensitive), { code: "LCODE_CREDENTIAL_DECRYPT_FAILED" });
    }),
    (error: unknown) => {
      assert.deepEqual(describeProviderProvisioningFailure("remote-request", error), {
        stage: "local-credentials",
        code: "credential-decrypt",
      });
      return true;
    },
  );
  assert.equal(
    describeProviderProvisioningFailure("remote-request", new Error(sensitive)).code,
    "unknown",
  );
});

test("诊断 schema 不接受原始 message、URL、stack 或任意 systemCode", () => {
  for (const download of [
    { stage: "cdn", reason: "http-error", httpStatus: 403, url: sensitive },
    { stage: sensitive, reason: "http-error" },
    { stage: "cdn", reason: "http-error", httpStatus: 999 },
  ]) {
    assert.equal(
      providerProvisioningFailureSchema.safeParse({
        stage: "provider-runtime",
        code: "network-error",
        download,
      }).success,
      false,
    );
  }
  assert.equal(
    providerProvisioningFailureSchema.safeParse({
      stage: "remote-runtime",
      code: "builtin-unavailable",
      message: sensitive,
    }).success,
    false,
  );
  assert.equal(
    providerProvisioningFailureSchema.safeParse({
      stage: "remote-runtime",
      code: "unknown",
      systemCode: sensitive,
    }).success,
    false,
  );
  const error = Object.assign(new Error(sensitive), {
    code: "LCODE_BUILTIN_CONFIG_UNAVAILABLE",
    availability: { bundled: sensitive, active: "missing" },
  });
  assert.ok(
    !JSON.stringify(describeProviderProvisioningFailure("remote-runtime", error)).includes(
      "fixture",
    ),
  );
});
