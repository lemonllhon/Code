import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { createSettingService } from "./settingService.js";

test("model aliases persist through the Settings owner, reject cycles atomically and clear on cold reload", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lcode-usage-aliases-"));
  const previous = process.env.LCODE_DESKTOP_HOME_DIR;
  process.env.LCODE_DESKTOP_HOME_DIR = directory;
  try {
    const owner = createSettingService();
    await owner.update({ usageModelAliases: { "raw-a": "raw-b", "raw-b": "display" } });
    const cold = createSettingService();
    assert.deepEqual((await cold.get()).usageModelAliases, {
      "raw-a": "raw-b",
      "raw-b": "display",
    });
    const file = join(directory, ".lcode", "v2", "setting.json");
    const before = await readFile(file, "utf8");
    await assert.rejects(owner.update({ usageModelAliases: { a: "b", b: "a" } }));
    assert.equal(await readFile(file, "utf8"), before);
    await cold.update({ usageModelAliases: {} });
    assert.deepEqual((await createSettingService().get()).usageModelAliases, {});
  } finally {
    if (previous === undefined) delete process.env.LCODE_DESKTOP_HOME_DIR;
    else process.env.LCODE_DESKTOP_HOME_DIR = previous;
    const target = await realpath(directory);
    assert.ok(target.startsWith((await realpath(tmpdir())) + sep));
    await rm(target, { recursive: true, force: true });
  }
});
