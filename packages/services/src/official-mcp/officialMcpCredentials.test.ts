import assert from "node:assert/strict";
import test from "node:test";
import {
  createOfficialMcpAuthHeadersResolver,
  resolveOfficialMcpCredentials,
} from "./officialMcpCredentials.js";

test("官方 MCP 仅使用应用登录身份，并发解析合并且登出后不缓存凭据", async () => {
  const values = new Map([
    ["oauth:active_provider", "bigmodel"],
    ["lcodejwttoken", "fixture-app-jwt"],
  ]);
  let loads = 0;
  const resolver = createOfficialMcpAuthHeadersResolver({
    credentialService: {
      load: async (key) => {
        loads++;
        return values.get(key);
      },
    },
  });
  const first = resolver.resolveHeaders();
  const concurrent = resolver.resolveHeaders();
  assert.equal(first, concurrent);
  assert.deepEqual(await first, { ok: true, headers: { Authorization: "Bearer fixture-app-jwt" } });
  assert.equal(loads, 4);
  values.delete("lcodejwttoken");
  assert.deepEqual(await resolver.resolveHeaders(), {
    ok: false,
    reason: "official_auth_unavailable",
  });
});

test("官方 MCP 解析遇到身份切换时重读，持续变化时拒绝拼接凭据", async () => {
  let reads = 0;
  const switched = await resolveOfficialMcpCredentials({
    credentialService: {
      load: async (key) => {
        const generation = Math.floor(reads++ / 2) === 0 ? 1 : 2;
        return key === "oauth:active_provider"
          ? generation === 1
            ? "zai"
            : "bigmodel"
          : `fixture-jwt-${generation}`;
      },
    },
  });
  assert.deepEqual(switched, {
    ok: true,
    snapshot: { jwt: "fixture-jwt-2", activeProvider: "bigmodel" },
  });
  reads = 0;
  const unstable = await resolveOfficialMcpCredentials({
    credentialService: {
      load: async (key) => {
        const generation = Math.floor(reads++ / 2);
        return key === "oauth:active_provider" ? "bigmodel" : `fixture-jwt-${generation}`;
      },
    },
  });
  assert.deepEqual(unstable, { ok: false, reason: "official_auth_unavailable" });
});
