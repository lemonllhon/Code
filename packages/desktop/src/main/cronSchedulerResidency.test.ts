import assert from "node:assert/strict";
import test from "node:test";
import { createCronSchedulerResidency } from "./cronSchedulerResidency.js";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
function fixture() {
  let demand: boolean | null = false;
  let query: (() => Promise<boolean | null>) | undefined;
  const children: {
    wake: () => void;
    dispose: () => Promise<void>;
    exit: (idle?: boolean) => void;
    wakes: number;
    disposed: boolean;
  }[] = [];
  const owner = createCronSchedulerResidency({
    readDemand: () => query?.() ?? Promise.resolve(demand),
    spawn: (exit) => {
      const child = {
        wakes: 0,
        disposed: false,
        wake() {
          this.wakes++;
        },
        dispose: async () => {
          child.disposed = true;
        },
        exit,
      };
      children.push(child);
      return child;
    },
    onError() {},
  });
  return {
    owner,
    children,
    setDemand: (value: boolean | null) => {
      demand = value;
    },
    setQuery: (value?: () => Promise<boolean | null>) => {
      query = value;
    },
  };
}

test("empty startup stays stopped; repeated invalidations retain one process; exit then demand starts new generation", async () => {
  const f = fixture();
  f.owner.invalidate();
  await flush();
  assert.equal(f.children.length, 0);
  f.owner.start();
  await flush();
  assert.equal(f.children.length, 0);
  f.setDemand(true);
  for (let i = 0; i < 20; i++) f.owner.invalidate();
  await flush();
  assert.equal(f.children.length, 1);
  f.setDemand(false);
  f.owner.invalidate();
  await flush();
  assert.equal(f.children[0]!.disposed, false, "Main must not force-dispose running work");
  f.setDemand(true);
  f.owner.invalidate();
  await flush();
  assert.equal(f.children.length, 1, "wake cannot bypass physical exit barrier");
  f.children[0]!.exit();
  await flush();
  assert.equal(f.children.length, 2);
  f.children[0]!.exit();
  assert.equal(f.owner.current, f.children[1], "late old exit cannot clear new owner");
  await f.owner.dispose();
  f.owner.invalidate();
  f.children[1]!.exit();
  await flush();
  assert.equal(f.children.length, 2);
});

test("query results invalidated by a concurrent write or Host change cannot start an obsolete generation", async () => {
  const f = fixture();
  let resolve!: (value: boolean | null) => void;
  f.setQuery(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  f.owner.start();
  await flush();
  f.setQuery();
  f.setDemand(false);
  f.owner.invalidate();
  resolve(true);
  await flush();
  assert.equal(f.children.length, 0);
  f.setDemand(null);
  f.owner.invalidate();
  await flush();
  assert.equal(f.children.length, 0, "no Host is not proof to spawn before storage ready");
  f.setDemand(true);
  f.owner.invalidate();
  await flush();
  assert.equal(f.children.length, 1);
  await f.owner.dispose();
});

test("query failure preserves availability without idle-exit restart spin", async () => {
  const f = fixture();
  f.setQuery(async () => {
    throw new Error("db unavailable");
  });
  f.owner.start();
  await flush();
  assert.equal(f.children.length, 1);
  f.children[0]!.exit();
  await flush();
  assert.equal(f.children.length, 1);
  f.owner.invalidate();
  await flush();
  assert.equal(f.children.length, 2);
  await f.owner.dispose();
});

test("unexpected process exit backs off; app disposal cancels pending restart", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture();
  f.setDemand(true);
  f.owner.start();
  await flush();
  f.children[0]!.exit(false);
  await flush();
  assert.equal(f.children.length, 1);
  t.mock.timers.tick(5_000);
  await flush();
  assert.equal(f.children.length, 2);
  f.children[1]!.exit(false);
  await f.owner.dispose();
  t.mock.timers.tick(5_000);
  await flush();
  assert.equal(f.children.length, 2);
});

test("a failed fork retries without requiring another automation mutation", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let attempts = 0;
  const owner = createCronSchedulerResidency({
    readDemand: async () => true,
    spawn: () => {
      if (++attempts === 1) throw new Error("spawn failed");
      return { wake() {}, dispose: async () => {} };
    },
    onError() {},
  });
  owner.start();
  await flush();
  assert.equal(attempts, 1);
  t.mock.timers.tick(5_000);
  await flush();
  assert.equal(attempts, 2);
  assert.ok(owner.current);
  await owner.dispose();
});
