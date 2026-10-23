import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { removeRetiredEmbeddedStorage } from "./retiredEmbeddedStorage.js";

test("清除当前应用的旧购买页分区，保留浏览器及供应商凭据，重复启动幂等", async () => {
  const root = await mkdtemp(join(tmpdir(), "lcode-retired-storage-"));
  try {
    for (const base of ["Partitions", "session/Partitions"]) {
      for (const name of ["zcode-coding-plan", "lcode-coding-plan", "lcode-embedded-browser"]) {
        const dir = join(root, base, name);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "Cookies"), "fixture");
      }
    }
    await writeFile(join(root, "provider_config.json"), "provider-fixture");
    await writeFile(join(root, "zcode-data-size-telemetry.json"), "legacy");
    await writeFile(join(root, "lcode-data-size-telemetry.json"), "current");
    const errors: unknown[] = [];
    const input = {
      userDataPath: root,
      sessionDataPath: join(root, "session"),
      onError: (_path: string, error: unknown) => errors.push(error),
    };
    await removeRetiredEmbeddedStorage(input);
    await removeRetiredEmbeddedStorage(input);
    assert.deepEqual(errors, []);
    for (const base of ["Partitions", "session/Partitions"]) {
      for (const name of ["zcode-coding-plan", "lcode-coding-plan"]) {
        await assert.rejects(readFile(join(root, base, name, "Cookies")), { code: "ENOENT" });
      }
      assert.equal(
        await readFile(join(root, base, "lcode-embedded-browser", "Cookies"), "utf8"),
        "fixture",
      );
    }
    assert.equal(await readFile(join(root, "provider_config.json"), "utf8"), "provider-fixture");
    await assert.rejects(readFile(join(root, "zcode-data-size-telemetry.json")), {
      code: "ENOENT",
    });
    assert.equal(await readFile(join(root, "lcode-data-size-telemetry.json"), "utf8"), "current");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
