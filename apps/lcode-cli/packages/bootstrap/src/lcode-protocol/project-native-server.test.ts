import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  encodeProjectNativeValue,
  decodeProjectNativeValue,
  type ProjectNativeOperation,
} from "@lcode/shared";
import { ProjectNativeServer } from "./project-native-server.js";
import { NodeExecutionAdapter } from "@lcode/adapters/exec";

test(
  "native endpoint performs actual filesystem and process IO with real exit codes, binary, cancellation and lease cleanup",
  { timeout: 30000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "lcode-native-project-"));
    const server = new ProjectNativeServer();
    t.after(async () => {
      await server.close();
      await rm(root, { recursive: true, force: true });
    });
    const call = async (
      port: ProjectNativeOperation["port"],
      method: ProjectNativeOperation["method"],
      args: unknown[],
      callId = crypto.randomUUID(),
    ) =>
      decodeProjectNativeValue(
        await server.call({
          workspace: { workspacePath: root, workspaceKey: root },
          request: {
            ownerId: "source-chat",
            callId,
            routeToken: "verified-by-window",
            operation: { port, method, args: args.map(encodeProjectNativeValue) },
          },
        }),
      );
    const file = join(root, "test.txt");
    await call("filesystem", "writeTextFile", [
      { path: file, content: "hello\n", createParents: true },
    ]);
    assert.equal(await readFile(file, "utf8"), "hello\n");
    const text = await call("filesystem", "readTextFile", [{ path: file }]);
    assert.equal((text as { content: string }).content, "hello\n");
    const binary = await call("filesystem", "readBinaryFile", [{ path: file }]);
    assert.ok(Object.values(binary as object).some((value) => value instanceof Uint8Array));
    const result = (await call("execution", "run", [
      {
        command: {
          mode: "argv",
          file: process.execPath,
          args: [
            "-e",
            "process.stdout.write(process.cwd());process.stderr.write('full-error');process.exit(17)",
          ],
        },
        cwd: root,
      },
    ])) as {
      exitCode: number;
      stdout: { text: string };
      stderr: { text: string };
      startedAt: Date;
    };
    assert.equal(result.exitCode, 17);
    assert.equal(result.stdout.text, root);
    assert.equal(result.stderr.text, "full-error");
    assert.ok(result.startedAt instanceof Date);
    const started = (await call("execution", "start", [
      {
        command: { mode: "argv", file: process.execPath, args: ["-e", "setInterval(()=>{},1000)"] },
        cwd: root,
      },
    ])) as { taskId: string };
    assert.ok(started.taskId);
    await call("execution", "cancelBackgroundTask", [started.taskId]);
    const stopped = (await call("execution", "waitForBackgroundTask", [started.taskId])) as {
      status: string;
    };
    assert.ok(["cancelled", "failed", "completed"].includes(stopped.status));
    const missing = (await call("filesystem", "readTextFile", [
      { path: join(root, "missing") },
    ])) as { $nativeFailure: boolean; message: string };
    assert.equal(missing.$nativeFailure, true);
    assert.ok(missing.message);
    await assert.rejects(call("filesystem", "run", [{}]), /Unsupported/);
    await call("execution", "close", []);
    await call("execution", "close", []);
    await server.close();
    await assert.rejects(call("filesystem", "stat", [{ path: root }]), /closing/);
    await call("execution", "close", []);
  },
);

test("failed native resource cleanup remains owned for exact-owner retry", async (t) => {
  let attempts = 0;
  t.mock.method(NodeExecutionAdapter.prototype, "close", async () => {
    attempts++;
    if (attempts === 1) throw new Error("fixture-close-failed");
  });
  const server = new ProjectNativeServer();
  const envelope = {
    workspace: { workspacePath: process.cwd(), workspaceKey: process.cwd() },
    request: {
      ownerId: "retired-runtime",
      callId: "stat",
      routeToken: "verified",
      operation: { port: "filesystem", method: "stat", args: [{ path: process.cwd() }] },
    },
  };
  await server.call(envelope);
  await assert.rejects(server.close(), /cleanup failed/);
  await assert.rejects(server.call(envelope), /closing/);
  await server.close();
  assert.equal(attempts, 2);
});
