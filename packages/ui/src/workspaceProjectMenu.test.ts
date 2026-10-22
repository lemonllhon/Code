import assert from "node:assert/strict";
import test from "node:test";
import { buildRemoteWorkspaceIdentity, type LocalProject } from "@lcode/shared";
import { buildWorkspaceProjectMenuTabs } from "./workspaceProjectMenu.js";

const projects: LocalProject[] = [
  {
    id: "project-1",
    name: "App suite",
    primaryFolderPath: "C:\\work\\app",
    sourceFolderPaths: ["C:\\work\\app", "C:\\work\\docs"],
  },
];

test("project menu combines persisted projects with legacy and remote workspace tabs", () => {
  const result = buildWorkspaceProjectMenuTabs({
    localProjects: projects,
    workspaceTabs: [
      { workspacePath: "C:\\work\\app", label: "app", localProjectId: "project-1" },
      { workspacePath: "C:\\legacy", label: "legacy" },
      {
        workspacePath: "/srv/app",
        workspaceIdentity: "remote:ssh:host:/srv/app",
        label: "remote",
      },
    ],
  });

  assert.deepEqual(
    result.map((tab) => ({
      path: tab.workspacePath,
      label: tab.label,
      projectId: tab.localProjectId,
    })),
    [
      { path: "C:\\work\\app", label: "App suite", projectId: "project-1" },
      { path: "C:\\legacy", label: "legacy", projectId: undefined },
      { path: "/srv/app", label: "remote", projectId: undefined },
    ],
  );
});

test("a project referenced by a secondary folder remains selectable without duplicating the folder", () => {
  const result = buildWorkspaceProjectMenuTabs({
    localProjects: projects,
    workspaceTabs: [{ workspacePath: "C:\\work\\docs", label: "docs" }],
  });

  assert.equal(result.length, 1);
  assert.equal(result[0]?.label, "App suite");
  assert.equal(result[0]?.workspacePath, "C:\\work\\app");
});

test("persisted projects remain selectable before startup restores tabs or after tabs close", () => {
  const result = buildWorkspaceProjectMenuTabs({
    localProjects: projects,
    workspaceTabs: [],
  });

  assert.deepEqual(result, [
    {
      workspacePath: "C:\\work\\app",
      label: "App suite",
      workspacePurpose: "project",
      localProjectId: "project-1",
      projectSourceKind: "local",
    },
  ]);
  assert.equal(projects.length, 1);
});

test("a same-path remote tab does not hide or become the saved local project", () => {
  const remoteTab = {
    workspacePath: "C:\\work\\app",
    workspaceIdentity: "fixture-remote-project",
    remoteSessionId: "fixture-attachment",
    label: "remote",
  };
  const result = buildWorkspaceProjectMenuTabs({
    localProjects: projects,
    workspaceTabs: [remoteTab],
  });
  assert.equal(result.length, 2);
  assert.equal(result[0]?.localProjectId, "project-1");
  assert.equal(result[0]?.workspaceIdentity, undefined);
  assert.deepEqual(result[1], remoteTab);
});

test("removing a project definition makes its still-open source folder selectable again", () => {
  const result = buildWorkspaceProjectMenuTabs({
    localProjects: [],
    workspaceTabs: [{ workspacePath: "C:\\work\\app", label: "app" }],
  });

  assert.deepEqual(result, [{ workspacePath: "C:\\work\\app", label: "app" }]);
});

test("a mixed project uses its logical name and one identity-aware entry after rename", () => {
  const workspaceIdentity = buildRemoteWorkspaceIdentity("/srv/remote", {
    kind: "ssh",
    host: "device.example.test",
    username: "dev",
  });
  const mixed = {
    id: "mixed",
    name: "Unified project",
    primaryFolderPath: "/srv/remote",
    sourceFolderPaths: ["/srv/remote"],
    workspaceIdentity,
    members: [
      {
        id: "remote",
        path: "/srv/remote",
        role: "",
        label: "Remote app",
        description: "",
        enabled: true,
        source: { kind: "remote" as const, deviceId: "device", workspaceIdentity },
      },
      {
        id: "local",
        path: "E:/work/local",
        role: "",
        label: "Local app",
        description: "",
        enabled: true,
        source: { kind: "local" as const },
      },
    ],
  };
  const workspaceTabs = [
    {
      workspacePath: mixed.primaryFolderPath,
      workspaceIdentity,
      remoteSessionId: "attachment",
      label: "remote",
    },
  ];
  const tabs = buildWorkspaceProjectMenuTabs({ localProjects: [mixed], workspaceTabs });
  assert.equal(tabs.length, 1);
  assert.equal(tabs[0]?.label, "Unified project");
  assert.equal(tabs[0]?.workspaceIdentity, workspaceIdentity);
  assert.equal(tabs[0]?.remoteSessionId, "attachment");
  assert.equal(tabs[0]?.projectSourceKind, "mixed");
  mixed.name = "Renamed project";
  assert.equal(
    buildWorkspaceProjectMenuTabs({ localProjects: [mixed], workspaceTabs })[0]?.label,
    "Renamed project",
  );
});
