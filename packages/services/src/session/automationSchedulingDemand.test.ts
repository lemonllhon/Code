import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AutomationRepo } from "./automationRepo.js";

test("demand includes paused manual claims and deleted definitions until settlement", async () => {
  const root = await mkdtemp(join(tmpdir(), "lcode-scheduler-demand-"));
  const repo = new AutomationRepo(join(root, "tasks.sqlite"));
  try {
    assert.equal(await repo.hasSchedulingDemand(), false);
    const task = await repo.create(
      {
        title: "fixture",
        prompt: "fixture",
        cronExpr: "* * * * *",
        workspacePath: root,
        recurring: true,
      },
      { nextRunAt: Date.now() + 60_000 },
    );
    assert.equal(await repo.hasSchedulingDemand(), true);
    await repo.setEnabled(task.automationId, false);
    assert.equal(await repo.hasSchedulingDemand(), false);
    const manual = await repo.runNow(task.automationId, { now: Date.now() });
    assert.ok(manual);
    assert.equal(await repo.hasSchedulingDemand(), true);
    await repo.markManualRunDispatched({ runId: manual.run.runId, dispatchedAt: Date.now() });
    await repo.delete(task.automationId);
    assert.equal(await repo.hasSchedulingDemand(), true);
    await repo.markRunOutcome(manual.run.runId, "succeeded");
    assert.equal(await repo.hasSchedulingDemand(), false);
    await repo.ensureRunClaimed({
      runId: "orphan",
      automationId: "deleted",
      workspaceKey: root,
      scheduledAt: 1,
      trigger: "schedule",
    });
    assert.equal(await repo.hasSchedulingDemand(), true);
    await repo.markRunDispatch({ runId: "orphan", dispatchStatus: "failed_to_dispatch" });
    assert.equal(await repo.hasSchedulingDemand(), false);
  } finally {
    repo.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("successful writes invalidate same-database observers across Repo instances; failed writes and reads do not", async () => {
  const root = await mkdtemp(join(tmpdir(), "lcode-scheduler-events-"));
  const observer = new AutomationRepo(join(root, "tasks.sqlite"));
  const writer = new AutomationRepo(join(root, "tasks.sqlite"));
  const isolated = new AutomationRepo(join(root, "other.sqlite"));
  const events: string[] = [];
  const off = observer.onSchedulingChange(() => events.push("changed"));
  const offOther = isolated.onSchedulingChange(() => events.push("wrong-database"));
  const offBroken = observer.onSchedulingChange(() => {
    throw new Error("observer failure");
  });
  try {
    const task = await writer.create(
      {
        title: "fixture",
        prompt: "fixture",
        cronExpr: "* * * * *",
        workspacePath: root,
        recurring: true,
      },
      { nextRunAt: 10 },
    );
    assert.deepEqual(events, ["changed"]);
    await writer.list();
    await observer.hasSchedulingDemand();
    assert.equal(events.length, 1);
    await assert.rejects(
      writer.create(
        {
          title: "invalid",
          prompt: "fixture",
          cronExpr: "* * * * *",
          workspacePath: root,
          recurring: true,
          mode: "invalid" as never,
        },
        { nextRunAt: 10 },
      ),
    );
    assert.equal(events.length, 1);
    for (const mutate of [
      () => writer.update(task.automationId, { title: "updated" }),
      () => writer.setEnabled(task.automationId, false),
      () => writer.restart(task.automationId, { nextRunAt: 10 }),
      () => writer.runNow(task.automationId, { now: 10 }),
      () => writer.releaseClaim(task.automationId),
      () => writer.delete(task.automationId),
    ]) {
      const before = events.length;
      await mutate();
      assert.ok(events.length > before);
    }
    assert.ok(events.every((event) => event === "changed"));
    off();
    const count = events.length;
    await writer.deleteRun("missing");
    assert.equal(events.length, count);
  } finally {
    off();
    offOther();
    offBroken();
    observer.close();
    writer.close();
    isolated.close();
    await rm(root, { recursive: true, force: true });
  }
});
