import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  canonicalizeLCodePluginId,
  LCODE_CUA_OFFICIAL_PLUGIN_ID,
  lcodePluginIdAliases,
} from "../packages/shared/src/plugin-identity.ts";
import {
  getLCodePluginsOverview,
  resolveLCodePlugins,
  configureLCodePlugin,
  setLCodePluginEnabled,
  uninstallLCodeMarketplacePlugin,
  restoreBuiltinPlugin,
} from "../apps/lcode-cli/packages/bootstrap/src/plugins.ts";
import {
  ensureDefaultPluginMarketplaces,
  loadKnownMarketplacesSync,
  updateMarketplace,
  addMarketplace,
} from "../apps/lcode-cli/packages/adapters/src/plugins/index.ts";
import { extractPluginReferences } from "../apps/lcode-cli/packages/core/src/plugin-reference/references.ts";
import { findPluginReferenceCatalogEntry } from "../apps/lcode-cli/packages/core/src/plugin-reference/catalog.ts";
import { resolvePluginRuntimeFeatures } from "../apps/lcode-cli/packages/bootstrap/src/app/plugin-runtime-features.ts";
import {
  isOfficialCuaPluginEnabledForWorkspace,
  isPotentialLCodeCuaAgentMcpServer,
} from "../packages/lcode-cua/broker-server.js";

const current = LCODE_CUA_OFFICIAL_PLUGIN_ID;
const old = "computer-use@zcode-plugins-official";
const market = "zcode-plugins-official";
const retiredUrl = "https://cdn-zcode.z.ai/lcode/official-plugin/marketplace.json";

async function fixture(t, plugins = {}) {
  const root = await mkdtemp(join(tmpdir(), "cua-identity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = {
    env: {},
    workingDirectory: root,
    pluginStorageRoot: join(root, "plugins"),
    userConfigPath: join(root, "config.json"),
  };
  await writeFile(
    options.userConfigPath,
    JSON.stringify({ plugins, unrelated: { retained: true } }),
  );
  return { root, options };
}

test("legacy enabled Computer Use becomes one canonical identity and reuses original data", async (t) => {
  const { options } = await fixture(t, {
    enabledPlugins: { [old]: true, "browser-use@zcode-plugins-official": false },
  });
  const data = join(options.pluginStorageRoot, "data", old);
  await mkdir(data, { recursive: true });
  await writeFile(join(data, "fixture.txt"), "retained");
  const outcome = resolveLCodePlugins(options);
  const cua = outcome.plugins.filter((plugin) => plugin.name === "computer-use");
  assert.equal(cua.length, 1);
  assert.equal(cua[0].id, current);
  assert.equal(cua[0].marketplace, market);
  assert.equal(cua[0].enabled, true);
  assert.equal(cua[0].dataPath, data);
  assert.ok(
    outcome.plugins
      .filter((plugin) => plugin.name !== "computer-use")
      .every((plugin) => plugin.id.endsWith(`@${market}`)),
  );
  assert.equal(await readFile(join(data, "fixture.txt"), "utf8"), "retained");
  const overview = getLCodePluginsOverview(options);
  assert.equal(overview.marketplaces.find((item) => item.id === market).source.source, "builtin");
  assert.equal(overview.availablePlugins.filter((item) => item.id === current).length, 1);
  assert.equal(
    overview.availablePlugins.some((item) => item.id === old),
    false,
  );
});

test("canonical and legacy management selectors preserve options, disable, uninstall and restore", async (t) => {
  const { options } = await fixture(t, {
    enabledPlugins: { [old]: true },
    options: { [old]: { retained: "fixture-value" } },
  });
  await configureLCodePlugin({ ...options, pluginId: current, options: { newOption: true } });
  await setLCodePluginEnabled({ ...options, plugin: old, enabled: false });
  const saved = JSON.parse(await readFile(options.userConfigPath, "utf8"));
  assert.equal(saved.plugins.enabledPlugins[current], false);
  assert.equal(old in saved.plugins.enabledPlugins, false);
  assert.deepEqual(saved.plugins.options[current], { retained: "fixture-value", newOption: true });
  assert.deepEqual(saved.unrelated, { retained: true });
  await uninstallLCodeMarketplacePlugin({ ...options, pluginId: old, keepData: true });
  assert.equal(
    resolveLCodePlugins(options).plugins.some((plugin) => plugin.id === current),
    false,
  );
  assert.equal(
    getLCodePluginsOverview(options).restorableBuiltins.some((plugin) => plugin.id === current),
    true,
  );
  await restoreBuiltinPlugin({ ...options, pluginId: current });
  const restored = resolveLCodePlugins(options).plugins.find((plugin) => plugin.id === current);
  assert.ok(restored);
  assert.equal(restored.enabled, false);
});

test("legacy references deduplicate and still resolve against a frozen old catalog", () => {
  const ids = lcodePluginIdAliases(current);
  assert.deepEqual(
    extractPluginReferences(ids.map((id) => `[@电脑控制](plugin://${id})`).join(" ")).references,
    [current],
  );
  const entry = { pluginId: old, enabled: true };
  assert.equal(findPluginReferenceCatalogEntry({ plugins: [entry] }, current), entry);
  assert.equal(
    findPluginReferenceCatalogEntry({ plugins: [entry] }, "computer-use@personal"),
    undefined,
  );
});

test("workspace old disable overrides user canonical enable without changing the user account config", async (t) => {
  const { root, options } = await fixture(t, { enabledPlugins: { [current]: true } });
  const projectConfigPath = join(root, "workspace.json");
  await writeFile(
    projectConfigPath,
    JSON.stringify({ plugins: { enabledPlugins: { [old]: false } } }),
  );
  const userBefore = await readFile(options.userConfigPath, "utf8");
  const plugin = resolveLCodePlugins({ ...options, projectConfigPath }).plugins.find(
    (item) => item.id === current,
  );
  assert.equal(plugin.enabled, false);
  assert.equal(await readFile(options.userConfigPath, "utf8"), userBefore);
});

test("broker enablement and frozen runtime features use exactly the shared alias set", () => {
  for (const id of lcodePluginIdAliases(current)) {
    assert.equal(
      isPotentialLCodeCuaAgentMcpServer({
        command: "node",
        env: [{ name: "LCODE_PLUGIN_ID", value: id }],
      }),
      true,
    );
    assert.equal(
      isOfficialCuaPluginEnabledForWorkspace({
        env: {},
        userConfig: { plugins: { enabledPlugins: { [id]: true } } },
      }),
      true,
    );
    const features = resolvePluginRuntimeFeatures({
      plugins: [{ id, enabled: true, rootPath: "/fixture" }],
    });
    assert.equal(features.computerUse, true);
    assert.equal(
      isOfficialCuaPluginEnabledForWorkspace({
        env: {},
        userConfig: { plugins: { enabledPlugins: { [id]: true, [current]: false } } },
      }),
      false,
    );
    assert.equal(
      isOfficialCuaPluginEnabledForWorkspace({
        env: {},
        userConfig: { plugins: { enabledPlugins: { [current]: true }, suppressedBuiltins: [id] } },
      }),
      false,
    );
  }
  assert.equal(
    isOfficialCuaPluginEnabledForWorkspace({
      env: {},
      userConfig: { plugins: { enabledPlugins: { "computer-use@personal": true } } },
    }),
    false,
  );
  assert.equal(
    canonicalizeLCodePluginId("browser-use@zcode-plugins-official"),
    "browser-use@zcode-plugins-official",
  );
  assert.equal(
    isPotentialLCodeCuaAgentMcpServer({
      command: "node",
      env: [{ name: "LCODE_PLUGIN_ID", value: "computer-use@personal" }],
    }),
    false,
  );
});

test("retiring the old source preserves installed state and cached catalog across refresh and restart", async (t) => {
  const { options } = await fixture(t);
  const storageRoot = options.pluginStorageRoot;
  const catalogPath = join(storageRoot, "marketplaces", market, "marketplace.json");
  await mkdir(join(storageRoot, "marketplaces", market), { recursive: true });
  const catalog = JSON.stringify({
    name: market,
    plugins: [{ name: "retained-fixture", source: "fixture" }],
  });
  const installed = JSON.stringify({
    version: 1,
    plugins: [
      {
        id: `retained-fixture@${market}`,
        name: "retained-fixture",
        marketplace: market,
        scope: "user",
        version: "1",
        installPath: "fixture",
        installedAt: "fixture",
      },
    ],
  });
  await writeFile(catalogPath, catalog);
  await writeFile(join(storageRoot, "installed_plugins.json"), installed);
  const personal = {
    id: "personal",
    name: "personal",
    pluginCount: 0,
    source: { source: "directory", path: "/fixture/personal" },
  };
  await writeFile(
    join(storageRoot, "known_marketplaces.json"),
    JSON.stringify({
      marketplaces: [
        { id: market, name: market, source: { source: "url", url: retiredUrl }, pluginCount: 1 },
        personal,
      ],
    }),
  );
  const records = ensureDefaultPluginMarketplaces(storageRoot);
  assert.deepEqual(records.find((item) => item.id === market).source, { source: "builtin" });
  assert.deepEqual(
    records.find((item) => item.id === "personal"),
    personal,
  );
  await updateMarketplace({ marketplace: market, storageRoot });
  await updateMarketplace({ marketplace: market, storageRoot });
  assert.deepEqual(
    loadKnownMarketplacesSync(storageRoot).find((item) => item.id === market).source,
    { source: "builtin" },
  );
  assert.equal(await readFile(catalogPath, "utf8"), catalog);
  assert.equal(await readFile(join(storageRoot, "installed_plugins.json"), "utf8"), installed);
  assert.equal(
    (await readFile(join(storageRoot, "known_marketplaces.json"), "utf8")).includes(retiredUrl),
    false,
  );
  await assert.rejects(
    addMarketplace({ source: { source: "url", url: retiredUrl }, storageRoot }),
    /源已停用/,
  );
});
