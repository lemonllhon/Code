import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitManagementService } from "./gitManagementService.js";
import { createManagedGitCommand } from "./managedGitCommand.js";
import { createHostGitCredentialResolver } from "./gitCredentialHost.js";
import { createGitHttpFixture } from "./gitHttpFixture.js";
import { createGitCommandProvider } from "../git/providers/gitCommandProvider.js";
import { createGitCredentialExecutionPort } from "../../../../apps/lcode-cli/packages/bootstrap/src/app/git-credential-execution.js";
import { createNodeExecutionAdapter } from "../../../../apps/lcode-cli/packages/adapters/src/exec/index.js";
test("UI and Agent reuse URL-bound credentials for real fetch and branch/Tag push", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "lcode-git-auth-shared-")),
    values = new Map(),
    raw = createGitCommandProvider();
  const git = async (cwd, args) => {
    const result = await raw.run({ cwd, args });
    assert.equal(result.exitCode, 0, result.stderr);
    return result.stdout.trim();
  };
  await git(home, ["init", "--bare", "--template=", "--initial-branch=main", "remote.git"]);
  await git(join(home, "remote.git"), ["config", "http.receivepack", "true"]);
  const binary = await raw.resolveGitBinary();
  assert.ok(binary);
  const server = await createGitHttpFixture(
    binary,
    home,
    "Basic " + Buffer.from("bob:fixture-bob-secret").toString("base64"),
  );
  t.after(() => server.close());
  const owner = createGitManagementService({
    home,
    lockPath: join(home, "lock"),
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
  t.after(() => owner.dispose());
  let profile = await owner.getSnapshot();
  for (const username of ["alice", "bob"])
    profile = await owner.mutate({
      type: "save",
      expectedRevision: profile.revision,
      account: {
        name: username,
        username,
        serverUrl: server.url,
        provider: "server",
        auth: "token",
        privateKeyPath: "",
        token: `fixture-${username}-secret`,
      },
    });
  const repo = join(home, "checkout");
  await mkdir(repo);
  await git(repo, ["init", "--template=", "--initial-branch=main"]);
  await git(repo, ["remote", "add", "origin", server.url + "/remote.git"]);
  const scope = { workspacePath: repo };
  let view = await owner.getRepositoryAuthentication(scope);
  await owner.bindRepositoryAuthentication({
    ...scope,
    url: server.url + "/remote.git",
    selection: view.choices.find((c) => c.username === "bob").key,
    expectedRevision: view.revision,
  });
  await writeFile(join(repo, "README.md"), "fixture\n");
  await git(repo, ["add", "README.md"]);
  await git(repo, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "fixture",
  ]);
  const managed = createManagedGitCommand(owner);
  let result = await managed.run({
    cwd: repo,
    args: ["push", "--", "origin", "HEAD:refs/heads/main"],
  });
  assert.equal(result.exitCode, 0, result.stderr);
  const resolver = createHostGitCredentialResolver(owner, async () => [repo]);
  const port = createGitCredentialExecutionPort(
    createNodeExecutionAdapter({ outputRootDir: join(home, "exec") }),
    (input) =>
      resolver(
        { ...scope, workspaceKey: repo },
        { ...input, workspace: { ...scope, workspaceKey: repo }, sessionId: "fixture-session" },
      ),
  );
  t.after(() => port.close?.());
  for (const args of [
    ["fetch", "origin"],
    ["push", "origin", "HEAD:refs/heads/agent"],
    ["tag", "v-fixture"],
    ["push", "origin", "refs/tags/v-fixture"],
  ]) {
    const execution = await port.run({ cwd: repo, command: { mode: "argv", file: binary, args } });
    assert.equal(execution.exitCode, 0, JSON.stringify(execution));
    assert.ok(!JSON.stringify(execution).includes("fixture-bob-secret"));
  }
  assert.equal(
    await git(join(home, "remote.git"), ["rev-parse", "refs/tags/v-fixture"]),
    await git(repo, ["rev-parse", "HEAD"]),
  );
  assert.equal(
    (
      await resolver(
        { workspacePath: home, workspaceKey: home },
        {
          workspace: { workspacePath: home, workspaceKey: home },
          sessionId: "fixture",
          cwd: home,
          url: server.url + "/remote.git",
          transport: "http",
        },
      )
    ).kind,
    "error",
  );
  assert.ok(
    server.requests
      .filter((r) => r.authorization)
      .every(
        (r) =>
          r.authorization === "Basic " + Buffer.from("bob:fixture-bob-secret").toString("base64"),
      ),
  );
  view = await owner.getRepositoryAuthentication(scope);
  assert.ok(!JSON.stringify(view).includes("fixture-bob-secret"));
  const homeScope = { workspacePath: home, workspaceKey: home };
  const cloneResolver = createHostGitCredentialResolver(owner, async () => [home]);
  const clonePort = createGitCredentialExecutionPort(
    createNodeExecutionAdapter({ outputRootDir: join(home, "clone-exec") }),
    (input) =>
      cloneResolver(homeScope, { ...input, workspace: homeScope, sessionId: "fixture-clone" }),
  );
  t.after(() => clonePort.close?.());
  const cloneUrl = new URL(server.url + "/remote.git");
  cloneUrl.username = "bob";
  const clone = await clonePort.run({
    cwd: home,
    command: {
      mode: "argv",
      file: binary,
      args: ["clone", cloneUrl.href, join(home, "agent-clone")],
    },
  });
  assert.equal(clone.exitCode, 0, JSON.stringify(clone));
  assert.ok(!clone.stderr.text.includes("http.c:"));
  await t.test("One push resolves separate identities for every configured push URL", async () => {
    await git(home, ["init", "--bare", "--template=", "--initial-branch=main", "second.git"]);
    await git(join(home, "second.git"), ["config", "http.receivepack", "true"]);
    const other = await createGitHttpFixture(
      binary,
      home,
      "Basic " + Buffer.from("alice:fixture-other-secret").toString("base64"),
    );
    t.after(() => other.close());
    const state = await owner.getSnapshot();
    await owner.mutate({
      type: "save",
      expectedRevision: state.revision,
      account: {
        name: "Other Alice",
        username: "alice",
        serverUrl: other.url,
        provider: "server",
        auth: "token",
        privateKeyPath: "",
        token: "fixture-other-secret",
      },
    });
    await git(repo, ["remote", "set-url", "--add", "--push", "origin", server.url + "/remote.git"]);
    await git(repo, ["remote", "set-url", "--add", "--push", "origin", other.url + "/second.git"]);
    const current = await owner.getRepositoryAuthentication(scope);
    await owner.bindRepositoryAuthentication({
      ...scope,
      url: other.url + "/second.git",
      selection: current.choices.find((c) => c.serverUrl === other.url).key,
      expectedRevision: current.revision,
    });
    const ui = await managed.run({
      cwd: repo,
      args: ["push", "--", "origin", "HEAD:refs/heads/multi-ui"],
    });
    assert.equal(ui.exitCode, 0, ui.stderr);
    const agent = await port.run({
      cwd: repo,
      command: {
        mode: "argv",
        file: binary,
        args: ["push", "origin", "HEAD:refs/heads/multi-agent"],
      },
    });
    assert.equal(agent.exitCode, 0, JSON.stringify(agent));
    for (const remote of ["remote.git", "second.git"])
      assert.equal(
        await git(join(home, remote), ["rev-parse", "refs/heads/multi-agent"]),
        await git(repo, ["rev-parse", "HEAD"]),
      );
    assert.ok(
      other.requests.some(
        (r) =>
          r.authorization ===
          "Basic " + Buffer.from("alice:fixture-other-secret").toString("base64"),
      ),
    );
    assert.ok(!JSON.stringify(agent).includes("fixture-other-secret"));
  });
  await t.test(
    "System-managed multi-account lookup supplies the selected username for UI and Agent",
    async () => {
      await git(home, ["init", "--bare", "--template=", "--initial-branch=main", "system.git"]);
      const system = await createGitHttpFixture(
        binary,
        home,
        "Basic " + Buffer.from("bob:fixture-system-secret").toString("base64"),
      );
      t.after(() => system.close());
      await git(repo, ["remote", "add", "systems", system.url + "/system.git"]);
      await git(repo, ["config", "--local", "--replace-all", "credential.helper", ""]);
      const helper =
        '!f() { username=alice; while IFS= read -r line; do case "$line" in username=*) username=${line#username=} ;; esac; done; printf "%s\\n" "username=$username" "password=fixture-system-secret"; }; f';
      await git(repo, ["config", "--local", "--add", "credential.helper", helper]);
      let state = await owner.getSnapshot();
      for (const username of ["alice", "bob"])
        state = await owner.mutate({
          type: "save",
          expectedRevision: state.revision,
          account: {
            name: "System " + username,
            username,
            serverUrl: system.url,
            provider: "server",
            auth: "system",
            privateKeyPath: "",
          },
        });
      const current = await owner.getRepositoryAuthentication(scope);
      await owner.bindRepositoryAuthentication({
        ...scope,
        url: system.url + "/system.git",
        selection: current.choices.find((c) => c.serverUrl === system.url && c.username === "bob")
          .key,
        expectedRevision: current.revision,
      });
      const ui = await managed.run({ cwd: repo, args: ["fetch", "--", "systems"] });
      assert.equal(ui.exitCode, 0, ui.stderr);
      const agent = await port.run({
        cwd: repo,
        command: { mode: "argv", file: binary, args: ["fetch", "systems"] },
      });
      assert.equal(agent.exitCode, 0, JSON.stringify(agent));
      assert.ok(
        system.requests.some(
          (r) =>
            r.authorization ===
            "Basic " + Buffer.from("bob:fixture-system-secret").toString("base64"),
        ),
      );
      assert.ok(!JSON.stringify([...values.values()]).includes("fixture-system-secret"));
    },
  );
});
