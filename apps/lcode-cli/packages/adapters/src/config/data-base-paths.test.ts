import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { parseEnvConfig } from "./env-config.adapter.js";
import { getDefaultConfigPath } from "./file-config.adapter.js";
import { createConfig } from "./config-factory.js";

test("CLI default memory, session database and config share the desktop data base", () => {
  const base = join(process.cwd(), "isolated-profile");
  const env = { LCODE_DATA_BASE_DIR: ` ${base} ` };
  const root = join(base, ".lcode");
  assert.deepEqual(parseEnvConfig(env).storage, {
    dir: root,
    sessionDbPath: join(root, "cli", "db", "db.sqlite"),
  });
  assert.equal(getDefaultConfigPath(env), join(root, "cli", "config.json"));
  const config = createConfig({ env, skipUserConfig: true });
  assert.equal(config.config.storage.dir, root);
  assert.equal(config.config.storage.sessionDbPath, join(root, "cli", "db", "db.sqlite"));
  assert.equal(config.sources.user.path, getDefaultConfigPath(env));
});

test("explicit storage/database and config paths keep precedence and legacy base is supported", () => {
  const env = {
    ZCODE_DATA_BASE_DIR: "legacy-profile",
    LCODE_DATA_BASE_DIR: "current-profile",
    LCODE_STORAGE_DIR: "explicit-storage",
    LCODE_SESSION_DB_PATH: "explicit.sqlite",
  };
  assert.deepEqual(parseEnvConfig(env).storage, {
    dir: "explicit-storage",
    sessionDbPath: "explicit.sqlite",
  });
  const config = createConfig({
    env,
    skipUserConfig: true,
    userConfigPath: "explicit-config.json",
  });
  assert.ok(config.sources.user.path.endsWith("explicit-config.json"));
  assert.equal(
    getDefaultConfigPath({ ZCODE_DATA_BASE_DIR: "legacy-profile" }),
    join(process.cwd(), "legacy-profile", ".lcode", "cli", "config.json"),
  );
  assert.equal(parseEnvConfig({}).storage, undefined);
  assert.equal(parseEnvConfig({ LCODE_DATA_BASE_DIR: "   " }).storage, undefined);
});
