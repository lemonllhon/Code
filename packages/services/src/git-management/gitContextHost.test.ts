import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHostGitContextProvider } from "./gitContextHost.js";

test("Host context enumerates only authorized sources, isolates missing folders and bounds large projects", async () => {
  const root = await mkdtemp(join(tmpdir(), "git-context-host-"));
  const paths = [join(root, "a"), join(root, "offline"), join(root, "b")];
  await mkdir(paths[0]!);
  await mkdir(paths[2]!);
  const calls: { workspacePath: string; workspaceIdentity?: string }[] = [];
  let sources = paths;
  const read = createHostGitContextProvider(
    {
      readRepositoryContext: async (request) => {
        calls.push(request);
        return {
          workspacePath: request.workspacePath,
          revision: "fixture",
          status: "available",
          partial: false,
          remotes: [],
        };
      },
    },
    async (scope, session) => {
      assert.equal(scope.workspaceIdentity, "remote-fixture");
      assert.equal(session, "session");
      return sources;
    },
  );
  const scope = {
    workspacePath: root,
    workspaceIdentity: "remote-fixture",
    workspaceKey: "remote-fixture",
  };
  const context = await read(scope, "session");
  assert.equal(context.status, "available");
  if (context.status !== "available") assert.fail();
  assert.deepEqual(
    context.repositories.map((r) => r.status),
    ["available", "unavailable", "available"],
  );
  assert.deepEqual(
    calls.map((c) => c.workspacePath),
    [await realpath(paths[0]!), await realpath(paths[2]!)],
  );
  assert.ok(calls.every((c) => c.workspaceIdentity === "remote-fixture"));
  sources = Array.from({ length: 22 }, (_, i) => join(root, `offline-${i}`));
  const large = await read(scope, "session");
  assert.equal(large.status, "available");
  if (large.status !== "available") assert.fail();
  assert.equal(large.repositories.length, 20);
  assert.equal(large.partial, true);
  assert.equal(calls.length, 2);
});

test("Multi-source context limits read concurrency to four without racing repository order", async () => {
  const root = await mkdtemp(join(tmpdir(), "git-context-batch-"));
  const paths = Array.from({ length: 6 }, (_, i) => join(root, `repo-${i}`));
  await Promise.all(paths.map((path) => mkdir(path)));
  let release!: () => void, full!: () => void;
  const blocked = new Promise<void>((done) => {
    release = done;
  });
  const fullBatch = new Promise<void>((done) => {
    full = done;
  });
  let active = 0,
    maximum = 0,
    count = 0;
  const provider = createHostGitContextProvider(
    {
      readRepositoryContext: async ({ workspacePath }) => {
        active++;
        maximum = Math.max(maximum, active);
        count++;
        const index = count;
        if (count === 4) full();
        if (index <= 4) await blocked;
        active--;
        return { workspacePath, revision: "r", status: "available", partial: false, remotes: [] };
      },
    },
    async () => paths,
  );
  const pending = provider({ workspacePath: root, workspaceKey: root }, "session");
  await fullBatch;
  assert.equal(count, 4);
  assert.equal(maximum, 4);
  release();
  const context = await pending;
  if (context.status !== "available") assert.fail();
  assert.equal(count, 6);
  assert.equal(maximum, 4);
  assert.deepEqual(
    context.repositories.map((r) => r.workspacePath),
    await Promise.all(paths.map((path) => realpath(path))),
  );
});
