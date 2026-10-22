import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createSettingService } from "./settingService.js";
import { applyProjectMutation } from "./projectMutations.js";
import {
  appSettingsSchema,
  projectDefinitionKey,
  buildRemoteWorkspaceIdentity,
  projectMemberKey,
} from "@lcode/shared";

test("remote removal commits definition and origin history together without touching same-path local or other devices", async () => {
  const targets = ["a", "b"].map((host) => ({
    kind: "ssh" as const,
    host: `${host}.example.test`,
    username: "dev",
  }));
  const identities = targets.map((target) => buildRemoteWorkspaceIdentity("/same", target));
  const local = {
    id: "local",
    name: "Local",
    primaryFolderPath: "/same",
    sourceFolderPaths: ["/same"],
  };
  const remote = {
    ...local,
    id: "a",
    name: "Remote",
    workspaceIdentity: identities[0],
    revision: 1,
  };
  const settings = appSettingsSchema.parse({
    localProjects: [local],
    projectDefinitions: {
      version: 1,
      projects: [local, remote, { ...remote, id: "b", workspaceIdentity: identities[1] }],
    },
    lastWorkspaceSession: [
      { kind: "local", workspacePath: "/same", localProjectId: "local" },
      ...targets.map((target) => ({
        kind: "remote",
        workspacePath: "/same",
        target,
        lastOpenedAt: 1,
        lastConnectionStatus: "failed",
      })),
    ],
    lastActiveTabIndex: 2,
  });
  const request = {
    type: "remove" as const,
    operationId: "remove-remote",
    projectId: "a",
    expectedRevision: 1,
  };
  const { next, result } = await applyProjectMutation(settings, request);
  assert.equal(result.status, "applied");
  assert.deepEqual(
    next!.projectDefinitions!.projects.map((project) => project.id),
    ["local", "b"],
  );
  assert.deepEqual(
    next!.lastWorkspaceSession!.map((entry) =>
      entry.kind === "local" ? "local" : entry.target.kind === "ssh" ? entry.target.host : "other",
    ),
    ["local", "b.example.test"],
  );
  assert.equal(next!.lastActiveTabIndex, 1);
  assert.equal(settings.lastWorkspaceSession.length, 3);
  assert.deepEqual(await applyProjectMutation(next!, request), { result });
});

test("mixed device save keeps composite IDs and revisions, stats only local additions, and rejects forged device identity", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "lcode-mixed-save-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const devices = ["A", "B"].map((id) => ({
    id,
    name: id,
    revision: 1,
    target: { kind: "ssh" as const, host: `${id.toLowerCase()}.example.test`, username: "dev" },
  }));
  const members = [
    {
      id: "local",
      path: root,
      role: "",
      label: "",
      description: "local",
      enabled: true,
      source: { kind: "local" as const },
    },
    ...devices.map((device) => ({
      id: device.id,
      path: "/same-missing-remote-path",
      role: "",
      label: "",
      description: device.id,
      enabled: true,
      source: {
        kind: "remote" as const,
        deviceId: device.id,
        workspaceIdentity: buildRemoteWorkspaceIdentity("/same-missing-remote-path", device.target),
      },
    })),
  ];
  const settings = appSettingsSchema.parse({ remoteDevices: { version: 1, devices } });
  const request = {
    type: "save" as const,
    operationId: "create-mixed",
    projectId: "mixed",
    expectedRevision: null,
    project: {
      id: "mixed",
      name: "Mixed",
      primaryFolderPath: root,
      sourceFolderPaths: [root],
      primaryMemberId: "B",
      members,
    },
  };
  const first = await applyProjectMutation(settings, request);
  assert.equal(first.result.status, "applied");
  assert.equal(
    new Set(first.result.project!.members!.map((member) => projectMemberKey(member))).size,
    3,
  );
  assert.deepEqual((await applyProjectMutation(first.next!, request)).result, first.result);
  const changed = await applyProjectMutation(first.next!, {
    ...request,
    operationId: "edit-mixed",
    expectedRevision: 1,
    project: {
      ...first.result.project!,
      primaryMemberId: "A-draft",
      members: members.map((member) => ({
        ...member,
        id: `${member.id}-draft`,
        description: "edited",
      })),
      memberOrder: undefined,
    },
  });
  // Caller IDs are replaced by the existing composite member identity, never by path alone.
  assert.equal(changed.result.status, "applied");
  assert.deepEqual(
    changed.result.project!.members!.map((member) => member.id),
    ["local", "A", "B"],
  );
  const forged = structuredClone(request);
  forged.project.members[1]!.source = { ...members[1]!.source, deviceId: "missing" } as never;
  assert.equal((await applyProjectMutation(settings, forged)).result.status, "validation_failed");
});

test("changing primary member updates first row while preserving the historical project identity", async () => {
  const members = ["front", "back", "docs"].map((id) => ({
    id,
    path: `/fixture/${id}`,
    role: "",
    label: "",
    description: id,
    enabled: true,
  }));
  const create = {
    type: "save" as const,
    operationId: "primary-create",
    projectId: "primary",
    expectedRevision: null,
    project: {
      id: "primary",
      name: "Primary",
      workspaceIdentity: "fixture-remote-identity",
      primaryFolderPath: members[0]!.path,
      sourceFolderPaths: members.map((member) => member.path),
      members,
      primaryMemberId: "front",
    },
  };
  const initial = await applyProjectMutation(appSettingsSchema.parse({}), create);
  assert.equal(initial.result.status, "applied");
  const saved = initial.result.project!;
  const changed = await applyProjectMutation(initial.next!, {
    ...create,
    operationId: "primary-change",
    expectedRevision: 1,
    project: { ...saved, primaryMemberId: "back", memberOrder: ["docs", "front", "back"] },
  });
  assert.equal(changed.result.status, "applied");
  assert.equal(changed.result.project!.primaryMemberId, "back");
  assert.deepEqual(changed.result.project!.memberOrder, ["back", "docs", "front"]);
  assert.equal(projectDefinitionKey(changed.result.project!), projectDefinitionKey(saved));
  assert.equal(changed.result.project!.primaryFolderPath, saved.primaryFolderPath);
  assert.deepEqual(changed.result.project!.members, members);
});

test("project commands persist member identity, CAS, replay and unrelated settings under two owners", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lcode-project-editor-"));
  const previous = process.env.LCODE_DESKTOP_HOME_DIR;
  process.env.LCODE_DESKTOP_HOME_DIR = directory;
  try {
    const front = join(directory, "frontend");
    const back = join(directory, "backend");
    await Promise.all([mkdir(front), mkdir(back)]);
    const first = createSettingService();
    const second = createSettingService();
    const create = {
      type: "save" as const,
      operationId: "create",
      projectId: "shop",
      expectedRevision: null,
      project: {
        id: "shop",
        name: "商城",
        primaryFolderPath: front,
        sourceFolderPaths: [front, back],
      },
    };
    const saved = await first.mutateProject(create);
    assert.equal(saved.status, "applied");
    assert.equal(saved.project?.revision, 1);
    assert.equal(saved.project?.members?.length, 2);
    assert.deepEqual(await createSettingService().mutateProject(create), saved);
    await assert.rejects(
      first.mutateProject({ ...create, project: { ...create.project, name: "reuse" } }),
      /reused/,
    );
    const updates = await Promise.all(
      [first, second].map((owner, i) =>
        owner.mutateProject({
          ...create,
          operationId: `edit-${i}`,
          expectedRevision: 1,
          project: { ...saved.project!, name: `Name ${i}` },
        }),
      ),
    );
    assert.deepEqual(updates.map((result) => result.status).sort(), ["applied", "conflict"]);
    const latest = (await first.get()).projectDefinitions!.projects[0]!;
    assert.deepEqual(latest.members, saved.project?.members);
    const badPrimary = await second.mutateProject({
      ...create,
      operationId: "primary",
      expectedRevision: 2,
      project: { ...latest, primaryFolderPath: back, sourceFolderPaths: [back, front] },
    });
    assert.equal(badPrimary.status, "validation_failed");
    const missing = await second.mutateProject({
      ...create,
      operationId: "missing",
      expectedRevision: 2,
      project: {
        ...latest,
        sourceFolderPaths: [front, back, join(directory, "missing")],
        members: undefined,
        memberOrder: undefined,
      },
    });
    assert.equal(missing.status, "validation_failed");
    await first.update({ recentProjects: [front] });
    await assert.rejects(first.update({ localProjects: [] }), /project command/i);
    await second.mutateProject({
      type: "remove",
      projectId: "shop",
      expectedRevision: 2,
      operationId: "remove",
    });
    const settings = await first.get();
    assert.equal(settings.localProjects.length, 0);
    assert.equal(settings.projectDefinitions?.projects.length, 0);
    assert.equal(settings.recentProjects.includes(front), false);
  } finally {
    if (previous === undefined) delete process.env.LCODE_DESKTOP_HOME_DIR;
    else process.env.LCODE_DESKTOP_HOME_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("remote definitions with identical paths retain separate identities and local projection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lcode-remote-project-editor-"));
  const previous = process.env.LCODE_DESKTOP_HOME_DIR;
  process.env.LCODE_DESKTOP_HOME_DIR = directory;
  try {
    const owner = createSettingService();
    for (const id of ["remote-a", "remote-b"])
      assert.equal(
        (
          await owner.mutateProject({
            type: "save",
            operationId: id,
            expectedRevision: null,
            projectId: id,
            project: {
              id,
              name: id,
              primaryFolderPath: "/data",
              sourceFolderPaths: ["/data", "/api"],
              workspaceIdentity: id,
            },
          })
        ).status,
        "applied",
      );
    const settings = await createSettingService().get();
    assert.equal(settings.localProjects.length, 0);
    assert.equal(settings.projectDefinitions?.projects.length, 2);
  } finally {
    if (previous === undefined) delete process.env.LCODE_DESKTOP_HOME_DIR;
    else process.env.LCODE_DESKTOP_HOME_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
