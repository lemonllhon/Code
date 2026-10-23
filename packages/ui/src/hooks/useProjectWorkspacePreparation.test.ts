import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRemoteWorkspaceIdentity,
  stripRemoteTargetSecrets,
  type AppSettings,
} from "@lcode/shared";
import { createProjectWorkspacePreparation } from "./useProjectWorkspacePreparation.js";

function fixture(remoteOrigin = false) {
  const target = {
    kind: "ssh" as const,
    host: "fixture.example.test",
    username: "fixture",
    passwordCredentialKey: "credential-reference",
  };
  const identity = buildRemoteWorkspaceIdentity("/app", target);
  const origin = remoteOrigin
    ? { workspacePath: "/app", workspaceIdentity: identity }
    : { workspacePath: "C:/app" };
  const remote = {
    id: "remote",
    path: "/app",
    label: "",
    role: "",
    description: "",
    enabled: true,
    source: { kind: "remote" as const, deviceId: "device", workspaceIdentity: identity },
  };
  const project = {
    id: "project",
    name: "Mixed",
    revision: 1,
    primaryFolderPath: origin.workspacePath,
    workspaceIdentity: origin.workspaceIdentity,
    primaryMemberId: remoteOrigin ? "remote" : "local",
    sourceFolderPaths: [origin.workspacePath],
    members: [
      {
        id: "local",
        path: "C:/app",
        label: "",
        role: "",
        description: "",
        enabled: true,
        source: { kind: "local" as const },
      },
      remote,
      {
        ...remote,
        id: "remote-sibling",
        path: "/sibling",
        source: {
          ...remote.source,
          workspaceIdentity: buildRemoteWorkspaceIdentity("/sibling", target),
        },
      },
    ],
  };
  const settings = {
    localProjects: [project],
    projectDefinitions: { version: 1, projects: [project] },
    remoteDevices: { version: 1, devices: [{ id: "device", name: "Device", revision: 1, target }] },
  } as unknown as AppSettings;
  const sessions: Array<{ sessionId: string; workspaceIdentity?: string; target: typeof target }> =
    [];
  const connected: unknown[] = [];
  const retained: string[] = [];
  const disposed: string[] = [];
  const bound: unknown[] = [];
  const credentials: string[] = [];
  const reconnected: string[] = [];
  const ports: Parameters<typeof createProjectWorkspacePreparation>[0] = {
    getSettings: async () => structuredClone(settings),
    loadCredential: async (key) => {
      credentials.push(key);
      return "fixture-password";
    },
    sessions: () => sessions,
    connect: async (options, _id, context) => {
      connected.push({ options, context });
      const sessionId = `session-${connected.length}`;
      sessions.push({
        sessionId,
        workspaceIdentity: context?.workspaceIdentity,
        target: stripRemoteTargetSecrets(options) as typeof target,
      });
      return sessionId;
    },
    dispose: async (id) => {
      disposed.push(id);
    },
    retain: (id) => {
      retained.push(id);
    },
    bind: (key, id) => {
      bound.push({ key, id });
    },
    reconnect: async (key) => {
      reconnected.push(key);
      sessions.push({ sessionId: "desktop-owner", workspaceIdentity: key, target });
    },
    isDesktop: () => true,
  };
  return {
    ports,
    prepare: createProjectWorkspacePreparation(ports),
    origin,
    identity,
    target,
    project,
    settings,
    sessions,
    connected,
    retained,
    disposed,
    bound,
    credentials,
    reconnected,
  };
}

for (const remoteOrigin of [false, true]) {
  test(`explicit ${remoteOrigin ? "remote" : "local"} project opening restores one device without old tabs/history`, async () => {
    const f = fixture(remoteOrigin);
    await f.prepare(f.origin);
    assert.equal(f.connected.length, 1, "same device members share one connection");
    assert.deepEqual(f.credentials, ["credential-reference"]);
    assert.deepEqual(f.retained, ["session-1"]);
    assert.deepEqual(f.disposed, []);
    assert.equal(f.bound.length, remoteOrigin ? 1 : 0);
    await f.prepare(f.origin);
    assert.equal(f.connected.length, 1, "reopening uses the live attachment");
    assert.equal(JSON.stringify(f.settings).includes("fixture-password"), false);
  });
}

test("repeated opening joins one in-flight preparation and a failure can be retried", async () => {
  const f = fixture(true);
  const ready = Promise.withResolvers<void>();
  const connect = f.ports.connect;
  f.ports.connect = async (...args) => {
    await ready.promise;
    return connect(...args);
  };
  const a = f.prepare(f.origin);
  assert.equal(f.prepare(f.origin), a);
  ready.resolve();
  await a;
  f.sessions.length = 0;
  f.ports.connect = async () => {
    throw new Error("fixture connection failed");
  };
  await assert.rejects(f.prepare(f.origin), /fixture connection failed/);
  f.ports.connect = connect;
  await f.prepare(f.origin);
  assert.equal(f.connected.length, 2);
});

test("changed device or project only disposes attachments created by this opening", async () => {
  for (const changed of ["project", "device"]) {
    const f = fixture(true);
    const connect = f.ports.connect;
    f.ports.connect = async (...args) => {
      const id = await connect(...args);
      if (changed === "project") f.project.revision++;
      else f.settings.remoteDevices!.devices[0]!.revision++;
      return id;
    };
    await assert.rejects(f.prepare(f.origin), /project.open.changed/);
    assert.deepEqual(f.disposed, ["session-1"]);
    assert.deepEqual(f.retained, []);
    assert.deepEqual(f.bound, []);
  }
});

test("same device on another folder may serve members but cannot replace the source identity", async () => {
  const f = fixture(true);
  f.sessions.push({
    sessionId: "another-project",
    workspaceIdentity: buildRemoteWorkspaceIdentity("/other", f.target),
    target: f.target,
  });
  await f.prepare(f.origin);
  assert.equal(f.connected.length, 1);
  assert.deepEqual(f.bound, [{ key: f.identity, id: "session-1" }]);
  assert.deepEqual(f.disposed, []);
  const local = fixture(false);
  local.sessions.push({
    sessionId: "another-project",
    workspaceIdentity: buildRemoteWorkspaceIdentity("/other", local.target),
    target: local.target,
  });
  await local.prepare(local.origin);
  assert.equal(local.connected.length, 0);
});

test("a local project remains local when a remote member has the same path", async () => {
  const f = fixture();
  f.project.primaryFolderPath = "/app";
  f.project.sourceFolderPaths = ["/app"];
  f.project.members[0]!.path = "/app";
  f.sessions.push({ sessionId: "remote", workspaceIdentity: f.identity, target: f.target });
  await f.prepare({ workspacePath: "/app" });
  assert.equal(f.connected.length, 0);
  assert.deepEqual(f.bound, [], "the local source cannot inherit the remote identity");
});

test("a missing or redirected saved device fails before any connection", async () => {
  for (const missing of [false, true]) {
    const f = fixture();
    if (missing) f.settings.remoteDevices!.devices.length = 0;
    else
      (f.settings.remoteDevices!.devices[0]!.target as { host: string }).host =
        "changed.example.test";
    await assert.rejects(f.prepare(f.origin), /project.open.deviceUnavailable/);
    assert.deepEqual(f.connected, []);
  }
});

test("disabled remote members do not connect and mobile delegates existing identities to the desktop owner", async () => {
  const local = fixture();
  local.project.members[1]!.enabled = false;
  local.project.members[2]!.enabled = false;
  await local.prepare(local.origin);
  assert.equal(local.connected.length, 0);
  const mobile = fixture(true);
  mobile.ports.isDesktop = () => false;
  await mobile.prepare(mobile.origin);
  assert.equal(mobile.connected.length, 0);
  assert.deepEqual(mobile.reconnected, [mobile.identity]);
});
