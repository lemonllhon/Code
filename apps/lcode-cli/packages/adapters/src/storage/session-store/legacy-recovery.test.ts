import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { buildRemoteWorkspaceIdentity } from "@lcode/shared";
import { createSqliteSessionStore } from "./sqlite-session-store.js";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "lcode-legacy-session-"));
  const sourceDatabasePath = join(root, "legacy", "cli", "db", "db.sqlite");
  const targetDatabasePath = join(root, "current", "cli", "db", "db.sqlite");
  const source = createSqliteSessionStore({ dbPath: sourceDatabasePath });
  const target = createSqliteSessionStore({ dbPath: targetDatabasePath });
  const writer = new DatabaseSync(sourceDatabasePath);
  writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
  const reader = new DatabaseSync(targetDatabasePath);
  const workspacePath = join(root, "workspace");
  const create = async (store: typeof source, id: string, parentID?: string) =>
    store.createSession({
      id: id as never,
      projectID: "fixture" as never,
      directory: workspacePath,
      title: id,
      slug: id,
      version: "1",
      ...(parentID ? { parentID: parentID as never } : {}),
    });
  const put = async (side: string, session: string, text: string) => {
    const path = join(root, side, "cli", "artifacts", session, "report.txt");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  };
  const plan = {
    sourceDatabasePath,
    sessions: [
      { sessionId: "legacy", workspacePath },
      { sessionId: "shared", workspacePath },
    ],
  };
  t.after(async () => {
    writer.close();
    reader.close();
    source.close();
    target.close();
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  return { root, source, target, writer, reader, create, put, plan, workspacePath };
}

test("旧库 WAL 会话、父子历史和产物补入当前库，同 ID 会话及其现有内容保持不变", async (t) => {
  const f = await fixture(t);
  await f.create(f.source, "legacy");
  await f.create(f.source, "child", "legacy");
  await f.create(f.source, "shared");
  await f.create(f.source, "unrelated");
  await f.create(f.target, "shared");
  await f.create(f.target, "new-task");
  f.writer.exec(
    "INSERT INTO message VALUES ('old-message','legacy',1,1,'{}',0); INSERT INTO part VALUES ('old-part','old-message','legacy',1,1,'{}',0); INSERT INTO message VALUES ('stale-message','shared',1,1,'{}',0)",
  );
  await f.put("legacy", "legacy", "old artifact");
  await f.put("legacy", "shared", "stale artifact");
  await f.put("current", "shared", "current artifact");
  await f.target.recoverLegacySessions(f.plan);
  assert.ok(await f.target.getSession("legacy" as never));
  assert.equal((await f.target.getSession("child" as never))?.parentID, "legacy");
  assert.ok(await f.target.getSession("new-task" as never));
  assert.equal(await f.target.getSession("unrelated" as never), null);
  assert.equal(f.reader.prepare("SELECT count(*) AS n FROM message").get()?.n, 1);
  assert.equal(f.reader.prepare("SELECT count(*) AS n FROM part").get()?.n, 1);
  assert.equal(
    await readFile(join(f.root, "current/cli/artifacts/legacy/report.txt"), "utf8"),
    "old artifact",
  );
  assert.equal(
    await readFile(join(f.root, "current/cli/artifacts/shared/report.txt"), "utf8"),
    "current artifact",
  );
  assert.ok(await f.source.getSession("legacy" as never));
  assert.equal(f.reader.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
  assert.deepEqual(f.reader.prepare("PRAGMA foreign_key_check").all(), []);
});

test("重复和并发恢复幂等，之后删除的会话不会复活", async (t) => {
  const f = await fixture(t);
  await f.create(f.source, "legacy");
  const other = createSqliteSessionStore({ dbPath: f.target.getDatabasePath() });
  try {
    await Promise.all([
      f.target.recoverLegacySessions(f.plan),
      other.recoverLegacySessions(f.plan),
    ]);
  } finally {
    other.close();
  }
  assert.equal(f.reader.prepare("SELECT count(*) AS n FROM session").get()?.n, 1);
  f.reader.exec("DELETE FROM session WHERE id='legacy'");
  await f.target.recoverLegacySessions(f.plan);
  assert.equal(await f.target.getSession("legacy" as never), null);
});

test("身份不匹配的根与跨域子会话不导入；现有目标不是旧库的兜底读路径", async (t) => {
  const f = await fixture(t);
  await f.create(f.source, "legacy");
  await f.source.createSession({
    id: "foreign" as never,
    projectID: "fixture" as never,
    directory: f.workspacePath,
    workspaceID: "other-identity" as never,
    parentID: "legacy" as never,
    title: "foreign",
    slug: "foreign",
    version: "1",
  });
  await f.target.recoverLegacySessions({
    ...f.plan,
    sessions: [{ sessionId: "legacy", workspacePath: join(f.root, "different") }],
  });
  assert.equal(await f.target.getSession("legacy" as never), null);
  await f.target.recoverLegacySessions(f.plan);
  assert.ok(await f.target.getSession("legacy" as never));
  assert.equal(await f.target.getSession("foreign" as never), null);
});

test("关联文件复制失败不提交会话，保留源数据并允许重试", async (t) => {
  const f = await fixture(t);
  await f.create(f.source, "legacy");
  await f.put("legacy", "legacy", "artifact");
  const blocked = join(f.root, "current", "cli", "artifacts");
  await writeFile(blocked, "not a directory");
  await assert.rejects(f.target.recoverLegacySessions(f.plan));
  assert.equal(await f.target.getSession("legacy" as never), null);
  assert.ok(await f.source.getSession("legacy" as never));
  await rm(blocked);
  await f.target.recoverLegacySessions(f.plan);
  assert.ok(await f.target.getSession("legacy" as never));
});

test("工作流父子记录完整迁移，DWF 自增 ID 不冲突，执行 lease 和项目权限不复制", async (t) => {
  const f = await fixture(t);
  await f.create(f.source, "legacy");
  await f.create(f.source, "child", "legacy");
  await f.create(f.target, "new-task");
  f.writer.exec(`
    INSERT INTO workflow_run(id,name,parent_session_id,cwd,script_hash,status,time_created,time_updated)
      VALUES ('workflow','fixture','legacy','/fixture','hash','completed',1,1);
    INSERT INTO workflow_activity(id,run_id,call_index,call_path,type,input_hash,status,child_session_id,time_created,time_updated)
      VALUES ('activity','workflow',0,'0','ask','hash','completed','child',1,1);
    INSERT INTO workflow_event(id,run_id,sequence,type,activity_id,time_created)
      VALUES ('event','workflow',0,'completed','activity',1);
    INSERT INTO session_task_link(id,root_workflow_run_id,activity_id,parent_session_id,child_session_id,role,path,status,time_created,time_updated)
      VALUES ('link','workflow','activity','legacy','child','subagent','0','completed',1,1);
    INSERT INTO local_setting VALUES ('session','legacy','workflow.execution','owner','{}',1,1,1);
    INSERT INTO local_setting VALUES ('session','legacy','fixture','keep','true',1,1,1);
    INSERT INTO permission VALUES ('fixture',1,1,'{}');
  `);
  for (const [db, id, parent] of [
    [f.writer, "old-dwf", "legacy"],
    [f.reader, "current-dwf", "new-task"],
  ] as const) {
    db.prepare(
      "INSERT INTO dwf_run(id,parent_session_id,caps_max_concurrency,status,time_created,time_updated) VALUES (?,?,1,'completed',1,1)",
    ).run(id, parent);
    db.prepare(
      "INSERT INTO dwf_actor(run_id,site_id,ordinal,time_created,time_updated) VALUES (?,'site',0,1,1)",
    ).run(id);
    db.prepare(
      "INSERT INTO dwf_node(run_id,site_id,ordinal,kind,input_hash,status,time_created,time_updated) VALUES (?,'site',0,'ask','hash','completed',1,1)",
    ).run(id);
    db.prepare(
      "INSERT INTO dwf_event(run_id,sequence,type,payload_json,time_created) VALUES (?,0,'done','{}',1)",
    ).run(id);
  }
  await f.target.recoverLegacySessions(f.plan);
  for (const name of ["workflow_run", "workflow_activity", "workflow_event", "session_task_link"])
    assert.equal(f.reader.prepare(`SELECT count(*) AS n FROM ${name}`).get()?.n, 1);
  for (const name of ["dwf_run", "dwf_actor", "dwf_node", "dwf_event"])
    assert.equal(f.reader.prepare(`SELECT count(*) AS n FROM ${name}`).get()?.n, 2);
  assert.equal(
    f.reader
      .prepare("SELECT count(*) AS n FROM local_setting WHERE namespace='workflow.execution'")
      .get()?.n,
    0,
  );
  assert.equal(
    f.reader.prepare("SELECT value FROM local_setting WHERE namespace='fixture'").get()?.value,
    "true",
  );
  assert.equal(f.reader.prepare("SELECT count(*) AS n FROM permission").get()?.n, 0);
  assert.deepEqual(f.reader.prepare("PRAGMA foreign_key_check").all(), []);
});

test("导入事务冲突时回滚会话和幂等结果，修复冲突后重试成功", async (t) => {
  const f = await fixture(t);
  await f.create(f.source, "legacy");
  await f.create(f.target, "new-task");
  f.writer.exec("INSERT INTO message VALUES ('collision','legacy',1,1,'{}',0)");
  f.reader.exec("INSERT INTO message VALUES ('collision','new-task',1,1,'{}',0)");
  await assert.rejects(f.target.recoverLegacySessions(f.plan));
  assert.equal(await f.target.getSession("legacy" as never), null);
  assert.equal(
    f.reader
      .prepare(
        "SELECT count(*) AS n FROM local_setting WHERE namespace='storage.legacy-session-recovery'",
      )
      .get()?.n,
    0,
  );
  f.reader.exec("DELETE FROM message WHERE id='collision'");
  await f.target.recoverLegacySessions(f.plan);
  assert.ok(await f.target.getSession("legacy" as never));
});

test("工作树按原始 workspace 绑定补迁，独立 child 仍检查父链，远程候选不导入", async (t) => {
  const f = await fixture(t);
  await f.create(f.source, "legacy");
  const execution = join(f.root, "worktree");
  f.writer.prepare("UPDATE session SET directory=? WHERE id='legacy'").run(execution);
  f.writer
    .prepare(
      "INSERT INTO session_entry VALUES ('binding','legacy','runtime/worktree_binding',1,1,?)",
    )
    .run(
      JSON.stringify({
        workspaceKey: execution,
        workspacePath: execution,
        originWorkspacePath: f.workspacePath,
      }),
    );
  await f.source.createSession({
    id: "parent-foreign" as never,
    projectID: "fixture" as never,
    directory: f.workspacePath,
    workspaceID: "other" as never,
    title: "parent",
    slug: "parent",
    version: "1",
  });
  await f.source.createSession({
    id: "indexed-child" as never,
    projectID: "fixture" as never,
    directory: f.workspacePath,
    parentID: "parent-foreign" as never,
    taskType: "subagent_child",
    title: "child",
    slug: "child",
    version: "1",
  });
  const remoteIdentity = buildRemoteWorkspaceIdentity("/fixture", {
    kind: "wsl",
    distro: "fixture",
  });
  await f.source.createSession({
    id: "remote" as never,
    projectID: "fixture" as never,
    directory: "/fixture",
    workspaceID: remoteIdentity as never,
    title: "remote",
    slug: "remote",
    version: "1",
  });
  await f.target.recoverLegacySessions({
    ...f.plan,
    sessions: [
      ...f.plan.sessions,
      { sessionId: "indexed-child", workspacePath: f.workspacePath },
      { sessionId: "remote", workspacePath: "/fixture", workspaceIdentity: remoteIdentity },
    ],
  });
  assert.ok(await f.target.getSession("legacy" as never));
  assert.equal(await f.target.getSession("indexed-child" as never), null);
  assert.equal(await f.target.getSession("remote" as never), null);
});
