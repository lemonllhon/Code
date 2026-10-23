import assert from "node:assert/strict";
import test from "node:test";
import { CREDENTIAL_DECRYPT_ERROR_CODE } from "@lcode/shared";
import type { ICredentialService } from "../credential/credential.js";
import {
  createTelemetryAuthorizationLoader,
  createTelemetryMarketingParamsLoader,
  createTelemetryUserIdLoader,
} from "./credentialLoaders.js";

function credentials(values: Record<string, string>): ICredentialService {
  return {
    async load(key) {
      return values[key] ?? null;
    },
    async save() {
      assert.fail("telemetry must not save credentials");
    },
    async delete() {
      assert.fail("valid telemetry reads must not remove credentials");
    },
  };
}

test("telemetry keeps current account identity and persisted attribution after entry extraction", async () => {
  const service = credentials({
    "oauth:active_provider": "zai",
    "oauth:zai:user_info": JSON.stringify({ user_id: "fixture-a" }),
    lcodejwttoken: "fixture-token",
    "oauth:login_attribution": JSON.stringify({ utm_source: "fixture", ignored: "value" }),
  });
  assert.equal(await createTelemetryUserIdLoader(service)(), "fixture-a");
  const authorize = createTelemetryAuthorizationLoader(service);
  assert.equal(await authorize("fixture-a"), "Bearer fixture-token");
  assert.equal(await authorize("fixture-b"), null);
  assert.deepEqual(await createTelemetryMarketingParamsLoader(service)(), {
    utm_source: "fixture",
  });
});

test("account/provider changes during token reads cannot authorize the previous event", async () => {
  for (const change of ["provider", "account"] as const) {
    const values = {
      "oauth:active_provider": "zai",
      "oauth:zai:user_info": JSON.stringify({ id: "fixture-a" }),
      lcodejwttoken: "fixture-token",
    };
    const service = credentials(values);
    const original = service.load;
    service.load = async (key) => {
      const value = await original(key);
      if (key === "lcodejwttoken") {
        if (change === "provider") values["oauth:active_provider"] = "bigmodel";
        else values["oauth:zai:user_info"] = JSON.stringify({ id: "fixture-b" });
      }
      return value;
    };
    assert.equal(await createTelemetryAuthorizationLoader(service)("fixture-a"), null);
  }
});

test("decrypt failures remain read-only while unexpected identity read errors propagate", async () => {
  const decrypt = Object.assign(new Error("fixture decrypt failure"), {
    code: CREDENTIAL_DECRYPT_ERROR_CODE,
  });
  const service = credentials({});
  service.load = async () => {
    throw decrypt;
  };
  assert.equal(await createTelemetryUserIdLoader(service)(), "");
  assert.equal(await createTelemetryAuthorizationLoader(service)("fixture-a"), null);
  service.load = async () => {
    throw new Error("fixture storage unavailable");
  };
  await assert.rejects(createTelemetryUserIdLoader(service)(), /storage unavailable/);
});

test("unsupported providers, malformed identity and non-ASCII bearer values remain rejected", async () => {
  for (const [provider, identity, token] of [
    ["codex", '{"id":"fixture-a"}', "fixture-token"],
    ["zai", "invalid-json", "fixture-token"],
    ["bigmodel", '{"id":"fixture-a"}', "invalid\nheader"],
  ]) {
    const service = credentials({
      "oauth:active_provider": provider!,
      [`oauth:${provider}:user_info`]: identity!,
      lcodejwttoken: token!,
    });
    assert.equal(await createTelemetryAuthorizationLoader(service)("fixture-a"), null);
  }
});
