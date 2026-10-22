import assert from "node:assert/strict";
import test from "node:test";
import { buildProjectContextSnapshot, formatProjectContextSnapshot } from "./projectContext.js";
import { buildRemoteWorkspaceIdentity } from "./remote-workspace-identity.js";
test("primary execution member is frozen separately from the historical project anchor", () => {
  const project = {
    id: "p",
    name: "Project",
    primaryFolderPath: "/anchor",
    sourceFolderPaths: ["/anchor", "/api"],
    primaryMemberId: "api",
    members: [
      { id: "anchor", path: "/anchor", role: "", label: "", description: "", enabled: true },
      { id: "api", path: "/api", role: "", label: "", description: "", enabled: true },
    ],
  };
  const first = buildProjectContextSnapshot(
    { localProjects: [project] },
    { workspacePath: "/anchor" },
  )!;
  assert.equal(first.execution.workspacePath, "/api");
  assert.equal(first.origin.workspacePath, "/anchor");
  project.primaryMemberId = "anchor";
  assert.equal(first.execution.workspacePath, "/api");
  assert.equal(
    buildProjectContextSnapshot({ localProjects: [project] }, { workspacePath: "/anchor" })!
      .execution.workspacePath,
    "/anchor",
  );
});
test("project scope is explicit without MCP and does not confuse same-path remote projects", () => {
  const local = {
    id: "local",
    name: "Shop",
    primaryFolderPath: "/web",
    sourceFolderPaths: ["/web", "/api"],
  };
  const remote = { ...local, id: "remote", workspaceIdentity: "remote-scope" };
  const settings = {
    localProjects: [local],
    projectDefinitions: { version: 1 as const, projects: [local, remote] },
  };
  const snapshot = buildProjectContextSnapshot(settings, {
    workspacePath: "/web",
    workspaceIdentity: "remote-scope",
  })!;
  assert.equal(snapshot.projectId, "remote");
  assert.deepEqual(
    snapshot.members.map((member) => member.workspacePath),
    ["/web", "/api"],
  );
  const formatted = formatProjectContextSnapshot(snapshot);
  assert.match(formatted, /\/api/);
  const members = JSON.parse(
    formatted.slice(formatted.indexOf("{"), formatted.lastIndexOf("}") + 1),
  ).members;
  assert.equal(members.filter((member: { primary: boolean }) => member.primary).length, 1);
  assert.equal(
    buildProjectContextSnapshot(settings, {
      workspacePath: "/web",
      workspaceIdentity: "other-source",
    }),
    null,
  );
  remote.name = "Changed";
  assert.equal(snapshot.name, "Shop");
});

test("model context names the logical project and explicit local and remote targets in either direction", () => {
  const workspaceIdentity = buildRemoteWorkspaceIdentity("/srv/app", {
    kind: "ssh",
    host: "device.example.test",
    username: "dev",
  });
  const project = {
    id: "mixed",
    name: "Unified project",
    primaryFolderPath: "/srv/app",
    sourceFolderPaths: ["/srv/app"],
    workspaceIdentity,
    primaryMemberId: "remote",
    members: [
      {
        id: "remote",
        path: "/srv/app",
        role: "deployment",
        label: "Server",
        description: "Remote deployment",
        enabled: true,
        source: { kind: "remote" as const, deviceId: "device", workspaceIdentity },
      },
      {
        id: "local",
        path: "E:/work/app",
        role: "development",
        label: "Development",
        description: "Local development",
        enabled: true,
        source: { kind: "local" as const },
      },
    ],
  };
  const snapshot = buildProjectContextSnapshot(
    { localProjects: [], projectDefinitions: { version: 1, projects: [project] } },
    { workspacePath: "/srv/app", workspaceIdentity },
  )!;
  snapshot.members.forEach((member) => {
    member.routeToken = "private-capability";
  });
  const text = formatProjectContextSnapshot(snapshot);
  const data = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  assert.equal(data.name, "Unified project");
  assert.equal(data.members[0].environment, "remote");
  assert.equal(data.members[0].primary, true);
  assert.equal(data.members[1].environment, "local");
  assert.equal(data.members[1].primary, false);
  assert.match(text, /either direction/);
  assert.doesNotMatch(text, /private-capability/);
});
