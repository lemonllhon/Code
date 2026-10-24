import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitReviewWorkspaceState } from "./gitReviewWorkspaceState.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

test(
  "slow review reads catch up with another Host without mixing identities or losing the final revision",
  { timeout: 15_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "review-pressure-"));
    const host = new GitReviewWorkspaceState(directory),
      writer = new GitReviewWorkspaceState(directory);
    const scope = { workspacePath: "/repo", workspaceIdentity: "host-a/repo", scopeId: "session" };
    const initial = deferred(),
      entered = deferred(),
      blocked = deferred(),
      final = deferred();
    const originalRead = host.read.bind(host);
    let reading = 0,
      maxReading = 0,
      blockNext = false;
    host.read = async (input) => {
      reading++;
      maxReading = Math.max(reading, maxReading);
      try {
        const snapshot = await originalRead(input);
        if (blockNext) {
          blockNext = false;
          entered.resolve();
          await blocked.promise;
        }
        return snapshot;
      } finally {
        reading--;
      }
    };
    const revisions: number[] = [];
    const lease = host.subscribe(scope)((snapshot) => {
      assert.equal(snapshot.scope.workspaceIdentity, scope.workspaceIdentity);
      revisions.push(snapshot.revision);
      if (snapshot.revision === 0) initial.resolve();
      if (snapshot.revision === 3) final.resolve();
    });
    t.after(async () => {
      blocked.resolve();
      lease.dispose();
      await rm(directory, { recursive: true, force: true });
    });
    await initial.promise;
    blockNext = true;
    await writer.update({
      scope,
      commandId: "first",
      expectedFieldRevisions: { browsePosition: 0 },
      patch: { browsePosition: 1 },
    });
    await entered.promise;
    await writer.update({
      scope,
      commandId: "second",
      expectedFieldRevisions: { browsePosition: 1 },
      patch: { browsePosition: 2 },
    });
    await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        writeFile(join(directory, `unrelated-${index}.tmp`), "fixture"),
      ),
    );
    await writer.update({
      scope: { ...scope, workspaceIdentity: "host-b/repo" },
      commandId: "isolated",
      expectedFieldRevisions: { browsePosition: 0 },
      patch: { browsePosition: 19 },
    });
    await writer.update({
      scope,
      commandId: "third",
      expectedFieldRevisions: { browsePosition: 2 },
      patch: { browsePosition: 3 },
    });
    blocked.resolve();
    await final.promise;
    assert.equal(maxReading, 1);
    assert.equal(revisions.at(-1), 3);
    assert.deepEqual(
      revisions,
      [...new Set(revisions)].sort((a, b) => a - b),
    );
    assert.equal((await writer.read(scope)).data.browsePosition, 3);
    assert.equal(
      (await writer.read({ ...scope, workspaceIdentity: "host-b/repo" })).data.browsePosition,
      19,
    );
  },
);

test(
  "review read failure recovers on a later file replacement and cancelled reads cannot publish",
  { timeout: 15_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "review-watch-recovery-"));
    const host = new GitReviewWorkspaceState(directory),
      writer = new GitReviewWorkspaceState(directory);
    const scope = { workspacePath: "/repo", scopeId: "session" };
    const failed = deferred(),
      recovered = deferred(),
      entered = deferred(),
      blocked = deferred();
    const originalRead = host.read.bind(host);
    let reads = 0,
      blockNext = false;
    host.read = async (input) => {
      if (++reads === 1) {
        failed.resolve();
        throw new Error("synthetic transient read failure");
      }
      const snapshot = await originalRead(input);
      if (blockNext) {
        entered.resolve();
        await blocked.promise;
      }
      return snapshot;
    };
    const revisions: number[] = [];
    const lease = host.subscribe(scope)((snapshot) => {
      revisions.push(snapshot.revision);
      if (snapshot.revision === 1) recovered.resolve();
    });
    t.after(async () => {
      blocked.resolve();
      lease.dispose();
      await rm(directory, { recursive: true, force: true });
    });
    await failed.promise;
    await writer.update({
      scope,
      commandId: "recover",
      expectedFieldRevisions: { browsePosition: 0 },
      patch: { browsePosition: 1 },
    });
    await recovered.promise;
    blockNext = true;
    await writer.update({
      scope,
      commandId: "late",
      expectedFieldRevisions: { browsePosition: 1 },
      patch: { browsePosition: 2 },
    });
    await entered.promise;
    lease.dispose();
    blocked.resolve();
    await new Promise<void>((done) => setImmediate(done));
    assert.deepEqual(revisions, [1]);
  },
);
