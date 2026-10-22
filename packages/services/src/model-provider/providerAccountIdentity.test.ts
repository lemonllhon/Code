import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admitProviderAccount } from "./providerAccountAdmission.js";
import { ProviderAccountStorage } from "./providerAccountStorage.js";
import { ProviderAccounts } from "./providerAccounts.js";
import type { StoredAccount } from "./providerAccountStoreSchema.js";

test("Kiro keeps one email's login providers separate and reauthorizes only the same identity", () => {
  const accounts: StoredAccount[] = [];
  const channel = { id: "kiro", name: "Kiro" };
  const google = {
    type: "oauth" as const,
    accountId: "fixture-user",
    loginProvider: "Google",
    refresh: "fixture-google",
  };
  const first = admitProviderAccount(accounts, channel, google);
  const github = admitProviderAccount(accounts, channel, {
    ...google,
    loginProvider: "Github",
    refresh: "fixture-github",
  });
  assert.equal(github.status, "added");
  assert.notEqual(github.connectionId, first.connectionId);
  const renewed = admitProviderAccount(accounts, channel, {
    ...google,
    loginProvider: " google ",
    refresh: "fixture-renewed",
  });
  assert.equal(renewed.status, "updated");
  assert.equal(renewed.connectionId, first.connectionId);
  assert.equal(accounts.length, 2);
  const oldGeneration = accounts[0]!.generation;
  admitProviderAccount(accounts, channel, {
    type: "oauth",
    accountId: "fixture-user",
    refresh: "fixture-renewed",
  });
  assert.equal(accounts[0]!.grant.loginProvider, " google ");
  assert.ok(accounts[0]!.generation >= oldGeneration);
});

test("Devin same-email organizations with different API keys never merge on an email label", () => {
  const accounts: StoredAccount[] = [];
  const channel = { id: "devin", name: "Devin" };
  for (const orgId of ["fixture-org-a", "fixture-org-b"])
    assert.equal(
      admitProviderAccount(accounts, channel, {
        type: "api",
        key: orgId,
        metadata: { email: "fixture-user", orgId },
      }).status,
      "added",
    );
  assert.equal(accounts.length, 2);
});

for (const sameCredential of [true, false])
  test(`Kiro upgrades legacy identity only with matching private credentials (${sameCredential})`, () => {
    const accounts: StoredAccount[] = [];
    const channel = { id: "kiro", name: "Kiro" };
    const first = admitProviderAccount(accounts, channel, {
      type: "oauth",
      accountId: "fixture-user",
      refresh: "fixture-old",
    });
    accounts[0]!.enabled = false;
    accounts[0]!.displayName = "Fixture alias";
    const next = admitProviderAccount(accounts, channel, {
      type: "oauth",
      accountId: "fixture-user",
      loginProvider: "Google",
      refresh: sameCredential ? "fixture-old" : "fixture-other",
    });
    assert.equal(next.status, sameCredential ? "updated" : "added");
    assert.equal(next.connectionId === first.connectionId, sameCredential);
    assert.equal(accounts.length, sameCredential ? 1 : 2);
    assert.equal(accounts[0]!.enabled, false);
    assert.equal(accounts[0]!.displayName, "Fixture alias");
  });

for (const error of ["dependency_required", "sign_in_required", undefined] as const)
  test(`reauthorization clears blocking check-in failure ${error ?? "success is retained"}`, () => {
    const accounts: StoredAccount[] = [];
    const channel = { id: "qoder", name: "Fixture" };
    admitProviderAccount(accounts, channel, {
      type: "oauth",
      identityKey: "fixture",
      access: "fixture-old",
    });
    const result = {
      outcome: error ? ("failed" as const) : ("claimed" as const),
      ...(error ? { error } : {}),
      at: "2026-10-22T00:00:00Z",
      day: "2026-10-22",
    };
    accounts[0]!.checkin = { automatic: true, result };
    admitProviderAccount(accounts, channel, {
      type: "oauth",
      identityKey: "fixture",
      access: "fixture-new",
    });
    assert.equal(accounts[0]!.checkin?.automatic, true);
    assert.deepEqual(accounts[0]!.checkin?.result, error ? undefined : result);
  });

test("adding known identity upgrades an identical old API key but keeps different organizations apart", () => {
  const accounts: StoredAccount[] = [];
  const channel = { id: "factory", name: "Factory" };
  const first = admitProviderAccount(accounts, channel, {
    type: "api",
    key: "fixture-key",
    accountId: "user",
  });
  accounts[0]!.authorizationStatus = "expired";
  const upgraded = admitProviderAccount(accounts, channel, {
    type: "api",
    key: "fixture-key",
    identityKey: "user:org-a",
    accountId: "user",
  });
  assert.equal(upgraded.status, "updated");
  assert.equal(upgraded.connectionId, first.connectionId);
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0]!.authorizationStatus, undefined);
  admitProviderAccount(accounts, channel, { type: "api", key: "fixture-key" });
  assert.equal(accounts[0]!.grant.identityKey, "user:org-a");
  const other = admitProviderAccount(accounts, channel, {
    type: "api",
    key: "fixture-key",
    identityKey: "user:org-b",
  });
  assert.equal(other.status, "added");
  assert.equal(accounts.length, 2);
});

test("authorization applies method defaults and supplies the Host identity instead of client input", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "oauth-host-input-"));
  const saved = new Map<string, string>();
  const inputs: Record<string, string>[] = [];
  const service = new ProviderAccounts({
    lockPath: join(dir, "accounts"),
    channels: [{ id: "chatgpt-api", name: "ChatGPT API" }],
    credentials: {
      load: async (key) => saved.get(key) ?? null,
      save: async (key, value) => {
        saved.set(key, value);
      },
      delete: async (key) => {
        saved.delete(key);
      },
    },
    factory: async () => ({
      methods: async () => [
        {
          id: "login",
          label: "Login",
          type: "oauth",
          fields: [
            {
              key: "site",
              label: "Site",
              type: "select",
              defaultValue: "a",
              options: [{ value: "a", label: "A" }],
            },
            {
              key: "hidden",
              label: "Hidden",
              type: "text",
              condition: { key: "site", value: "b" },
            },
          ],
        },
      ],
      authorize: async (_method, value) => {
        inputs.push(value);
        return { method: "code", complete: async () => ({ type: "oauth", access: "fixture" }) };
      },
      models: async () => [],
      fetch: async () => new Response(),
    }),
  });
  t.after(async () => {
    await service.dispose();
    await rm(dir, { recursive: true, force: true });
  });
  await service.startAuthorization({
    channelId: "chatgpt-api",
    methodId: "login",
    inputs: { hostId: "untrusted" },
  });
  await service.startAuthorization({ channelId: "chatgpt-api", methodId: "login" });
  assert.equal(inputs[0]!.site, "a");
  assert.match(inputs[0]!.hostId!, /^urn:uuid:/u);
  assert.equal(inputs[0]!.hostId, inputs[1]!.hostId);
  assert.equal(JSON.stringify(await service.getView()).includes(inputs[0]!.hostId!), false);
});

test("Host identity persists across storage instances and concurrent first authorization", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "oauth-host-id-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const saved = new Map<string, string>();
  const credentials = {
    load: async (key: string) => saved.get(key) ?? null,
    save: async (key: string, value: string) => {
      saved.set(key, value);
    },
    delete: async (key: string) => {
      saved.delete(key);
    },
  };
  const a = new ProviderAccountStorage(credentials, join(dir, "accounts"));
  const b = new ProviderAccountStorage(credentials, join(dir, "accounts"));
  const ids = await Promise.all([a.hostId(), b.hostId()]);
  assert.match(ids[0]!, /^urn:uuid:[0-9a-f-]{36}$/u);
  assert.equal(ids[0], ids[1]);
  assert.equal(await b.hostId(), ids[0]);
  assert.deepEqual(await a.read(), []);
});

test("legacy account IDs keep workspace boundaries when only the new grant has composite identity", () => {
  const accounts: StoredAccount[] = [];
  const channel = { id: "codex", name: "Codex" };
  admitProviderAccount(accounts, channel, {
    type: "oauth",
    refresh: "fixture",
    accountId: "workspace-a",
  });
  const second = admitProviderAccount(accounts, channel, {
    type: "oauth",
    refresh: "fixture",
    accountId: "workspace-b",
    identityKey: "user:workspace-b",
  });
  assert.equal(second.status, "added");
  assert.equal(accounts.length, 2);
});
