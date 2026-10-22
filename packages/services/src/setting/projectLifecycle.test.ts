import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appSettingsSchema, buildRemoteWorkspaceIdentity } from "@lcode/shared";
import { applyProjectMutation } from "./projectMutations.js";
import { createSettingService } from "./settingService.js";

const project = {
  id: "app",
  name: "Saved app",
  primaryFolderPath: "/fixture/app",
  sourceFolderPaths: ["/fixture/app"],
};

test("sidebar removal persists implicit and saved projects without deleting history, and show retains their IDs", async () => {
  const root = await mkdtemp(join(tmpdir(), "lcode-project-hide-"));
  const prior = process.env.LCODE_DESKTOP_HOME_DIR;
  process.env.LCODE_DESKTOP_HOME_DIR = root;
  const identity = buildRemoteWorkspaceIdentity(project.primaryFolderPath, {
    kind: "ssh",
    host: "fixture.invalid",
    username: "dev",
  });
  const remote = { ...project, id: "remote", workspaceIdentity: identity };
  try {
    const settingsDirectory = join(root, ".lcode", "v2");
    await mkdir(settingsDirectory, { recursive: true });
    await writeFile(
      join(settingsDirectory, "setting.json"),
      JSON.stringify({
        recentProjects: [project.primaryFolderPath],
        localProjects: [],
        projectDefinitions: { version: 1, projects: [remote] },
        lastWorkspaceSession: [{ kind: "local", workspacePath: project.primaryFolderPath }],
      }),
    );
    const owner = createSettingService();
    for (const candidate of [project, remote]) {
      const request = {
        type: "hide" as const,
        project: candidate,
        projectId: candidate.id,
        operationId: `hide-${candidate.id}`,
        expectedRevision: candidate === project ? null : 0,
      };
      assert.equal((await owner.mutateProject(request)).status, "applied");
      const reread = createSettingService();
      const settings = await reread.get();
      const hidden = settings.projectDefinitions!.projects.find((p) => p.id === candidate.id)!;
      assert.ok(hidden.sidebarHiddenAt);
      assert.equal(hidden.archivedAt, undefined);
      assert.deepEqual(settings.recentProjects, [project.primaryFolderPath]);
      assert.equal(settings.lastWorkspaceSession!.length, 1);
      assert.equal((await reread.mutateProject(request)).status, "applied");
      const stale = await reread.mutateProject({
        ...request,
        operationId: `stale-${candidate.id}`,
        expectedRevision: 0,
      });
      assert.equal(stale.status, "conflict");
      const shown = await reread.mutateProject({
        type: "show",
        projectId: hidden.id,
        operationId: `show-${hidden.id}`,
        expectedRevision: hidden.revision!,
      });
      assert.equal(shown.status, "applied");
      assert.equal(shown.project!.sidebarHiddenAt, undefined);
      assert.equal(shown.project!.id, hidden.id);
      assert.deepEqual(shown.project!.members, hidden.members);
      assert.equal(shown.project!.workspaceIdentity, hidden.workspaceIdentity);
    }
  } finally {
    if (prior === undefined) delete process.env.LCODE_DESKTOP_HOME_DIR;
    else process.env.LCODE_DESKTOP_HOME_DIR = prior;
    await rm(root, { recursive: true, force: true });
  }
});

test("stale editor saves cannot clear sidebar removal and showing does not restore archive", async () => {
  const settings = appSettingsSchema.parse({
    localProjects: [{ ...project, revision: 1, sidebarHiddenAt: 100, archivedAt: 200 }],
  });
  const saved = await applyProjectMutation(settings, {
    type: "save",
    project: { ...project, name: "Edited" },
    projectId: project.id,
    operationId: "edit-hidden",
    expectedRevision: 1,
  });
  assert.equal(saved.result.project!.sidebarHiddenAt, 100);
  const shown = await applyProjectMutation(saved.next!, {
    type: "show",
    projectId: project.id,
    operationId: "show-archived",
    expectedRevision: 2,
  });
  assert.equal(shown.result.project!.archivedAt, 200);
  assert.equal(shown.result.project!.sidebarHiddenAt, undefined);
});

test("implicit removal clears recent and restore indexes without touching a same-path remote", async () => {
  const target = { kind: "ssh" as const, host: "fixture.invalid", username: "dev" };
  const settings = appSettingsSchema.parse({
    recentProjects: [project.primaryFolderPath, "/fixture/other"],
    lastWorkspaceSession: [
      { kind: "local", workspacePath: project.primaryFolderPath },
      {
        kind: "remote",
        workspacePath: project.primaryFolderPath,
        target,
        lastOpenedAt: 1,
        lastConnectionStatus: "failed",
      },
    ],
  });
  const request = {
    type: "remove" as const,
    operationId: "delete-implicit",
    projectId: "implicit",
    expectedRevision: null,
    workspace: { workspacePath: project.primaryFolderPath },
  };
  const { next, result } = await applyProjectMutation(settings, request);
  assert.equal(result.status, "applied");
  assert.deepEqual(next!.recentProjects, ["/fixture/other"]);
  assert.equal(next!.lastWorkspaceSession!.length, 1);
  assert.equal(next!.lastWorkspaceSession![0]!.kind, "remote");
  assert.deepEqual(await applyProjectMutation(next!, request), { result });
});

test("archive registers implicit offline sources, survives schema reload, and restores the same ID", async () => {
  const target = { kind: "ssh" as const, host: "fixture.invalid", username: "dev" };
  const remote = {
    ...project,
    workspaceIdentity: buildRemoteWorkspaceIdentity(project.primaryFolderPath, target),
  };
  const settings = appSettingsSchema.parse({
    recentProjects: [project.primaryFolderPath],
    lastWorkspaceSession: [
      {
        kind: "remote",
        workspacePath: project.primaryFolderPath,
        target,
        lastOpenedAt: 1,
        lastConnectionStatus: "failed",
      },
    ],
  });
  const request = {
    type: "archive" as const,
    projectId: project.id,
    project: remote,
    operationId: "archive",
    expectedRevision: null,
  };
  const archived = await applyProjectMutation(settings, request);
  assert.equal(archived.result.status, "applied");
  assert.ok(archived.result.project!.archivedAt);
  assert.deepEqual(archived.next!.lastWorkspaceSession, settings.lastWorkspaceSession);
  assert.deepEqual(archived.next!.recentProjects, settings.recentProjects);
  const reloaded = appSettingsSchema.parse(JSON.parse(JSON.stringify(archived.next)));
  assert.deepEqual(await applyProjectMutation(reloaded, request), { result: archived.result });
  const restored = await applyProjectMutation(reloaded, {
    type: "restore",
    projectId: project.id,
    operationId: "restore",
    expectedRevision: 1,
  });
  assert.equal(restored.result.project!.id, project.id);
  assert.equal(restored.result.project!.archivedAt, undefined);
  assert.equal(restored.result.project!.workspaceIdentity, remote.workspaceIdentity);
  assert.equal(restored.result.project!.revision, 2);
  const deleted = await applyProjectMutation(restored.next!, {
    type: "remove",
    projectId: project.id,
    operationId: "delete",
    expectedRevision: 2,
  });
  assert.ok(
    deleted.next!.projectMutationReceipts!.every((receipt) => receipt.result.project === null),
  );
});

test("stale archive cannot overwrite edited members or archive another source", async () => {
  const settings = appSettingsSchema.parse({ localProjects: [{ ...project, revision: 2 }] });
  const response = await applyProjectMutation(settings, {
    type: "archive",
    operationId: "stale",
    projectId: project.id,
    expectedRevision: 1,
    project,
  });
  assert.equal(response.result.status, "conflict");
  assert.equal(response.next, undefined);
});

test("real settings owners persist archive/restore and preserve source files", async () => {
  const root = await mkdtemp(join(tmpdir(), "lcode-project-lifecycle-"));
  const prior = process.env.LCODE_DESKTOP_HOME_DIR;
  process.env.LCODE_DESKTOP_HOME_DIR = root;
  const source = join(root, "source");
  const saved = { ...project, primaryFolderPath: source, sourceFolderPaths: [source] };
  try {
    await mkdir(source);
    await writeFile(join(source, "keep.txt"), "source remains");
    const owner = createSettingService();
    await owner.update({ localProjects: [saved], recentProjects: [source] });
    const request = {
      type: "archive" as const,
      project: saved,
      projectId: saved.id,
      operationId: "archive-disk",
      expectedRevision: 0,
    };
    assert.equal((await owner.mutateProject(request)).status, "applied");
    const other = createSettingService();
    assert.ok((await other.get()).projectDefinitions!.projects[0]!.archivedAt);
    assert.equal((await other.mutateProject(request)).status, "applied");
    await other.mutateProject({
      type: "restore",
      projectId: saved.id,
      operationId: "restore-disk",
      expectedRevision: 1,
    });
    assert.equal(
      (await createSettingService().get()).projectDefinitions!.projects[0]!.archivedAt,
      undefined,
    );
    await other.mutateProject({
      type: "remove",
      projectId: saved.id,
      operationId: "delete-disk",
      expectedRevision: 2,
    });
    assert.equal((await createSettingService().get()).projectDefinitions!.projects.length, 0);
    assert.equal(await readFile(join(source, "keep.txt"), "utf8"), "source remains");
  } finally {
    if (prior === undefined) delete process.env.LCODE_DESKTOP_HOME_DIR;
    else process.env.LCODE_DESKTOP_HOME_DIR = prior;
    assert.ok(root.startsWith(join(tmpdir(), "lcode-project-lifecycle-")));
    await rm(root, { recursive: true, force: true });
  }
});
