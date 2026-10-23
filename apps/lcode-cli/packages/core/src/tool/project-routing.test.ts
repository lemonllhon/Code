import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRemoteWorkspaceIdentity,
  encodeProjectNativeValue,
  type ProjectContextSnapshot,
  type ProjectNativeRequest,
} from "@lcode/shared";
import { createProjectToolRouting, selectProjectToolMember } from "./project-routing.js";
import { resolveWorkspacePath } from "./path-policy.js";
import { createToolExecutor } from "./executor/impl.js";
import { ToolRegistryImpl } from "./registry.js";
import { PermissionService } from "../permission/service.js";
import { createBashToolEntry } from "./handlers/bash.js";
import { readToolEntry } from "./handlers/read.js";

function fixture(): ProjectContextSnapshot {
  const members = ["local", "A", "B"].map((id) => ({
    memberId: id,
    label: id,
    role: "",
    description: "",
    sourcePath: "/app",
    workspacePath: "/app",
    routeToken: id,
    ...(id === "local"
      ? {}
      : {
          workspaceIdentity: buildRemoteWorkspaceIdentity("/app", {
            kind: "ssh",
            host: `${id}.example.test`,
            username: "dev",
          }),
        }),
  }));
  return {
    version: 1,
    projectId: "mixed",
    revision: 1,
    name: "Mixed",
    description: "",
    origin: { workspacePath: "/app" },
    execution: { ...members[2]! },
    members,
  };
}
test("each accepted snapshot resets primary cwd and an older scope cannot write the next scope's cwd", () => {
  let snapshot = fixture();
  const routing = createProjectToolRouting({
    ownerId: "generation",
    snapshot: () => snapshot,
    call: async () => null,
  });
  const oldScope = routing.resolve("Bash", {})!;
  oldScope.setWorkingDirectory!("/app/nested");
  assert.equal(
    oldScope.getWorkingDirectory!(),
    "/app",
    "an admitted tool freezes its cwd before permission",
  );
  assert.equal(routing.resolve("Bash", {})!.getWorkingDirectory!(), "/app/nested");
  snapshot = structuredClone(snapshot);
  const nextScope = routing.resolve("Bash", {})!;
  assert.equal(nextScope.getWorkingDirectory!(), "/app");
  oldScope.setWorkingDirectory!("/app/stale");
  assert.equal(routing.resolve("Bash", {})!.getWorkingDirectory!(), "/app");
});
test("default uses primary device; explicit member resolves same paths; ambiguous and foreign selectors fail closed", () => {
  const snapshot = fixture();
  assert.equal(selectProjectToolMember(snapshot, {}).memberId, "B");
  assert.equal(selectProjectToolMember(snapshot, { projectMemberId: null }).memberId, "B");
  assert.equal(selectProjectToolMember(snapshot, { file_path: "relative.txt" }).memberId, "B");
  assert.equal(
    selectProjectToolMember(snapshot, { projectMemberId: "A", cwd: "/app" }).memberId,
    "A",
  );
  assert.throws(() => selectProjectToolMember(snapshot, { cwd: "/app/src" }), /Ambiguous/);
  assert.throws(
    () => selectProjectToolMember(snapshot, { projectMemberId: "other" }),
    /accepted project/,
  );
  assert.equal(
    resolveWorkspacePath({
      inputPath: "src/file.ts",
      workingDirectory: "/app",
      workspaceRoot: "/app",
      operation: "read",
    }),
    "/app/src/file.ts",
  );
  assert.equal(
    resolveWorkspacePath({
      inputPath: "src/file.ts",
      workingDirectory: "C:\\app",
      workspaceRoot: "C:\\app",
      operation: "read",
    }),
    "C:\\app\\src\\file.ts",
  );
});

test("bound ports retain device, revision payload, binary bytes, failures and background owner after primary changes", async () => {
  const snapshot = fixture();
  const requests: ProjectNativeRequest[] = [];
  const routing = createProjectToolRouting({
    ownerId: "chat",
    snapshot: () => snapshot,
    call: async (request) => {
      requests.push(request);
      if (request.operation.method === "readBinaryFile")
        return encodeProjectNativeValue({
          bytes: new Uint8Array([0, 255]),
          at: new Date("2026-01-01T00:00:00Z"),
        });
      if (request.operation.method === "writeTextFile")
        return encodeProjectNativeValue({
          $nativeFailure: true,
          message: "revision mismatch",
          code: "revision_conflict",
        });
      if (request.operation.method === "runBashWithBackgroundLifecycle")
        return { kind: "backgrounded", task: { taskId: "task-A" } };
      return encodeProjectNativeValue({ exitCode: 17, stdout: { text: request.routeToken } });
    },
  });
  const target = routing.resolve("Bash", { projectMemberId: "A" })!;
  const execution = target.executionPort!;
  await execution.runBashWithBackgroundLifecycle!(
    {
      command: {
        mode: "shell",
        command: "test",
        shellOverride: { executable: "C:\\fake.exe", args: [] },
      },
      cwd: "/app",
    } as never,
    { mode: "explicit" },
  );
  snapshot.execution = { ...snapshot.members[0]! };
  const background = await routing.backgroundExecution.getBackgroundTask!("task-A");
  assert.equal((background as unknown as { stdout: { text: string } }).stdout.text, "A");
  await routing.backgroundExecution.cancelBackgroundTask!("task-A");
  assert.equal(requests.at(-1)!.routeToken, "A");
  assert.doesNotMatch(JSON.stringify(requests[0]), /fake.exe/);
  const bytes = await target.fileSystemPort!.readBinaryFile({ path: "/app/file" });
  assert.ok((bytes as unknown as { at: Date }).at instanceof Date);
  await assert.rejects(
    target.fileSystemPort!.writeTextFile({
      path: "/app/file",
      content: "changed",
      expectedRevision: "old",
    } as never),
    { code: "revision_conflict" },
  );
  assert.equal(requests.at(-1)!.routeToken, "A");
});

test("cancellation sends an explicit cancel to the exact native request owner", async () => {
  const snapshot = fixture();
  const requests: ProjectNativeRequest[] = [];
  let finish!: () => void;
  const routing = createProjectToolRouting({
    ownerId: "chat",
    snapshot: () => snapshot,
    call: async (request) => {
      requests.push(request);
      if (request.operation.method === "cancelCall") {
        finish();
        return null;
      }
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return null;
    },
  });
  const controller = new AbortController();
  const running = routing
    .resolve("Bash", {})!
    .executionPort!.run(
      { command: { mode: "argv", file: "fixture" } },
      { signal: controller.signal },
    );
  controller.abort();
  await running;
  assert.equal(requests[1]!.callId, requests[0]!.callId);
  assert.equal(requests[1]!.routeToken, "B");
  assert.equal(requests[1]!.operation.method, "cancelCall");
});

test("real Bash executor selects device before strict validation and permission, without invoking origin execution", async () => {
  const snapshot = fixture();
  const requests: ProjectNativeRequest[] = [];
  const registry = new ToolRegistryImpl();
  registry.register(createBashToolEntry({ embeddedSearchEnabled: false }));
  const routing = createProjectToolRouting({
    ownerId: "chat-native-generation",
    snapshot: () => snapshot,
    call: async (request) => {
      requests.push(request);
      return encodeProjectNativeValue({
        kind: "foreground",
        result: {
          status: "completed",
          exitCode: 0,
          stdout: { text: request.routeToken, bytes: 1, truncated: false },
          stderr: { text: "", bytes: 0, truncated: false },
          durationMs: 1,
          timedOut: false,
          cancelled: false,
          startedAt: new Date(),
          completedAt: new Date(),
        },
      });
    },
  });
  const executor = createToolExecutor({
    registry,
    sessionId: "chat" as never,
    getMode: () => "yolo",
    permissionService: new PermissionService(),
    emitEvent: async () => {},
    getWorkingDirectory: () => "C:\\origin",
    getWorkspaceRoot: () => "C:\\origin",
    resolveProjectToolScope: routing.resolve,
    executionPort: {
      run: async () => {
        throw new Error("origin must not execute");
      },
    },
  });
  const explicit = await executor.execute({
    id: "explicit",
    name: "Bash",
    input: { command: "pwd", description: "Inspect selected folder", projectMemberId: "A" },
  });
  assert.equal(explicit.success, true, JSON.stringify(explicit));
  assert.equal(requests[0]!.routeToken, "A");
  const defaultCall = await executor.execute({
    id: "default",
    name: "Bash",
    input: { command: "pwd", description: "Inspect primary folder", projectMemberId: null },
  });
  assert.equal(defaultCall.success, true, JSON.stringify(defaultCall));
  assert.equal(requests[1]!.routeToken, "B");
  const ambiguous = await executor.execute({
    id: "ambiguous",
    name: "Bash",
    input: { command: "pwd", cwd: "/app", description: "Ambiguous directory" },
  });
  assert.equal(ambiguous.success, false);
  assert.equal(requests.length, 2);
  for (const projectMemberId of ["local", "A", "local", "B"]) {
    const result = await executor.execute({
      id: `same-chat-${projectMemberId}-${requests.length}`,
      name: "Bash",
      input: { command: "pwd", projectMemberId },
    });
    assert.equal(result.success, true);
    assert.equal(requests.at(-1)!.routeToken, projectMemberId);
  }
});

test("one frozen scope can read and write between local and remote members in either direction", async () => {
  const snapshot = fixture();
  const contents = new Map([
    ["local", "local-v1"],
    ["A", "remote-v1"],
    ["B", "independent-device"],
  ]);
  const seen: string[] = [];
  const routing = createProjectToolRouting({
    ownerId: "same-chat",
    snapshot: () => snapshot,
    call: async (request) => {
      seen.push(`${request.routeToken}:${request.operation.method}`);
      const args = request.operation.args[0] as { path: string; content?: string };
      assert.equal(args.path, "/app/file.txt");
      if (request.operation.method === "readTextFile")
        return { content: contents.get(request.routeToken)! };
      if (request.operation.method === "writeTextFile") {
        contents.set(request.routeToken, args.content!);
        return null;
      }
      throw new Error("Unexpected operation");
    },
  });
  const copy = async (source: string, destination: string) => {
    const input = routing.resolve("Read", { projectMemberId: source })!.fileSystemPort!;
    const output = routing.resolve("Write", { projectMemberId: destination })!.fileSystemPort!;
    const text = await input.readTextFile({ path: "/app/file.txt" });
    await output.writeTextFile({ path: "/app/file.txt", content: text.content });
  };
  await copy("local", "A");
  assert.equal(contents.get("A"), "local-v1");
  contents.set("A", "remote-v2");
  await copy("A", "local");
  assert.equal(contents.get("local"), "remote-v2");
  assert.equal(contents.get("B"), "independent-device");
  await copy("A", "B");
  contents.set("B", "other-remote-v3");
  await copy("B", "A");
  assert.equal(contents.get("A"), "other-remote-v3");
  assert.equal(contents.get("local"), "remote-v2");
  assert.deepEqual(seen, [
    "local:readTextFile",
    "A:writeTextFile",
    "A:readTextFile",
    "local:writeTextFile",
    "A:readTextFile",
    "B:writeTextFile",
    "B:readTextFile",
    "A:writeTextFile",
  ]);
  assert.equal(
    routing.resolve("Bash", {})!.workspaceIdentity,
    snapshot.execution.workspaceIdentity,
  );
});

test("strict-provider null selector preserves standalone CLI native execution without a project router", async () => {
  const registry = new ToolRegistryImpl();
  registry.register(createBashToolEntry({ embeddedSearchEnabled: false }));
  let calls = 0;
  const result = {
    status: "completed" as const,
    exitCode: 0,
    stdout: { text: "local", bytes: 5, truncated: false },
    stderr: { text: "", bytes: 0, truncated: false },
    durationMs: 1,
    timedOut: false,
    cancelled: false,
    startedAt: new Date(),
    completedAt: new Date(),
  };
  const executor = createToolExecutor({
    registry,
    sessionId: "standalone" as never,
    getMode: () => "yolo",
    permissionService: new PermissionService(),
    emitEvent: async () => {},
    getWorkingDirectory: () => process.cwd(),
    getWorkspaceRoot: () => process.cwd(),
    executionPort: {
      run: async () => {
        calls++;
        return result;
      },
      runBashWithBackgroundLifecycle: async () => {
        calls++;
        return { kind: "foreground", result };
      },
    },
  });
  const outcome = await executor.execute({
    id: "no-project",
    name: "Bash",
    input: { command: "pwd", projectMemberId: null },
  });
  assert.equal(outcome.success, true, JSON.stringify(outcome));
  assert.equal(calls, 1);
});

test("image Read uses the selected device's bytes and rejects unsupported routing before IO", async () => {
  const snapshot = fixture();
  const requests: ProjectNativeRequest[] = [];
  const pixels = new Uint8Array([137, 80, 78, 71]);
  const routing = createProjectToolRouting({
    ownerId: "image-fixture",
    snapshot: () => snapshot,
    call: async (request) => {
      requests.push(request);
      assert.equal(request.operation.method, "readBinaryFile");
      return encodeProjectNativeValue({ content: pixels, sizeBytes: pixels.byteLength });
    },
  });
  const registry = new ToolRegistryImpl();
  registry.register(readToolEntry);
  const options = {
    registry,
    sessionId: "image-fixture" as never,
    permissionService: new PermissionService(),
    emitEvent: async () => {},
    getMode: () => "yolo" as const,
    getWorkingDirectory: () => "/app",
    getWorkspaceRoot: () => "/app",
    resolveProjectToolScope: routing.resolve,
    fileSystemPort: {
      readBinaryFile: async () => {
        throw new Error("origin IO must not run");
      },
    } as never,
    imageProcessorPort: {
      prepareForModel: async () => ({
        data: pixels,
        mediaType: "image/png",
        width: 1,
        height: 1,
        originalWidth: 1,
        originalHeight: 1,
        transformedSizeBytes: pixels.byteLength,
        resized: false,
        compressed: false,
        strategy: "none",
      }),
    } as never,
  };
  const executor = createToolExecutor(options);
  const result = await executor.execute({
    id: "image",
    name: "Read",
    input: { file_path: "/app/sample.png", projectMemberId: "A" },
  });
  assert.equal(result.success, true, JSON.stringify(result.error));
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.routeToken, "A");
  assert.equal(
    (result.output as { base64: string }).base64,
    Buffer.from(pixels).toString("base64"),
  );
  assert.match(JSON.stringify(result.modelContent), /image/);
  for (const resolveProjectToolScope of [undefined, () => undefined]) {
    const unavailable = createToolExecutor({ ...options, resolveProjectToolScope });
    const denied = await unavailable.execute({
      id: "unavailable",
      name: "Read",
      input: { file_path: "/app/sample.png", projectMemberId: "A" },
    });
    assert.equal(denied.success, false);
    assert.match(denied.error!.message, /routing is unavailable/);
  }
  assert.equal(
    requests.length,
    1,
    "unavailable selectors must not silently fall back to origin IO",
  );
});
