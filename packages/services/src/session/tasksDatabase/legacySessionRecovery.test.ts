import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { buildRemoteWorkspaceIdentity, LCODE_AGENT_PROVIDER } from "@lcode/shared";
import { TaskIndexRepo } from "../taskIndexRepo.js";
import { planLegacySessionRecovery } from "./legacySessionRecovery.js";

test("只为现有本地任务规划旧库补迁，排除空白资料根、自定义库和远程/删除任务", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "lcode-recovery-plan-"));
  const legacyHome = join(root, "home");
  const dataRoot = join(root, "current", ".lcode");
  const sourceDatabasePath = join(legacyHome, ".lcode", "cli", "db", "db.sqlite");
  const tasksDatabasePath = join(dataRoot, "v2", "tasks-index.sqlite");
  const options = {
    legacyHome,
    dataRoot,
    tasksDatabasePath,
    targetDatabasePath: join(dataRoot, "cli", "db", "db.sqlite"),
  };
  await mkdir(dirname(sourceDatabasePath), { recursive: true });
  await writeFile(sourceDatabasePath, "old library fixture");
  const repo = new TaskIndexRepo(tasksDatabasePath);
  t.after(async () => {
    repo.close();
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  assert.equal(await planLegacySessionRecovery(options), undefined);
  const workspacePath = join(root, "workspace");
  for (const taskId of ["local", "remote", "deleted"])
    await repo.seedTaskMetaIfMissing({
      taskId,
      workspacePath,
      traceId: "fixture",
      title: taskId,
      mode: "edit",
      createdAt: 1,
      updatedAt: 1,
      provider: LCODE_AGENT_PROVIDER,
      ...(taskId === "remote"
        ? {
            workspaceIdentity: buildRemoteWorkspaceIdentity("/fixture", {
              kind: "wsl",
              distro: "fixture",
            }),
          }
        : {}),
    });
  const db = new DatabaseSync(tasksDatabasePath);
  try {
    db.exec("UPDATE tasks SET deleted=1 WHERE task_id='deleted'");
  } finally {
    db.close();
  }
  assert.deepEqual(await planLegacySessionRecovery(options), {
    sourceDatabasePath,
    sessions: [{ sessionId: "local", workspacePath }],
  });
  assert.equal(
    await planLegacySessionRecovery({
      ...options,
      targetDatabasePath: join(root, "explicit.sqlite"),
    }),
    undefined,
  );
  assert.equal(
    await planLegacySessionRecovery({
      ...options,
      dataRoot: join(legacyHome, ".lcode"),
      targetDatabasePath: sourceDatabasePath,
    }),
    undefined,
  );
});
