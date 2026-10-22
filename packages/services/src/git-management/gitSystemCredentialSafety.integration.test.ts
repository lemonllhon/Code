import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitManagementService } from "./gitManagementService.js";
import { createManagedGitCommand } from "./managedGitCommand.js";
import { createGitCommandProvider } from "../git/providers/gitCommandProvider.js";
import { createGitHttpFixture } from "./gitHttpFixture.js";
import { createHostGitCredentialResolver } from "./gitCredentialHost.js";
import { createGitCredentialHelper } from "@lcode/provider-node/git";

test("Real UI/Agent Git sends a rejected system credential once, survives Host recreation, and resumes only after explicit repair", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "lcode-git-system-safety-")),
    raw = createGitCommandProvider();
  const git = async (args: string[]) => {
    const result = await raw.run({ cwd: home, args });
    assert.equal(result.exitCode, 0, result.stderr);
    return result;
  };
  const values = new Map<string, string>();
  const createOwner = () =>
    createGitManagementService({
      home,
      lockPath: join(home, "profile"),
      detectionCommand: null,
      credentialMetadataRunner: null,
      credentials: {
        load: async (k) => values.get(k) ?? null,
        save: async (k, v) => {
          values.set(k, v);
        },
        delete: async (k) => {
          values.delete(k);
        },
      },
    });
  await git(["init", "--bare", "--template=", "--initial-branch=main", "remote.git"]);
  await git(["init", "--template=", "--initial-branch=main"]);
  const binary = await raw.resolveGitBinary();
  assert.ok(binary);
  const expected = "Basic " + Buffer.from("fixture:fixture-correct").toString("base64");
  const server = await createGitHttpFixture(binary, home, expected);
  t.after(() => server.close());
  const url = server.url + "/remote.git";
  await git(["remote", "add", "origin", url]);
  const helperFile = join(home, "system.cjs"),
    callsFile = join(home, "calls.txt"),
    secretFile = join(home, "secret.txt");
  await writeFile(secretFile, "fixture-wrong");
  // 隔离 fixture 只读取本测试密码；绝不访问开发机凭据库或真实认证服务器。
  await writeFile(
    helperFile,
    `const fs=require('node:fs');if(process.argv.at(-1)==='get'){fs.appendFileSync(${JSON.stringify(callsFile)},'get\\n');process.stdout.write('username=fixture\\npassword='+fs.readFileSync(${JSON.stringify(secretFile)},'utf8')+'\\n\\n')}`,
  );
  const quote = (value: string) => "'" + value.replaceAll("\\", "/").replaceAll("'", "'\\''") + "'";
  const globalConfig = join(home, "fixture.gitconfig");
  await git([
    "config",
    "--file",
    globalConfig,
    "credential.helper",
    `!${quote(process.execPath)} ${quote(helperFile)}`,
  ]);
  const previousGlobal = process.env.GIT_CONFIG_GLOBAL,
    previousSystem = process.env.GIT_CONFIG_NOSYSTEM;
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  t.after(() => {
    if (previousGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previousGlobal;
    if (previousSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
    else process.env.GIT_CONFIG_NOSYSTEM = previousSystem;
  });
  let owner = createOwner();
  t.after(() => owner.dispose());
  const profile = await owner.mutate({
    type: "save",
    expectedRevision: "empty",
    account: {
      name: "Fixture system",
      provider: "server",
      serverUrl: server.url,
      username: "fixture",
      auth: "system",
      privateKeyPath: "",
    },
  });
  const scope = { workspacePath: home, workspaceKey: home };
  const run = () =>
    createManagedGitCommand(owner).run({ cwd: home, args: ["fetch", "--", "origin"] });
  const first = await run();
  assert.notEqual(first.exitCode, 0);
  assert.equal((await readFile(callsFile, "utf8")).trim().split("\n").length, 1);
  const wrong = "Basic " + Buffer.from("fixture:fixture-wrong").toString("base64");
  assert.equal(server.requests.filter((r) => r.authorization === wrong).length, 1);
  assert.equal(JSON.parse(values.get("git-management:v1")!).systemCredentialAttempts.length, 1);
  owner.dispose();
  owner = createOwner();
  const resolver = createHostGitCredentialResolver(owner, async () => [home]);
  const helper = createGitCredentialHelper((input) =>
    resolver(scope, { ...input, workspace: scope, sessionId: "fixture" }),
  );
  t.after(() => helper.close());
  const agent = () =>
    helper
      .environment(process.env)
      .then((env) => raw.run({ cwd: home, args: ["fetch", "origin"], env }));
  const clone = (name: string) =>
    createManagedGitCommand(owner).run({
      cwd: home,
      args: ["clone", "--", url, join(home, name)],
      authentication: { id: profile.accounts[0]!.id, revision: profile.accounts[0]!.revision },
    });
  for (const result of await Promise.all([run(), run(), agent(), clone("blocked-clone")])) {
    assert.notEqual(result.exitCode, 0);
  }
  assert.equal(server.requests.filter((r) => r.authorization === wrong).length, 1);
  assert.equal((await readFile(callsFile, "utf8")).trim().split("\n").length, 1);
  assert.equal(
    (await owner.getSnapshot()).revision,
    profile.revision,
    "Internal safety state must not invalidate account CAS",
  );
  await writeFile(secretFile, "fixture-correct");
  const view = await owner.getRepositoryAuthentication({ workspacePath: home });
  await owner.bindRepositoryAuthentication({
    workspacePath: home,
    url,
    selection: view.choices[0]!.key,
    expectedRevision: view.revision,
  });
  assert.equal((await run()).exitCode, 0);
  const cloned = await clone("successful-clone");
  assert.equal(cloned.exitCode, 0, cloned.stderr);
  assert.equal(JSON.parse(values.get("git-management:v1")!).systemCredentialAttempts.length, 0);
  assert.equal((await agent()).exitCode, 0);
  assert.equal((await run()).exitCode, 0);
  assert.equal(JSON.parse(values.get("git-management:v1")!).systemCredentialAttempts.length, 0);
  assert.ok(!JSON.stringify(await owner.getSnapshot()).includes("attemptId"));
});
