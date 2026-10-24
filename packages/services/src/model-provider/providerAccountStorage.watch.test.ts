import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

test(
  "account change watcher consumes directory storms while a refresh is blocked",
  { timeout: 30_000 },
  async () => {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        "--no-warnings",
        "--import",
        "tsx",
        fileURLToPath(new URL("./providerAccountStorage.watch.fixture.ts", import.meta.url)),
      ],
      { env: { ...process.env, NODE_TEST_CONTEXT: undefined }, timeout: 25_000 },
    );
    const result = JSON.parse(stdout);
    assert.equal(result.warnings, 0, "slow reads must not fill fs.promises.watch's event queue");
    assert.equal(result.maxActive, 1);
    assert.equal(result.finalRead, true, "the final credential replacement must still be observed");
    assert.equal(result.observed.at(-1), "2");
  },
);
