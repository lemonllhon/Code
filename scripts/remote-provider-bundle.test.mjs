import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { watch } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import {
  BufferReader,
  VSBuffer,
  deserialize,
  ProtocolMessageType,
} from "../packages/rpc/src/index.ts";
import { SERVICE_AUTHORITY_MODE_ENV } from "../packages/shared/src/index.ts";

test(
  "实际 remote CJS Server 握手后可恢复被删除的 Bundled/Active，stdout 保持协议流",
  { timeout: 25_000 },
  async (t) => {
    const bundle = resolve("packages/server/dist/remote/lcode-server.cjs");
    await readFile(bundle); // 前置 pnpm --filter @lcode/server build:remote，缺少产物不能假报通过。
    const root = await mkdtemp(join(tmpdir(), "lcode-remote-bundle-"));
    const cleanup = [() => rm(root, { recursive: true, force: true })];
    t.after(async () => {
      for (const action of cleanup.reverse()) await action();
    });
    const server = createServer((_request, response) => {
      response.writeHead(404);
      response.end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    cleanup.push(() => {
      server.closeAllConnections();
      return new Promise((done) => server.close(done));
    });
    const endpoint = `http://127.0.0.1:${server.address().port}`;
    const child = spawn(process.execPath, [bundle], {
      windowsHide: true,
      env: {
        ...process.env,
        LCODE_DATA_BASE_DIR: root,
        HOME: root,
        USERPROFILE: root,
        LCODE_BASE_URL: endpoint,
        LCODE_ENDPOINT_ORIGIN: endpoint,
        LCODE_ENV: "test",
        LCODE_CREDENTIAL_SECRET: "",
        ZCODE_CREDENTIAL_SECRET: "",
        [SERVICE_AUTHORITY_MODE_ENV]: "desktop-attached-remote",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const closed = once(child, "close");
    cleanup.push(async () => {
      child.stdin.end();
      const kill = setTimeout(() => child.kill(), 4_000);
      try {
        await closed;
      } finally {
        clearTimeout(kill);
      }
    });
    let stdout = Buffer.alloc(0);
    let stderr = "";
    let acknowledged = false;
    const progress = new EventEmitter();
    child.stdout.on("data", (chunk) => {
      stdout = Buffer.concat([stdout, chunk]);
      if (acknowledged) return;
      const newline = stdout.indexOf("\n");
      if (newline < 0) return;
      const hello = JSON.parse(stdout.subarray(0, newline).toString("utf8"));
      assert.equal(hello.type, "lcode-hello");
      acknowledged = true;
      child.stdin.write(
        `${JSON.stringify({ type: "lcode-hello-ack", version: hello.version, clientId: "fixture-bundle-test" })}\n`,
      );
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      progress.emit("change");
    });
    async function waitForLog(pattern) {
      while (!pattern.test(stderr)) {
        if (child.exitCode !== null) throw new Error(`fixture Server exited ${child.exitCode}`);
        await Promise.race([
          once(progress, "change", { signal: t.signal }),
          closed.then(() => {
            throw new Error("fixture Server closed before expected lifecycle event");
          }),
        ]);
      }
    }
    await waitForLog(/Provider Registry 已就绪/);
    assert.equal(acknowledged, true);
    const runtime = join(root, ".lcode", "v2", "runtime", "provider");
    const paths = (await readdir(runtime, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name === "lcode-builtin.json")
      .map((entry) => join(entry.parentPath, entry.name));
    assert.equal(paths.length, 2);
    const active = paths.find((path) => basename(dirname(path)) !== "bundled");
    const expected = JSON.parse(await readFile(active, "utf8")).revision;
    await Promise.all(paths.map((path) => rm(path)));
    await waitForLog(/LCode Built-in 资源副本已恢复/);
    const restored = new Promise((done, reject) => {
      const watcher = watch(dirname(active), (_event, name) => {
        if (name?.toString() === basename(active)) void check();
      });
      watcher.once("error", reject);
      cleanup.push(() => watcher.close());
      async function check() {
        try {
          const release = JSON.parse(await readFile(active, "utf8"));
          if (release.revision === expected) {
            watcher.close();
            done();
          }
        } catch (error) {
          if (error.code !== "ENOENT") reject(error);
        }
      }
      void check();
    });
    await restored;
    for (const path of paths)
      assert.equal(JSON.parse(await readFile(path, "utf8")).revision, expected);
    assert.equal(child.exitCode, null);
    // hello 之后是二进制 Channel Initialize 帧，不能按文本行数判断协议污染。
    const frame = stdout.subarray(stdout.indexOf("\n") + 1);
    assert.ok(frame.length >= 13);
    assert.equal(frame.readUInt8(0), ProtocolMessageType.Regular);
    assert.equal(frame.length, 13 + frame.readUInt32BE(9));
    const reader = new BufferReader(VSBuffer.wrap(frame.subarray(13)));
    assert.deepEqual(deserialize(reader), [200]);
    assert.equal(deserialize(reader), undefined);
    assert.ok(!stderr.includes("Bundled 与 Active LCode Built-in Release 均不可用"));
  },
);
