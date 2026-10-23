import assert from "node:assert/strict";
import test from "node:test";
import {
  sidePaneTerminalSessionRegistry as registry,
  type SidePaneTerminalSessionEntry,
} from "./sidePaneTerminalSessionRegistry.js";

test("同 key 幂等复用；替换先释放旧资源；关闭不同 workspace 不串台", () => {
  registry.clearForTest();
  const disposed: string[] = [];
  function entry(key: string, scope: string): SidePaneTerminalSessionEntry {
    return {
      key,
      workspaceKey: scope,
      hostEl: { remove() {} },
      dispose: () => {
        disposed.push(key);
      },
    } as SidePaneTerminalSessionEntry;
  }
  const old = entry("old", "a"),
    next = entry("next", "a"),
    other = entry("other", "b");
  registry.register("key", old);
  registry.register("key", old);
  assert.deepEqual(disposed, []);
  registry.register("key", next);
  assert.deepEqual(disposed, ["old"]);
  registry.register("other", other);
  registry.releaseByPredicate((item) => item.workspaceKey === "a");
  assert.deepEqual(disposed, ["old", "next"]);
  assert.equal(registry.get("other"), other);
  registry.release("key");
  registry.release("other");
  assert.deepEqual(disposed, ["old", "next", "other"]);
});
