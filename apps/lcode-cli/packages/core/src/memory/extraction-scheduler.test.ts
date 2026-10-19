import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import type { MessageId } from "@lcode/contracts";
import { createMemoryExtractionScheduler, type MemoryExtractionSnapshot } from "./extraction.js";

function descriptor(id: string): MemoryExtractionSnapshot {
  return {
    boundaryMessageId: id as MessageId,
    durableMessages: [],
    memoryRoot: "fixture",
    workspaceRoot: "fixture",
    workingDirectory: "fixture",
    evidenceOnly: true,
  };
}
test("queue admission starts no pending evidence IO and drops overflow without invoking its loader", async () => {
  let release!: () => void;
  let started!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const reads: number[] = [];
  let overflow = 0;
  const scheduler = createMemoryExtractionScheduler(
    async ({ snapshot }) => {
      if (snapshot.boundaryMessageId === "first") {
        started();
        await blocked;
      }
      return "success";
    },
    {
      onOverflow: () => {
        overflow++;
      },
    },
  );
  scheduler.schedule(descriptor("first"));
  await ready;
  for (let i = 0; i < 9; i++)
    scheduler.schedule(async () => {
      reads.push(i);
      return descriptor(`queued-${i}`);
    });
  assert.deepEqual(reads, []);
  assert.equal(overflow, 1);
  release();
  await scheduler.drain();
  assert.deepEqual(reads, [0, 1, 2, 3, 4, 5, 6, 8]);
  assert.equal(scheduler.getCursor(), "queued-8");
});

test("rejected legacy acquisition promises are observed immediately while another descriptor runs", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const scheduler = createMemoryExtractionScheduler(async () => {
    await blocked;
    return "success";
  });
  scheduler.schedule(descriptor("first"));
  scheduler.schedule(Promise.reject(new Error("fixture acquisition")));
  await setImmediate();
  release();
  await scheduler.drain();
  assert.equal(scheduler.getCursor(), "first");
});
