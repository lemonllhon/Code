import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test, { type TestContext } from "node:test";
import {
  buildRemoteWorkspaceIdentity,
  lcodeProtocolMethods,
  lcodeSessionRuntimePreferencesResultSchema,
  PROJECT_NATIVE_METHOD,
  resolveWorkspaceKey,
  type LCodeProtocolMessage,
  type LCodeProtocolRequest,
  type ProjectContextSnapshot,
  type ProjectNativeResult,
} from "../packages/shared/src/index.js";
import { V4_METHODS } from "../packages/shared/src/lcode-protocol-v4/index.js";
import { createWindowProjectNativeRouter } from "../packages/desktop/src/host/windowProjectNativeRouter.js";
import { materializeProjectContext } from "../packages/services/src/lcode-agent/projectContextScope.js";
import { createProjectToolRouting } from "../apps/lcode-cli/packages/core/src/tool/project-routing.js";
import { requestProjectContextForWorkspace } from "../apps/lcode-cli/packages/bootstrap/src/lcode-protocol/admission-project-context.js";
import { LCodeProtocolAgentServer } from "../apps/lcode-cli/packages/bootstrap/src/lcode-protocol/server.js";
import { LCodeProtocolNdjsonConnection } from "../apps/lcode-cli/packages/bootstrap/src/lcode-protocol/transport.js";

const SESSION_ID = "one-cross-device-session";
const RESOURCE_OWNER = `${SESSION_ID}-generation`;
type Handler = ConstructorParameters<typeof LCodeProtocolNdjsonConnection>[0]["handleMessage"];

function endpoint(
  t: TestContext,
  handleCommand: (request: LCodeProtocolRequest) => ReturnType<Handler>,
  onHostRequest: (request: LCodeProtocolRequest) => Promise<unknown>,
) {
  const server = new LCodeProtocolAgentServer({
    createLCodeApp: () => {
      throw new Error("Native endpoint must not create another session runtime");
    },
  });
  const input = new PassThrough();
  const output = new PassThrough();
  const abort = new AbortController();
  const pending = new Map<string, ReturnType<typeof Promise.withResolvers<unknown>>>();
  const calls: LCodeProtocolRequest[] = [];
  const hostWork: Promise<void>[] = [];
  let nextId = 0;
  let buffer = "";
  const send = (message: LCodeProtocolMessage) => input.write(JSON.stringify(message) + "\n");
  const connection = new LCodeProtocolNdjsonConnection({
    input,
    output,
    signal: abort.signal,
    handleMessage: (message) => {
      if ("method" in message && "id" in message) {
        calls.push(message);
        if (message.method === V4_METHODS.command) return handleCommand(message);
      }
      return server.handleMessage(message);
    },
    onTransportClosed: (error) => server.disconnectClient(error),
    takePostResponseBatch: (id) => server.takePostResponseBatch(id),
    clearPostResponseMessages: () => server.clearPostResponseMessages(),
  });
  output.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const message = JSON.parse(buffer.slice(0, newline)) as LCodeProtocolMessage;
      buffer = buffer.slice(newline + 1);
      if (!("id" in message)) continue;
      if ("method" in message) {
        const work = onHostRequest(message).then(
          (result) => {
            send({ id: message.id, result });
          },
          (error: unknown) => {
            send({
              id: message.id,
              error: {
                code: -32603,
                message: error instanceof Error ? error.message : String(error),
              },
            });
          },
        );
        hostWork.push(work);
      } else {
        const request = pending.get(String(message.id));
        pending.delete(String(message.id));
        if ("error" in message) request?.reject(new Error(message.error.message));
        else if ("result" in message) request?.resolve(message.result);
      }
    }
  });
  server.setNotificationSink((message) => connection.send(message));
  connection.start();
  t.after(async () => {
    abort.abort();
    for (const request of pending.values()) request.reject(new Error("Fixture closed"));
    await connection.waitForClose();
    await Promise.allSettled(hostWork);
    await server.shutdown();
    server.disposeProjections();
    input.destroy();
    output.destroy();
  });
  return {
    server,
    calls,
    request(method: LCodeProtocolRequest["method"], params: unknown): Promise<unknown> {
      const id = `host-${nextId++}`;
      const waiting = Promise.withResolvers<unknown>();
      pending.set(id, waiting);
      send({ id, method, params });
      return waiting.promise;
    },
  };
}

for (const clientMode of ["desktop-continuous", "web-remote-replayable"] as const) {
  for (const primary of ["local", "remote"] as const) {
    test(
      `${clientMode}: one ${primary}-primary admission uses real native IO on both endpoints before its ACK`,
      { timeout: 30000 },
      async (t) => {
        const root = await mkdtemp(join(tmpdir(), "lcode-mixed-admission-"));
        t.after(() => rm(root, { recursive: true, force: true }));
        const localPath = join(root, "local");
        const remotePath = join(root, "remote");
        await Promise.all([mkdir(localPath), mkdir(remotePath)]);
        const identity = buildRemoteWorkspaceIdentity(remotePath, {
          kind: "ssh",
          host: "fixture.example.test",
          username: "fixture",
        });
        const members: ProjectContextSnapshot["members"] = [
          {
            memberId: "local",
            label: "Local",
            role: "",
            description: "",
            sourcePath: localPath,
            workspacePath: localPath,
            source: { kind: "local" },
          },
          {
            memberId: "remote",
            label: "Remote",
            role: "",
            description: "",
            sourcePath: remotePath,
            workspacePath: remotePath,
            workspaceIdentity: identity,
            source: { kind: "remote", deviceId: "device", workspaceIdentity: identity },
          },
        ];
        const origin =
          primary === "remote"
            ? { workspacePath: remotePath, workspaceIdentity: identity }
            : { workspacePath: localPath };
        const workspace = { ...origin, workspaceKey: resolveWorkspaceKey(origin) };
        const snapshot: ProjectContextSnapshot = {
          version: 1,
          projectId: "mixed",
          name: "Mixed",
          description: "",
          revision: 1,
          origin,
          execution: origin,
          members,
        };
        let router!: ReturnType<typeof createWindowProjectNativeRouter>;
        let source!: ReturnType<typeof endpoint>;
        const handleCommand = async (request: LCodeProtocolRequest) => {
          assert.deepEqual(request.params, { sessionId: SESSION_ID, clientMode });
          const accepted = await requestProjectContextForWorkspace(
            source.server.officialMcpAuthRequestContext,
            workspace,
            SESSION_ID,
            "fixture-trace",
          );
          assert.ok(accepted);
          const routing = createProjectToolRouting({
            ownerId: RESOURCE_OWNER,
            snapshot: () => accepted,
            call: (operation) => router.call(operation, resolveWorkspaceKey(origin)),
          });
          const results: Array<{ memberId: string; content: string; cwd: string }> = [];
          try {
            for (const member of accepted.members) {
              const ports = routing.resolve("Write", { projectMemberId: member.memberId })!;
              const path = join(member.workspacePath, "same-session.txt");
              const content = `${SESSION_ID}:${member.memberId}`;
              await ports.fileSystemPort!.writeTextFile({ path, content, createParents: true });
              assert.equal((await ports.fileSystemPort!.readTextFile({ path })).content, content);
              const run = await ports.executionPort!.run({
                command: {
                  mode: "argv",
                  file: process.execPath,
                  args: ["-e", "process.stdout.write(process.cwd())"],
                },
                cwd: ports.getWorkingDirectory!(),
              });
              assert.equal(run.exitCode, 0);
              assert.equal(run.stdout.text, member.workspacePath);
              results.push({ memberId: member.memberId, content, cwd: run.stdout.text });
            }
            assert.equal(routing.resolve("Bash", {})!.getWorkingDirectory!(), origin.workspacePath);
          } finally {
            await Promise.all(
              accepted.members.map((member) =>
                router.call(
                  {
                    ownerId: RESOURCE_OWNER,
                    callId: crypto.randomUUID(),
                    routeToken: member.routeToken!,
                    operation: { port: "execution", method: "close", args: [] },
                  },
                  resolveWorkspaceKey(origin),
                ),
              ),
            );
          }
          return { id: request.id, result: { sessionId: SESSION_ID, results } };
        };
        const onHostRequest = async (request: LCodeProtocolRequest) => {
          assert.equal(request.method, lcodeProtocolMethods.sessionRequestRuntimePreferences);
          assert.equal((request.params as { scope: string }).scope, "project-admission");
          const prepared = await router.prepare(snapshot);
          return lcodeSessionRuntimePreferencesResultSchema.parse({
            projectContext: await materializeProjectContext(prepared, workspace, SESSION_ID),
            nativeSearchEnhancementsEnabled: true,
          });
        };
        const local = endpoint(t, handleCommand, onHostRequest);
        const remote = endpoint(t, handleCommand, onHostRequest);
        source = primary === "remote" ? remote : local;
        router = createWindowProjectNativeRouter({
          resolveTarget: async (member) => ({
            workspacePath: member.workspacePath,
            workspaceIdentity: member.workspaceIdentity,
            ...(member.workspaceIdentity ? { remoteSessionId: "attachment", generation: 1 } : {}),
          }),
          execute: async (target, request) => {
            if (target.remoteSessionId) assert.equal(target.generation, 1);
            return (target.remoteSessionId ? remote : local).request(PROJECT_NATIVE_METHOD, {
              workspace: {
                workspacePath: target.workspacePath,
                workspaceIdentity: target.workspaceIdentity,
                workspaceKey: resolveWorkspaceKey(target),
              },
              request,
            }) as Promise<ProjectNativeResult>;
          },
        });
        // 使用真实 admission 反向请求、Host 签名路由和两条 NDJSON 资源连接；模型与网络设备由夹具替代。
        const sending = source.request(V4_METHODS.command, { sessionId: SESSION_ID, clientMode });
        const following = source.request(lcodeProtocolMethods.runtimeCapabilities, {});
        const [result] = await Promise.all([sending, following]);
        assert.equal((result as { sessionId: string }).sessionId, SESSION_ID);
        for (const member of members)
          assert.equal(
            await readFile(join(member.workspacePath, "same-session.txt"), "utf8"),
            `${SESSION_ID}:${member.memberId}`,
          );
        assert.equal(
          local.calls.filter((call) => call.method === V4_METHODS.command).length +
            remote.calls.filter((call) => call.method === V4_METHODS.command).length,
          1,
        );
        for (const target of [local, remote]) {
          const native = target.calls.filter((call) => call.method === PROJECT_NATIVE_METHOD);
          assert.ok(
            native.some(
              (call) =>
                (call.params as { request: { ownerId: string } }).request.ownerId ===
                RESOURCE_OWNER,
            ),
          );
          assert.ok(
            native.some(
              (call) =>
                (call.params as { request: { operation: { method: string } } }).request.operation
                  .method === "close",
            ),
          );
        }
      },
    );
  }
}
