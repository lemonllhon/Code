import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AutomationRepo } from "./automationRepo.js";
import { AutomationService } from "./automationService.js";

test("self-deletion preserves history and identity isolation without reviving on late settlement", async () => {
  const root = await mkdtemp(join(tmpdir(), "lcode-automation-delete-"));
  const repo = new AutomationRepo(join(root, "tasks.sqlite"));
  const service = new AutomationService(repo);
  const scope = { workspacePath: root, workspaceIdentity: "fixture-host-a" };
  try {
    const params = {
      ...scope,
      title: "fixture",
      cronExpr: "* * * * *",
      prompt: "finish",
      recurring: true,
      locationKind: "local" as const,
    };
    const own = await service.create(params);
    const other = await service.create(params);
    const run = {
      runId: `${own.automationId}:fixture-run`,
      automationId: own.automationId,
      workspaceKey: own.workspaceKey,
      scheduledAt: Date.now(),
      trigger: "schedule" as const,
    };
    await repo.ensureRunClaimed(run);
    assert.equal(
      await service.delete(own.automationId, { ...scope, workspaceIdentity: "fixture-host-b" }),
      false,
    );
    assert.ok(await service.get(own.automationId, scope));
    assert.equal(await service.delete(own.automationId, scope), true);
    assert.equal(await service.delete(own.automationId, scope), false);
    await repo.markDispatched(own.automationId, {
      dispatchedAt: Date.now(),
      nextRunAt: Date.now(),
    });
    await repo.ensureRunClaimed(run);
    await repo.markRunOutcome(run.runId, "succeeded");
    assert.equal(await service.get(own.automationId, scope), null);
    assert.ok(await service.get(other.automationId, scope));
    assert.equal((await repo.getRun(run.runId))?.outcome, "succeeded");
    assert.ok(
      (await repo.claimDue(Date.now() + 120_000)).every(
        (automation) => automation.automationId !== own.automationId,
      ),
    );
  } finally {
    repo.close();
    await rm(root, { recursive: true, force: true });
  }
});
