import assert from "node:assert/strict";
import test from "node:test";
import { DiffsWorkerPoolOwner } from "./diffsWorkerPoolOwner.js";

function fixture() {
  const instances: Array<{ terminated: number; initialize(): Promise<void>; terminate(): void }> =
    [];
  const resolve: Array<() => void> = [];
  const owner = new DiffsWorkerPoolOwner(() => {
    const item = {
      terminated: 0,
      initialize: () => new Promise<void>((done) => resolve.push(done)),
      terminate() {
        this.terminated++;
      },
    };
    instances.push(item);
    return item;
  });
  return { owner, instances, resolve };
}

test("空 owner 不创建资源；并发消费者复用，最后释放才 terminate", async () => {
  const f = fixture();
  assert.equal(f.instances.length, 0);
  const a = f.owner.acquire();
  const b = f.owner.acquire();
  assert.equal(f.instances.length, 1);
  f.resolve[0]!();
  await Promise.resolve();
  assert.equal(f.owner.getSnapshot().ready, true);
  a();
  a();
  await Promise.resolve();
  assert.equal(f.instances[0]!.terminated, 0);
  b();
  await Promise.resolve();
  assert.equal(f.instances[0]!.terminated, 1);
  assert.equal(f.owner.getSnapshot().manager, undefined);
});

test("同一 commit 释放再进入复用；旧代初始化不能覆盖重开", async () => {
  const f = fixture();
  f.owner.acquire()();
  const release = f.owner.acquire();
  await Promise.resolve();
  assert.equal(f.instances.length, 1);
  release();
  await Promise.resolve();
  const nextRelease = f.owner.acquire();
  f.resolve[0]!();
  await Promise.resolve();
  assert.equal(f.owner.getSnapshot().ready, false);
  f.resolve[1]!();
  await Promise.resolve();
  assert.equal(f.owner.getSnapshot().ready, true);
  nextRelease();
  await Promise.resolve();
});

test("初始化失败释放物理资源并开放现有回退，下次重新进入可重试", async () => {
  let created = 0;
  let terminated = 0;
  const owner = new DiffsWorkerPoolOwner(() => {
    created++;
    return {
      initialize: async () => {
        throw new Error("fixture");
      },
      terminate: () => {
        terminated++;
      },
    };
  });
  const release = owner.acquire();
  await Promise.resolve();
  assert.equal(owner.getSnapshot().ready, true);
  assert.equal(owner.getSnapshot().manager, undefined);
  assert.equal(terminated, 1);
  release();
  await Promise.resolve();
  owner.acquire()();
  await Promise.resolve();
  assert.equal(created, 2);
});
