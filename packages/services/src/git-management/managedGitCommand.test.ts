import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { once } from "node:events";
import { createServer as createPortServer } from "node:net";
import { createGitManagementService } from "./gitManagementService.js";
import { createManagedGitCommand } from "./managedGitCommand.js";
import {
  createGitCommandProvider,
  type GitCommandExecutionOptions,
} from "../git/providers/gitCommandProvider.js";
import { createGitService } from "../git/gitService.js";
import { createGitEnvironmentProvider } from "../git/providers/gitEnvironmentProvider.js";
import { createGitHttpFixture } from "./gitHttpFixture.js";
import { createCheckoutCoordinator } from "../worktree/node.js";
import { coordinateGitCheckoutWrites } from "../git/gitCheckoutCoordination.js";
import { createGitCheckpointService } from "../git/gitCheckpointService.js";
import { captureGitSnapshot } from "../git-backup/gitBackupSnapshot.js";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "lcode-managed-git-")),
    values = new Map<string, string>();
  const owner = createGitManagementService({
    home: directory,
    lockPath: join(directory, "profile"),
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
  const raw = createGitCommandProvider(),
    calls: GitCommandExecutionOptions[] = [];
  const command = createManagedGitCommand(owner, {
    resolveGitBinary: () => raw.resolveGitBinary(),
    run: async (input) => {
      calls.push(input);
      return raw.run(input);
    },
  });
  const git = async (cwd: string, args: string[]) => {
    const result = await raw.run({
      cwd,
      args,
      env: { GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" },
    });
    assert.equal(result.exitCode, 0, result.stderr);
    return result.stdout.trim();
  };
  return { directory, owner, command, calls, git };
}
test("Real authenticated clone binds an account and reuses it for fetch and branch/Tag pushes", async (t) => {
  const f = await fixture(),
    raw = createGitCommandProvider();
  await f.git(f.directory, ["init", "--bare", "--template=", "--initial-branch=main", "repo.git"]);
  await f.git(join(f.directory, "repo.git"), ["config", "http.receivepack", "true"]);
  const binary = await raw.resolveGitBinary();
  assert.ok(binary);
  const server = await createGitHttpFixture(
    binary,
    f.directory,
    `Basic ${Buffer.from("fixture:fixture-live-secret").toString("base64")}`,
  );
  t.after(() => server.close());
  let snapshot = await f.owner.mutate({
      type: "save",
      expectedRevision: "empty",
      account: {
        name: "Live HTTP",
        provider: "server",
        serverUrl: server.url,
        username: "fixture",
        auth: "token",
        privateKeyPath: "",
        token: "fixture-live-secret",
      },
    }),
    account = snapshot.accounts[0]!;
  snapshot = await f.owner.mutate({
    type: "configuration",
    expectedRevision: snapshot.revision,
    configuration: {
      ...snapshot.configuration,
      userName: "Fixture",
      userEmail: "fixture@example.invalid",
    },
  });
  const coordinator = createCheckoutCoordinator({
    dataDir: join(f.directory, "coord"),
    git: f.command,
  });
  const service = coordinateGitCheckoutWrites(
    createGitService({
      commandProvider: f.command,
      reviewStateDataDir: join(f.directory, "journal"),
      checkoutCoordinator: coordinator,
    }),
    coordinator,
  );
  const parent = join(f.directory, "parent");
  await mkdir(parent);
  const options = {
    workspacePath: parent,
    mode: "clone" as const,
    url: server.url + "/repo.git",
    targetName: "cloned",
    authentication: { id: account.id, revision: account.revision },
  };
  const receipt = await service.acquireRepository({
    options,
    preview: await service.previewRepositoryAcquisition(options),
    requestId: crypto.randomUUID(),
  });
  assert.equal(receipt.status, "success", JSON.stringify(receipt));
  const cloned = join(parent, "cloned");
  assert.equal(await f.git(cloned, ["config", "--local", "--get", "lcode.accountId"]), account.id);
  await writeFile(join(cloned, "README.md"), "fixture\n");
  await f.git(cloned, ["add", "--", "README.md"]);
  let result = await f.command.run({ cwd: cloned, args: ["commit", "-m", "fixture"] });
  assert.equal(result.exitCode, 0, result.stderr);
  const config = await readFile(join(cloned, ".git", "config"), "utf8");
  assert.ok(!config.includes("fixture-live-secret"));
  assert.ok(!config.includes("extraHeader"));
  const localIdentity = await raw.run({
    cwd: cloned,
    args: ["config", "--local", "--get", "user.name"],
  });
  assert.equal(localIdentity.exitCode, 1);
  assert.equal(
    await f.git(cloned, ["show", "-s", "--format=%an%n%ae", "HEAD"]),
    "Fixture\nfixture@example.invalid",
  );
  for (const args of [
    ["push", "--", "origin", "HEAD:refs/heads/main"],
    ["fetch", "--", "origin"],
    ["tag", "v-fixture"],
    ["push", "--", "origin", "refs/tags/v-fixture:refs/tags/v-fixture"],
  ]) {
    result = await f.command.run({ cwd: cloned, args });
    assert.equal(result.exitCode, 0, result.stderr);
  }
  assert.equal(
    await f.git(join(f.directory, "repo.git"), ["rev-parse", "refs/heads/main"]),
    await f.git(cloned, ["rev-parse", "HEAD"]),
  );
  assert.equal(
    await f.git(join(f.directory, "repo.git"), ["rev-parse", "refs/tags/v-fixture"]),
    await f.git(cloned, ["rev-parse", "HEAD"]),
  );
  assert.ok(server.requests.length >= 6);
  assert.ok(
    server.requests.every(
      (request) =>
        request.authorization ===
        `Basic ${Buffer.from("fixture:fixture-live-secret").toString("base64")}`,
    ),
  );
  let backupCommands = 0;
  const backup = await captureGitSnapshot(cloned, {
    commandProvider: {
      resolveGitBinary: () => f.command.resolveGitBinary(),
      run: async (input) => {
        backupCommands++;
        return f.command.run(input);
      },
    },
  });
  assert.ok(backup.packed.length > 0);
  assert.equal(backupCommands, 1);
});
test("Checkpoints use the configured Git provider and retain unavailable boundaries", async () => {
  let resolutions = 0;
  const checkpoints = createGitCheckpointService({
    commandProvider: {
      resolveGitBinary: async () => {
        resolutions++;
        return null;
      },
      run: async () => {
        throw new Error("Unexpected system Git");
      },
    },
  });
  await assert.rejects(
    checkpoints.createCheckpoint({ workspacePath: tmpdir() }),
    /Git binary is not available/,
  );
  assert.equal(resolutions, 1);
});

test("System credentials honor the selected account username instead of the helper's default", async (t) => {
  const f = await fixture();
  await f.git(f.directory, [
    "init",
    "--bare",
    "--template=",
    "--initial-branch=main",
    "system.git",
  ]);
  const binary = await createGitCommandProvider().resolveGitBinary();
  assert.ok(binary);
  const expected = `Basic ${Buffer.from("bob:fixture-system-secret").toString("base64")}`;
  const server = await createGitHttpFixture(binary, f.directory, expected);
  t.after(() => server.close());
  const snapshot = await f.owner.mutate({
    type: "save",
    expectedRevision: "empty",
    account: {
      name: "Selected Bob",
      provider: "server",
      serverUrl: server.url,
      username: "bob",
      auth: "system",
      privateKeyPath: "",
    },
  });
  const account = snapshot.accounts[0]!;
  const helper =
    '!f() { username=alice; while IFS= read -r line; do case "$line" in username=*) username=${line#username=} ;; esac; done; printf "%s\\n" "username=$username" "password=fixture-system-secret"; }; f';
  const cloned = join(f.directory, "system-clone");
  const result = await f.command.run({
    cwd: f.directory,
    args: [
      "-c",
      "credential.helper=",
      "-c",
      `credential.helper=${helper}`,
      "clone",
      "--",
      server.url + "/system.git",
      cloned,
    ],
    authentication: { id: account.id, revision: account.revision },
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.ok(server.requests.some((request) => request.authorization === expected));
  assert.ok(
    server.requests.every(
      (request) => !request.authorization || request.authorization === expected,
    ),
  );
  assert.ok(
    !(await readFile(join(cloned, ".git", "config"), "utf8")).includes("fixture-system-secret"),
  );
});

test("Authorized GitLab account uses oauth2 for real Git HTTP clone, Fetch and Push while preserving its login name", async (t) => {
  const f = await fixture(),
    raw = createGitCommandProvider();
  await f.git(f.directory, ["init", "--bare", "--template=", "--initial-branch=main", "oauth.git"]);
  await f.git(join(f.directory, "oauth.git"), ["config", "http.receivepack", "true"]);
  const binary = await raw.resolveGitBinary();
  assert.ok(binary);
  const expected = `Basic ${Buffer.from("oauth2:fixture-oauth-access").toString("base64")}`,
    server = await createGitHttpFixture(binary, f.directory, expected);
  t.after(() => server.close());
  const values = new Map<string, string>();
  const owner = createGitManagementService({
    home: f.directory,
    lockPath: join(f.directory, "oauth-profile"),
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
    oauthHttp: async (url) =>
      new Response(
        JSON.stringify(
          String(url).endsWith("/oauth/token")
            ? { access_token: "fixture-oauth-access", expires_in: 3600 }
            : { id: 5, username: "actual-gitlab-user" },
        ),
      ),
  });
  t.after(() => owner.dispose());
  const port = createPortServer();
  port.listen(0, "127.0.0.1");
  await once(port, "listening");
  const redirectUri = `http://127.0.0.1:${(port.address() as { port: number }).port}/git-auth/callback`;
  await new Promise<void>((resolve) => port.close(() => resolve()));
  const requestId = crypto.randomUUID(),
    attempt = await owner.authorize({
      type: "start",
      requestId,
      provider: "gitlab",
      serverUrl: server.url,
      clientId: "fixture",
      redirectUri,
    });
  await owner.authorize({
    type: "callback",
    requestId,
    url:
      redirectUri +
      "?code=fixture&state=" +
      new URL(attempt.authorizeUrl!).searchParams.get("state"),
  });
  const snapshot = await owner.mutate({
      type: "authorize",
      expectedRevision: "empty",
      requestId,
      name: "GitLab OAuth",
    }),
    account = snapshot.accounts[0]!;
  assert.equal(account.username, "actual-gitlab-user");
  const command = createManagedGitCommand(owner, raw),
    cloned = join(f.directory, "oauth-clone");
  let result = await command.run({
    cwd: f.directory,
    args: ["clone", "--", server.url + "/oauth.git", cloned],
    authentication: { id: account.id, revision: account.revision },
  });
  assert.equal(result.exitCode, 0, result.stderr);
  await writeFile(join(cloned, "file.txt"), "oauth fixture\n");
  await f.git(cloned, ["add", "--", "file.txt"]);
  await f.git(cloned, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "fixture",
  ]);
  for (const args of [
    ["push", "--", "origin", "HEAD:refs/heads/main"],
    ["fetch", "--", "origin"],
  ]) {
    result = await command.run({ cwd: cloned, args });
    assert.equal(result.exitCode, 0, result.stderr);
  }
  assert.ok(
    server.requests.every(
      (request) => !request.authorization || request.authorization === expected,
    ),
  );
  assert.ok(
    !(await readFile(join(cloned, ".git/config"), "utf8")).includes("fixture-oauth-access"),
  );
});
test("Real Git sends scoped HTTP auth, refuses redirects and persists no token in URL/config", async (t) => {
  const f = await fixture(),
    requests: { url: string; authorization?: string }[] = [];
  let redirects = 0;
  const destination = createServer((_req, res) => {
    redirects++;
    res.end();
  });
  destination.listen(0, "127.0.0.1");
  await once(destination, "listening");
  const destPort = (destination.address() as import("node:net").AddressInfo).port;
  const server = createServer((req, res) => {
    requests.push({ url: req.url!, authorization: req.headers.authorization });
    res.writeHead(302, { Location: `http://127.0.0.1:${destPort}/unexpected.git` });
    res.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.close();
    destination.close();
  });
  const url = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  const snapshot = await f.owner.mutate({
      type: "save",
      expectedRevision: "empty",
      account: {
        name: "Local",
        provider: "server",
        serverUrl: url,
        username: "fixture",
        auth: "token",
        token: "fixture-network-secret",
        privateKeyPath: "",
      },
    }),
    account = snapshot.accounts[0]!;
  const result = await f.command.run({
    cwd: f.directory,
    args: ["clone", "--", url + "/repository.git", join(f.directory, "clone")],
    authentication: { id: account.id, revision: account.revision },
  });
  assert.notEqual(result.exitCode, 0);
  assert.equal(redirects, 0);
  assert.ok(requests.length > 0);
  assert.equal(
    requests[0]!.authorization,
    `Basic ${Buffer.from("fixture:fixture-network-secret").toString("base64")}`,
  );
  assert.ok(!JSON.stringify(result).includes("fixture-network-secret"));
  assert.ok(!JSON.stringify(f.calls.map((c) => c.args)).includes("fixture-network-secret"));
});
test("Bound accounts apply to fetch/push; a deleted or wrong-host account never falls back", async () => {
  const f = await fixture();
  await f.git(f.directory, ["init", "--initial-branch=main", "--template=", "repo"]);
  const repo = join(f.directory, "repo");
  await f.git(f.directory, ["init", "--bare", "--template=", "remote.git"]);
  const remote = join(f.directory, "remote.git");
  await f.git(repo, ["remote", "add", "origin", remote]);
  const snapshot = await f.owner.mutate({
      type: "save",
      expectedRevision: "empty",
      account: {
        name: "Bound",
        provider: "github",
        serverUrl: "https://github.com",
        username: "fixture",
        auth: "token",
        token: "fixture-secret",
        privateKeyPath: "",
      },
    }),
    account = snapshot.accounts[0]!;
  await f.git(repo, ["config", "lcode.accountId", account.id]);
  await assert.rejects(
    f.command.run({ cwd: repo, args: ["fetch", "--", "origin"] }),
    /account-server-mismatch/,
  );
  await f.owner.mutate({ type: "delete", expectedRevision: snapshot.revision, id: account.id });
  await assert.rejects(
    f.command.run({ cwd: repo, args: ["push", "--", "origin", "HEAD:refs/heads/main"] }),
    /missing-account/,
  );
  assert.equal(
    f.calls.some((c) => c.args[0] === "fetch" || c.args[0] === "push"),
    false,
  );
});
test("Account versions are rechecked before acquisition creates a directory", async () => {
  const f = await fixture();
  const snapshot = await f.owner.mutate({
      type: "save",
      expectedRevision: "empty",
      account: {
        name: "Clone",
        provider: "github",
        serverUrl: "https://github.com",
        username: "fixture",
        auth: "token",
        token: "fixture-secret",
        privateKeyPath: "",
      },
    }),
    account = snapshot.accounts[0]!;
  const service = createGitService({
    commandProvider: f.command,
    reviewStateDataDir: join(f.directory, "journal"),
  });
  const options = {
    workspacePath: f.directory,
    mode: "clone" as const,
    url: "https://github.com/example/fixture.git",
    targetName: "new-repo",
    authentication: { id: account.id, revision: account.revision },
  };
  const preview = await service.previewRepositoryAcquisition(options);
  await f.owner.mutate({
    type: "save",
    expectedRevision: snapshot.revision,
    account: {
      name: "Changed",
      id: account.id,
      provider: account.provider,
      serverUrl: account.serverUrl,
      username: account.username,
      auth: account.auth,
      privateKeyPath: "",
      token: "",
    },
  });
  const receipt = await service.acquireRepository({
    options,
    preview,
    requestId: crypto.randomUUID(),
  });
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.code, "stale-account");
  await assert.rejects(readFile(join(f.directory, "new-repo", ".git", "config")));
});
test("Configured Git binary changes take effect and invalid paths do not fall back", async () => {
  const raw = createGitEnvironmentProvider(),
    valid = await raw.resolveGitBinary();
  assert.ok(valid);
  let path = valid;
  const provider = createGitEnvironmentProvider({ configuredBinary: async () => path });
  assert.equal(await provider.resolveGitBinary(), valid);
  path = join(tmpdir(), "missing-lcode-git-binary");
  assert.equal(await provider.resolveGitBinary(), null);
  path = "";
  assert.ok(await provider.resolveGitBinary());
});
test("SSH only references key paths and process identity does not change repository config", async () => {
  const f = await fixture();
  await mkdir(join(f.directory, "keys"));
  const key = join(f.directory, "keys", "with space's key");
  await writeFile(key, "fixture-private");
  let snapshot = await f.owner.mutate({
      type: "save",
      expectedRevision: "empty",
      account: {
        name: "SSH",
        provider: "server",
        serverUrl: "ssh://git@example.invalid",
        username: "git",
        auth: "ssh",
        privateKeyPath: key,
      },
    }),
    account = snapshot.accounts[0]!;
  snapshot = await f.owner.mutate({
    type: "configuration",
    expectedRevision: snapshot.revision,
    configuration: {
      ...snapshot.configuration,
      userName: "Fixture Name",
      userEmail: "fixture@example.invalid",
    },
  });
  const command = createManagedGitCommand(f.owner, {
    resolveGitBinary: async () => "git",
    run: async (input) => {
      assert.match(input.env!.GIT_SSH_COMMAND!, /IdentitiesOnly=yes/);
      assert.ok(!input.env!.GIT_SSH_COMMAND!.includes("StrictHostKeyChecking=no"));
      assert.ok(!JSON.stringify(input).includes("fixture-private"));
      return {
        binaryPath: "git",
        cwd: input.cwd,
        args: input.args,
        stdout: "",
        stderr: "",
        exitCode: 0,
        signal: null,
        durationMs: 0,
        timedOut: false,
        outputTruncated: false,
      };
    },
  });
  await command.run({
    cwd: f.directory,
    args: ["clone", "--", "git@example.invalid:repo.git", "new"],
    authentication: { id: account.id, revision: account.revision },
  });
  assert.equal(await readFile(key, "utf8"), "fixture-private");
});
