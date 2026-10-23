import assert from "node:assert/strict";
import test from "node:test";
import { CodeHighlightCache } from "./codeHighlightCache.js";

const tick = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};
function fixture(maxEntries = 2, maxBytes = 300) {
  let calls = 0;
  let disposed = 0;
  const cache = new CodeHighlightCache<string, { dispose(): void }>({
    maxEntries,
    maxBytes,
    maxEngines: 1,
    createEngine: async () => ({
      dispose: () => {
        disposed++;
      },
    }),
    tokenize: (_engine, code) => {
      calls++;
      return code;
    },
    estimateBytes: (key, result) => (key.length + result.length) * 2,
  });
  return { cache, calls: () => calls, disposed: () => disposed };
}
test("同键单飞、异步通知和取消订阅；内容中段不同不误命中", async () => {
  const f = fixture();
  const seen: string[] = [];
  const cb = (value: string) => seen.push(value);
  f.cache.highlight("one", "ts", "light", cb);
  f.cache.highlight("one", "ts", "light");
  f.cache.unsubscribe("one", "ts", "light", cb);
  await tick();
  assert.equal(f.calls(), 1);
  assert.deepEqual(seen, []);
  assert.equal(f.cache.highlight("one", "ts", "light", cb), "one");
  assert.deepEqual(seen, []);
  await tick();
  assert.deepEqual(seen, ["one"]);
  const head = "a".repeat(100),
    tail = "b".repeat(100);
  f.cache.highlight(head + "x" + tail, "ts", "light");
  await tick();
  assert.equal(f.cache.highlight(head + "y" + tail, "ts", "light"), null);
  await tick();
  assert.equal(f.calls(), 3);
});
test("LRU 与字节预算有界，超大结果不保留，空闲引擎真实 dispose", async () => {
  const f = fixture();
  for (const code of ["a", "b", "c"]) {
    f.cache.highlight(code, "ts", "light");
    await tick();
  }
  assert.equal(f.cache.stats().entries, 2);
  assert.equal(f.cache.highlight("a", "ts", "light"), null);
  await tick();
  f.cache.highlight("z".repeat(500), "js", "dark");
  await tick();
  assert.ok(f.cache.stats().bytes <= 300);
  assert.equal(f.cache.stats().engines, 1);
  assert.equal(f.disposed(), 1);
  assert.equal(f.cache.stats().inflight, 0);
});
test("失败不保留 poison promise；在飞引擎不驱逐，结清后重新限额", async () => {
  let attempts = 0;
  let disposed = 0;
  let finish!: () => void;
  const cache = new CodeHighlightCache<string, { dispose(): void }>({
    maxEntries: 2,
    maxBytes: 1000,
    maxEngines: 1,
    createEngine: async (key) => {
      attempts++;
      if (key.startsWith("bad") && attempts === 1) throw Error("fixture");
      if (key.startsWith("slow"))
        await new Promise<void>((done) => {
          finish = done;
        });
      return {
        dispose: () => {
          disposed++;
        },
      };
    },
    tokenize: (_e, code) => code,
    estimateBytes: () => 1,
  });
  cache.highlight("a", "bad", "t");
  await tick();
  cache.highlight("a", "bad", "t");
  await tick();
  assert.equal(attempts, 2);
  cache.highlight("b", "slow", "t");
  cache.highlight("c", "other", "t");
  await tick();
  finish();
  await tick();
  assert.equal(cache.stats().engines, 1);
  assert.ok(disposed >= 2);
  assert.equal(cache.stats().inflight, 0);
});
