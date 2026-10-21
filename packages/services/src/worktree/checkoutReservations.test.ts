import assert from "node:assert/strict";
import test from "node:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { publishFixture } from "../git/gitPublishTestHelpers.js";
import { createCheckoutCoordinator } from "./node.js";

test("reservation 持久化、祖孙路径互斥，另一 worktree 独立，只有原操作可解除", async (t) => {
  const f = await publishFixture(t),
    dataDir = join(f.base, "coord");
  const owner = createCheckoutCoordinator({ dataDir, git: f.command });
  const child = join(f.root, "nested");
  await mkdir(child);
  const other = join(f.base, "linked");
  await f.git("worktree", "add", "-qb", "linked", other);
  const key = "a".repeat(64);
  await owner.setReservation!({
    workspacePath: child,
    operationKey: key,
    kind: "repository-acquisition",
  });
  const restarted = createCheckoutCoordinator({ dataDir, git: f.command });
  for (const workspacePath of [f.root, child])
    await assert.rejects(restarted.assertAdmission!({ workspacePath }), {
      code: "LCODE_CHECKOUT_RESERVED",
    });
  await assert.rejects(
    restarted.clearReservation!({ workspacePath: child, operationKey: "b".repeat(64) }),
    { code: "LCODE_CHECKOUT_RESERVED" },
  );
  const lease = await restarted.acquire({
    workspacePath: other,
    ownerId: "other",
    mode: "shared",
    waitMs: 0,
  });
  await restarted.release(lease);
  await restarted.clearReservation!({ workspacePath: child, operationKey: key });
  await restarted.assertAdmission!({ workspacePath: f.root });
});
