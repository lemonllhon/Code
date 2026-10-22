import test from "node:test";
import assert from "node:assert/strict";
import { buildRemoteWorkspaceIdentity } from "./remote-workspace-identity.js";
import { projectDefinitionSchema } from "./projectDefinitions.js";
import { projectContextForDefinition, formatProjectContextSnapshot } from "./projectContext.js";
import { projectMemberKey, projectOriginFolderPaths } from "./projectMemberSources.js";

test("mixed project preserves same-path local and two remote members, primary and immutable origin", () => {
  const members = ["local", "A", "B"].map((id) => ({
    id,
    path: "/app",
    role: "",
    label: "",
    description: id,
    enabled: true,
    source:
      id === "local"
        ? { kind: "local" as const }
        : {
            kind: "remote" as const,
            deviceId: id,
            workspaceIdentity: buildRemoteWorkspaceIdentity("/app", {
              kind: "ssh",
              host: `${id.toLowerCase()}.example.test`,
              username: "dev",
            }),
          },
  }));
  const project = projectDefinitionSchema.parse({
    id: "mixed",
    name: "Mixed",
    primaryFolderPath: "/app",
    sourceFolderPaths: projectOriginFolderPaths(members, "/app"),
    members,
    primaryMemberId: "B",
  });
  assert.equal(new Set(members.map((member) => projectMemberKey(member))).size, 3);
  const frozen = projectContextForDefinition(project, { workspacePath: "/app" });
  assert.equal(
    frozen.execution.workspaceIdentity,
    members[2]!.source.kind === "remote" ? members[2]!.source.workspaceIdentity : "",
  );
  assert.equal(frozen.members.length, 3);
  project.primaryMemberId = "local";
  assert.equal(
    projectContextForDefinition(project, frozen.origin).execution.workspaceIdentity,
    undefined,
  );
  assert.ok(frozen.execution.workspaceIdentity);
  assert.equal(frozen.origin.workspaceIdentity, undefined);
  frozen.members[0]!.routeToken = "private-capability";
  frozen.execution.routeToken = "private-capability";
  assert.doesNotMatch(formatProjectContextSnapshot(frozen), /private-capability/);
  assert.match(formatProjectContextSnapshot(frozen), /projectMemberId/);
});

test("remote origin retains explicit local member and legacy origin paths independently", () => {
  const origin = buildRemoteWorkspaceIdentity("/app", { kind: "wsl", distro: "Fixture" });
  const project = projectDefinitionSchema.parse({
    id: "legacy",
    name: "Legacy",
    primaryFolderPath: "/app",
    sourceFolderPaths: ["/app"],
    workspaceIdentity: origin,
    members: [
      { id: "remote", path: "/app" },
      { id: "local", path: "/app", source: { kind: "local" } },
    ],
    primaryMemberId: "local",
  });
  const context = projectContextForDefinition(project, {
    workspacePath: "/app",
    workspaceIdentity: origin,
  });
  assert.equal(
    context.members.find((member) => member.memberId === "remote")!.workspaceIdentity,
    origin,
  );
  assert.equal(context.execution.workspaceIdentity, undefined);
  assert.equal(
    context.members.find((member) => member.memberId === "local")!.workspaceIdentity,
    undefined,
  );
});
