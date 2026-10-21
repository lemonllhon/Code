import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeExecutionAdapter } from "@lcode/adapters/exec";
import { createGitCredentialExecutionPort } from "./git-credential-execution.js";
import type { ExecutionPort, ExecutionRequest } from "@lcode/contracts";

test("Git in argv, shell and git -C uses the private helper without exposing credentials", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "lcode-git-helper-test-"));
  const requests: string[] = [],
    credentials: { cwd: string; url: string }[] = [];
  const expected = "Basic " + Buffer.from("fixture-user:fixture-secret").toString("base64");
  const server = createServer((req, res) => {
    requests.push(req.headers.authorization ?? "");
    if (req.headers.authorization !== expected) {
      res.writeHead(401, { "www-authenticate": 'Basic realm="fixture"' }).end();
      return;
    }
    // 最小可读空仓库 advertisement，真实 Git 完成一次已认证 ls-remote。
    res
      .writeHead(200, { "content-type": "application/x-git-upload-pack-advertisement" })
      .end("001e# service=git-upload-pack\n00000000");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/fixture.git`;
  const raw = createNodeExecutionAdapter({ outputRootDir: join(root, "output") });
  const port = createGitCredentialExecutionPort(raw, async (input) => {
    credentials.push(input);
    return { kind: "http", username: "fixture-user", password: "fixture-secret" };
  });
  t.after(() => port.close?.());
  for (const command of [
    { mode: "argv" as const, file: "git", args: ["ls-remote", url] },
    { mode: "argv" as const, file: "git", args: ["-C", root, "ls-remote", url] },
    { mode: "shell" as const, command: `git ls-remote ${url}` },
  ]) {
    const result = await port.run({ cwd: root, command });
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    assert.ok(!JSON.stringify(result).includes("fixture-secret"));
  }
  assert.equal(credentials.length, 3);
  assert.ok(requests.filter((x) => x === expected).length >= 3);
  assert.ok(credentials.every((r) => r.cwd === root && r.url === url));
  const clone = await port.run({
    cwd: root,
    command: { mode: "argv", file: "git", args: ["clone", url, join(root, "clone")] },
  });
  assert.equal(clone.exitCode, 0, JSON.stringify(clone));
  assert.ok(credentials.at(-1)?.cwd);
});

test("Helper capabilities, teardown and background execution preserve their boundaries", async () => {
  const calls: ExecutionRequest[] = [];
  const base = {
    run: async (request: ExecutionRequest) => {
      calls.push(request);
      return {};
    },
    close: async () => {
      throw new Error("fixture-close-failed");
    },
    runBashWithBackgroundLifecycle: async (request: ExecutionRequest) => {
      calls.push(request);
      return {};
    },
    getBackgroundTask: async () => undefined,
    cancelBackgroundTask: async () => undefined,
  } as unknown as ExecutionPort;
  let lookups = 0;
  const port = createGitCredentialExecutionPort(base, async () => {
    lookups++;
    return { kind: "error", error: "git-account-selection-required" };
  });
  await port.run({ cwd: process.cwd(), command: { mode: "argv", file: "git", args: ["status"] } });
  const env = calls[0]!.env!.set!,
    endpoint = env.LCODE_GIT_HELPER_ENDPOINT!;
  assert.equal(lookups, 0);
  const denied = await fetch(endpoint, { method: "POST", body: "{}" });
  assert.equal(denied.status, 403);
  const result = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: "Bearer " + env.LCODE_GIT_HELPER_CAPABILITY },
    body: JSON.stringify({
      cwd: process.cwd(),
      url: "https://example.invalid/repo.git",
      transport: "http",
    }),
  });
  assert.deepEqual(await result.json(), { kind: "error", error: "git-account-selection-required" });
  assert.ok(
    port.runBashWithBackgroundLifecycle && port.getBackgroundTask && port.cancelBackgroundTask,
  );
  await port.runBashWithBackgroundLifecycle(
    { cwd: process.cwd(), command: { mode: "argv", file: "git", args: ["status"] } },
    { mode: "foreground" } as never,
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.env!.set!.LCODE_GIT_HELPER_ENDPOINT, endpoint);
  const helperCommand = env.GIT_CONFIG_VALUE_1!;
  const helperPath = helperCommand.match(/'([^']+helper\.cjs)'/)?.[1];
  assert.ok(helperPath);
  const source = await readFile(helperPath, "utf8");
  assert.ok(!source.includes(env.LCODE_GIT_HELPER_CAPABILITY!));
  await assert.rejects(port.close!(), /fixture-close-failed/);
  await assert.rejects(fetch(endpoint, { method: "POST" }));
  await assert.rejects(port.run(calls[0]!));
});

test("SSH routes the actual host/port/path and preserves custom commands with quoted key paths", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "lcode-ssh-helper-")),
    script = join(root, "fake ssh.cjs"),
    record = join(root, "args.json"),
    key = join(root, "密钥 ' fixture");
  await writeFile(key, "fixture only; private bytes must not be read");
  await writeFile(
    script,
    `require('node:fs').writeFileSync(${JSON.stringify(record)},JSON.stringify(process.argv.slice(2)));process.stdout.write('0000');`,
  );
  const seen: { url: string; transport: string }[] = [];
  const port = createGitCredentialExecutionPort(
    createNodeExecutionAdapter({ outputRootDir: join(root, "exec") }),
    async (input) => {
      seen.push(input);
      return { kind: "ssh", username: "git", privateKeyPath: key };
    },
  );
  t.after(() => port.close?.());
  const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
  const result = await port.run({
    cwd: root,
    env: {
      set: {
        GIT_SSH_COMMAND: `${quote(process.execPath.replace(/\\/g, "/"))} ${quote(script.replace(/\\/g, "/"))}`,
      },
    },
    command: {
      mode: "argv",
      file: "git",
      args: ["ls-remote", "ssh://git@fixture.invalid:2222/owner/repo.git"],
    },
  });
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  assert.deepEqual(
    seen.map((r) => r.url),
    ["ssh://git@fixture.invalid:2222/owner/repo.git"],
  );
  const args = JSON.parse(await readFile(record, "utf8"));
  assert.equal(args[args.indexOf("-i") + 1], key);
  assert.ok(args.includes("BatchMode=yes") && args.includes("IdentitiesOnly=yes"));
});
