import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { projectContextForDefinition, buildRemoteWorkspaceIdentity } from "@lcode/shared";
import { createMockRuntime } from "./lint-runtime-fixture.js";
import { executeTurnCommand } from "./turn.js";
import { prepareTurnProjectContext } from "./turn-project-context.js";
import { resumeFromStore } from "./resume.js";

function scope() {
  const root = join(process.cwd(), "synthetic-project");
  return projectContextForDefinition(
    {
      id: "synthetic",
      name: "Synthetic",
      revision: 2,
      primaryFolderPath: root,
      sourceFolderPaths: [root, join(root, "api")],
    },
    { workspacePath: root },
  );
}
function fixture(routed = true) {
  return createMockRuntime(
    { toolAllowlist: ["Read"], modelStreaming: "off" },
    undefined,
    undefined,
    {
      fileSystemPort: { stat: async () => ({ kind: "directory" }) } as never,
      ...(routed ? { projectNativeCall: async () => null } : {}),
    },
  );
}
function hasSelector(f: ReturnType<typeof fixture>) {
  const read = f.runtime.getTools(f.model).find((tool) => tool.name === "Read");
  assert.ok(read);
  return "projectMemberId" in (read.inputSchema as { properties: object }).properties;
}

test("cached contracts follow current accepted scope and require the execution router", async () => {
  const f = fixture();
  const other = fixture();
  assert.equal(hasSelector(f), false);
  await prepareTurnProjectContext(
    f.runtime,
    { projectContext: scope() } as never,
    new AbortController().signal,
  );
  assert.equal(hasSelector(f), true);
  assert.equal(hasSelector(other), false, "another session cannot borrow the scope");
  await prepareTurnProjectContext(f.runtime, undefined, new AbortController().signal);
  assert.equal(hasSelector(f), false);
  const unsupported = fixture(false);
  await prepareTurnProjectContext(
    unsupported.runtime,
    { projectContext: scope() } as never,
    new AbortController().signal,
  );
  assert.equal(hasSelector(unsupported), false);
});

for (const source of ["background_task", "subagent_message"] as const) {
  test(`${source}: real model-only turn retains accepted scope; a new user turn clears it`, async () => {
    const f = fixture();
    const accepted = scope();
    const seen: boolean[] = [];
    f.model.generateText = async (request) => {
      const read = request.tools?.find((tool) => tool.name === "Read");
      seen.push(
        Boolean(
          read && "projectMemberId" in (read.inputSchema as { properties: object }).properties,
        ),
      );
      return { text: "done", finishReason: "stop", usage: {} };
    };
    await executeTurnCommand.call(f.runtime, "synthetic user input", undefined, {
      intent: { projectContext: accepted } as never,
    });
    await executeTurnCommand.call(f.runtime, "synthetic notification", undefined, {
      inputSource: source,
      inputVisibility: "model-only",
      skipUserPromptSubmitHooks: true,
    });
    assert.deepEqual(f.runtime.projectContextForTools, accepted);
    assert.deepEqual(seen, [true, true]);
    await executeTurnCommand.call(f.runtime, "new standalone input", undefined);
    assert.equal(f.runtime.projectContextForTools, undefined);
    assert.deepEqual(seen, [true, true, false]);
  });
}

test("child inherits the frozen cross-device scope while a cold resumed root waits for fresh admission", async () => {
  const accepted = scope();
  const remote = accepted.members[1]!;
  remote.workspaceIdentity = buildRemoteWorkspaceIdentity(remote.workspacePath, {
    kind: "ssh",
    host: "fixture.example.test",
    username: "fixture",
  });
  for (const member of accepted.members) member.routeToken = `synthetic-${member.memberId}`;
  const f = fixture();
  f.runtime.inheritedProjectContext = structuredClone(accepted);
  await prepareTurnProjectContext(f.runtime, undefined, new AbortController().signal);
  assert.deepEqual(f.runtime.projectContextForTools, accepted);
  assert.equal(hasSelector(f), true);
  const cold = fixture();
  cold.runtime.sessionStore = {
    getSession: async () => ({
      id: cold.runtime.sessionId,
      directory: accepted.origin.workspacePath,
      path: accepted.origin.workspacePath,
      workspaceID: "synthetic-resumed",
      taskType: "interactive",
      title: "",
      time: { created: 1, updated: 2 },
    }),
    messages: async () => [],
  } as never;
  await resumeFromStore.call(cold.runtime);
  assert.equal(hasSelector(cold), false);
  assert.equal(Boolean(cold.runtime.projectContextForTools), false);
  await prepareTurnProjectContext(
    cold.runtime,
    { projectContext: structuredClone(accepted) } as never,
    new AbortController().signal,
  );
  assert.deepEqual(cold.runtime.projectContextForTools, accepted);
  assert.equal(hasSelector(cold), true);
  assert.equal(
    cold.runtime.projectContextForTools?.members[1]?.workspaceIdentity,
    remote.workspaceIdentity,
  );
});

test("cancellation during the final directory probe cannot publish a late project scope or cwd", async () => {
  const f = fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const controller = new AbortController();
  const accepted = scope();
  let probes = 0;
  let cwdChanges = 0;
  f.runtime.setWorkingDirectory = () => {
    cwdChanges++;
  };
  f.runtime.fileSystemPort!.stat = async () => {
    if (++probes === accepted.members.length) {
      entered.resolve();
      await release.promise;
    }
    return { kind: "directory" } as never;
  };
  const preparing = prepareTurnProjectContext(
    f.runtime,
    { projectContext: accepted } as never,
    controller.signal,
  );
  await entered.promise;
  controller.abort();
  release.resolve();
  await assert.rejects(preparing, { name: "AbortError" });
  assert.equal(f.runtime.projectContextForTools, undefined);
  assert.equal(cwdChanges, 0);
  assert.equal(hasSelector(f), false);
  assert.equal(
    f.runtime.messageHistory
      .borrowReadOnlyRuntimeEntries()
      .filter((entry) => entry.metadata?.source === "project_scope").length,
    0,
  );
});
