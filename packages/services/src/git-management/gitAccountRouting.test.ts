import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitManagementService } from "./gitManagementService.js";
import { createGitCommandProvider } from "../git/providers/gitCommandProvider.js";
import { buildRemoteWorkspaceIdentity, replaceRemoteWorkspaceIdentityPath } from "@lcode/shared";
import { createHostGitAccountOperator } from "./gitAccountHost.js";

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "lcode-account-routing-")),
    values = new Map<string, string>(),
    raw = createGitCommandProvider();
  const git = async (cwd: string, args: string[]) => {
    const r = await raw.run({ cwd, args });
    assert.equal(r.exitCode, 0, r.stderr);
    return r.stdout.trim();
  };
  await mkdir(join(home, ".config", "gh"), { recursive: true });
  await writeFile(
    join(home, ".config", "gh", "hosts.yml"),
    "github.com:\n  user: alice\n  users:\n    alice: {}\n    bob: {}\n",
  );
  const repo = join(home, "repo");
  await mkdir(repo);
  await git(repo, ["init", "--template=", "--initial-branch=main"]);
  await git(repo, ["remote", "add", "origin", "https://github.com/fixture/original.git"]);
  await git(repo, ["remote", "add", "fork", "https://github.com/fixture/fork.git"]);
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
  return { home, repo, values, owner, git };
}

test("Same-target fetch/push share a single username hint, binding and automatic tombstone", async () => {
  const f = await fixture(),
    scope = { workspacePath: f.repo };
  const fetch = "https://github.com/fixture/original.git",
    push = "https://bob@github.com/fixture/original.git";
  await f.git(f.repo, ["remote", "set-url", "--push", "origin", push]);
  assert.equal(
    (await f.owner.resolveRepositoryAuthentication(scope, fetch)).account?.username,
    "bob",
  );
  let view = await f.owner.getRepositoryAuthentication!(scope);
  assert.equal(
    (await f.owner.readRepositoryContext(scope)).remotes.find((r) => r.url === fetch)!
      .authentication.account?.username,
    "bob",
  );
  view = await f.owner.bindRepositoryAuthentication({
    ...scope,
    url: push,
    selection: view.choices.find((c) => c.username === "bob")!.key,
    expectedRevision: view.revision,
  });
  assert.ok(view.remotes.find((r) => r.name === "origin")!.urls.every((u) => u.selection));
  assert.equal(
    (await f.owner.resolveRepositoryAuthentication(scope, fetch)).account?.username,
    "bob",
  );
  await f.owner.bindRepositoryAuthentication({
    ...scope,
    url: fetch,
    selection: null,
    expectedRevision: view.revision,
  });
  view = await f.owner.getRepositoryAuthentication!(scope);
  assert.ok(view.remotes.find((r) => r.name === "origin")!.urls.every((u) => u.selection === null));
  assert.equal(
    (await f.owner.resolveRepositoryAuthentication(scope, push)).account?.username,
    "bob",
  );
});

test("A remembered username is bound through the original Host CAS and reused by every matching URL", async () => {
  const f = await fixture(),
    scope = { workspacePath: f.repo, workspaceKey: f.repo };
  const url = "https://github.com/fixture/original.git";
  const operate = createHostGitAccountOperator(f.owner, async () => [f.repo]);
  const inspect = await operate(
    scope,
    { workspace: scope, sessionId: "fixture", operation: { action: "inspect", cwd: f.repo, url } },
    () => true,
  );
  assert.equal(inspect.status, "ok");
  if (inspect.status !== "ok") return;
  assert.deepEqual(
    inspect.choices.map((c) => c.username),
    ["alice", "bob"],
  );
  const request = {
    workspace: scope,
    sessionId: "fixture",
    operation: {
      action: "bind" as const,
      cwd: f.repo,
      url,
      username: "bob",
      expectedRevision: inspect.revision,
    },
  };
  const result = await operate(scope, request, () => true);
  assert.equal(result.status, "ok");
  assert.equal(
    (await f.owner.resolveRepositoryAuthentication(scope, url)).account?.username,
    "bob",
  );
  assert.equal(
    (await operate(scope, request, () => true)).status,
    "error",
    "Old inspection cannot replace a newer profile",
  );
  assert.equal(
    (
      await operate(
        scope,
        { ...request, operation: { ...request.operation, cwd: f.home } },
        () => true,
      )
    ).status,
    "error",
  );
  await f.git(f.repo, [
    "remote",
    "set-url",
    "--push",
    "origin",
    "https://bob@github.com/fixture/original.git",
  ]);
  const noUsernameSnapshot = await operate(
    scope,
    { workspace: scope, sessionId: "fixture", operation: { action: "inspect", cwd: f.repo, url } },
    () => true,
  );
  assert.equal(noUsernameSnapshot.status, "ok");
});

test("Different explicit account hints remain isolated and late clients cannot commit account changes", async () => {
  const f = await fixture(),
    scope = { workspacePath: f.repo };
  const fetch = "https://alice@github.com/fixture/original.git",
    push = "https://bob@github.com/fixture/original.git";
  await f.git(f.repo, ["remote", "set-url", "origin", fetch]);
  await f.git(f.repo, ["remote", "set-url", "--push", "origin", push]);
  let view = await f.owner.getRepositoryAuthentication!(scope);
  const request = {
    ...scope,
    url: fetch,
    selection: view.choices.find((c) => c.username === "alice")!.key,
    expectedRevision: view.revision,
  };
  await assert.rejects(
    f.owner.bindRepositoryAuthentication(request, () => false),
    /scope-unavailable/,
  );
  assert.equal((await f.owner.getSnapshot()).accounts.length, 0);
  await f.owner.bindRepositoryAuthentication(request);
  assert.equal(
    (await f.owner.resolveRepositoryAuthentication(scope, fetch)).account?.username,
    "alice",
  );
  assert.equal(
    (await f.owner.resolveRepositoryAuthentication(scope, push)).account?.username,
    "bob",
  );
});

test("A changed Push username cannot silently leave Fetch using the previous shared account", async () => {
  const f = await fixture(),
    scope = { workspacePath: f.repo },
    url = "https://github.com/fixture/original.git";
  const view = await f.owner.getRepositoryAuthentication(scope);
  await f.owner.bindRepositoryAuthentication({
    ...scope,
    url,
    selection: view.choices.find((c) => c.username === "alice")!.key,
    expectedRevision: view.revision,
  });
  await f.git(f.repo, [
    "remote",
    "set-url",
    "--push",
    "origin",
    "https://bob@github.com/fixture/original.git",
  ]);
  await assert.rejects(f.owner.resolveRepositoryAuthentication(scope, url), /binding-stale/);
  const stale = await f.owner.getRepositoryAuthentication(scope);
  assert.ok(stale.remotes.find((r) => r.name === "origin")!.urls.every((u) => u.stale));
  await f.owner.bindRepositoryAuthentication({
    ...scope,
    url,
    selection: stale.choices.find((c) => c.username === "bob")!.key,
    expectedRevision: stale.revision,
  });
  assert.equal(
    (await f.owner.resolveRepositoryAuthentication(scope, url)).account?.username,
    "bob",
  );
});

test("Conflicting old username URL bindings refuse to silently choose the first account", async () => {
  const f = await fixture(),
    scope = { workspacePath: f.repo };
  let view = await f.owner.getRepositoryAuthentication!(scope);
  await f.owner.bindRepositoryAuthentication({
    ...scope,
    url: "https://github.com/fixture/original.git",
    selection: view.choices[0]!.key,
    expectedRevision: view.revision,
  });
  const key = "git-management:v1",
    profile = JSON.parse(f.values.get(key)!);
  profile.bindings.push({
    ...profile.bindings[0],
    url: "https://alice@github.com/fixture/original.git",
    id: null,
    revision: null,
  });
  f.values.set(key, JSON.stringify(profile));
  await assert.rejects(
    f.owner.resolveRepositoryAuthentication(scope, "https://github.com/fixture/original.git"),
    /binding-conflict/,
  );
  const conflicted = await f.owner.getRepositoryAuthentication(scope);
  assert.equal(conflicted.remotes.find((r) => r.name === "origin")!.urls[0]!.stale, true);
  await f.owner.bindRepositoryAuthentication({
    ...scope,
    url: "https://github.com/fixture/original.git",
    selection: conflicted.choices.find((c) => c.username === "bob")!.key,
    expectedRevision: conflicted.revision,
  });
  assert.equal(
    (
      await f.owner.resolveRepositoryAuthentication(
        scope,
        "https://github.com/fixture/original.git",
      )
    ).account?.username,
    "bob",
  );
});
test("Detected accounts can be selected and atomically bound without a separate import", async () => {
  const f = await fixture(),
    request = { workspacePath: f.repo };
  let view = await f.owner.getRepositoryAuthentication!(request);
  assert.equal(view.choices.length, 2);
  await assert.rejects(
    f.owner.resolveRepositoryAuthentication(request, view.remotes[0]!.urls[0]!.url),
    /selection-required/,
  );
  const bob = view.choices.find((a) => a.username === "bob")!;
  view = await f.owner.bindRepositoryAuthentication!({
    ...request,
    url: "https://github.com/fixture/original.git",
    selection: bob.key,
    expectedRevision: view.revision,
  });
  assert.equal((await f.owner.getSnapshot()).accounts.length, 1);
  assert.equal(
    (
      await f.owner.resolveRepositoryAuthentication(
        request,
        "https://github.com/fixture/original.git",
      )
    ).account?.username,
    "bob",
  );
  assert.ok(!JSON.stringify(view).includes('"token"'));
  assert.ok(
    view.remotes.find((r) => r.name === "origin")!.urls[0]!.selection?.startsWith("saved:"),
  );
});

test("Read-only Agent context follows changed bindings without resolving credentials or refreshing OAuth", async () => {
  const f = await fixture(),
    scope = { workspacePath: f.repo },
    url = "https://github.com/fixture/original.git";
  f.owner.authentication = async () => {
    assert.fail("Metadata reads cannot resolve credentials");
  };
  let view = await f.owner.getRepositoryAuthentication!(scope);
  assert.equal(
    (await f.owner.readRepositoryContext(scope)).remotes.find((r) => r.name === "origin")!
      .authentication.status,
    "selection-required",
  );
  for (const username of ["alice", "bob"]) {
    view = await f.owner.bindRepositoryAuthentication!({
      ...scope,
      url,
      selection: view.choices.find((c) => c.username === username)!.key,
      expectedRevision: view.revision,
    });
    const context = await f.owner.readRepositoryContext(scope);
    assert.equal(
      context.remotes.find((r) => r.name === "origin")!.authentication.account?.username,
      username,
    );
    assert.ok(!JSON.stringify(context).includes("saved:"));
  }
  const profile = await f.owner.getSnapshot();
  const bob = profile.accounts.find((a) => a.username === "bob")!;
  await f.owner.mutate({ type: "delete", id: bob.id, expectedRevision: profile.revision });
  assert.equal(
    (await f.owner.readRepositoryContext(scope)).remotes.find((r) => r.name === "origin")!
      .authentication.status,
    "stale",
  );
  await f.git(f.repo, ["remote", "set-url", "origin", "https://other.example.invalid/repo.git"]);
  const changed = await f.owner.readRepositoryContext(scope);
  assert.equal(
    changed.remotes.find((r) => r.name === "origin")!.authentication.status,
    "system-default",
  );
});
test("URL bindings isolate remotes, identities and repositories; changed URLs cannot borrow a binding", async () => {
  const f = await fixture(),
    request = { workspacePath: f.repo };
  const select = async (url: string, name: string, identity?: string) => {
    const scope = { ...request, workspaceIdentity: identity },
      view = await f.owner.getRepositoryAuthentication!(scope);
    return f.owner.bindRepositoryAuthentication!({
      ...scope,
      url,
      selection: view.choices.find((a) => a.username === name)!.key,
      expectedRevision: view.revision,
    });
  };
  await select("https://github.com/fixture/original.git", "alice");
  await select("https://github.com/fixture/fork.git", "bob");
  assert.equal(
    (await f.owner.resolveRepositoryAuthentication(request, "https://github.com/fixture/fork.git"))
      .account?.username,
    "bob",
  );
  await assert.rejects(
    f.owner.resolveRepositoryAuthentication(
      { ...request, workspaceIdentity: "remote-fixture-A" },
      "https://github.com/fixture/fork.git",
    ),
    /selection-required/,
  );
  await select("https://github.com/fixture/fork.git", "alice", "remote-fixture-A");
  assert.equal(
    (
      await f.owner.resolveRepositoryAuthentication(
        { ...request, workspaceIdentity: "remote-fixture-A" },
        "https://github.com/fixture/fork.git",
      )
    ).account?.username,
    "alice",
  );
  const other = join(f.home, "other");
  await mkdir(other);
  await f.git(other, ["init", "--template="]);
  await f.git(other, ["remote", "add", "origin", "https://github.com/fixture/fork.git"]);
  await assert.rejects(
    f.owner.resolveRepositoryAuthentication(
      { workspacePath: other },
      "https://github.com/fixture/fork.git",
    ),
    /selection-required/,
  );
  await f.git(f.repo, ["remote", "set-url", "fork", "https://github.com/fixture/new.git"]);
  await assert.rejects(
    f.owner.resolveRepositoryAuthentication(request, "https://github.com/fixture/fork.git"),
    /remote-changed/,
  );
  await assert.rejects(
    f.owner.resolveRepositoryAuthentication(request, "https://github.com/fixture/new.git"),
    /selection-required/,
  );
});
test("Stale CAS and removed accounts stop; duplicate remote URLs share the same choice", async () => {
  const f = await fixture(),
    request = { workspacePath: f.repo };
  await f.git(f.repo, ["remote", "add", "same", "https://github.com/fixture/original.git"]);
  const initial = await f.owner.getRepositoryAuthentication!(request),
    choice = initial.choices[0]!;
  let view = await f.owner.bindRepositoryAuthentication!({
    ...request,
    url: "https://github.com/fixture/original.git",
    selection: choice.key,
    expectedRevision: initial.revision,
  });
  await assert.rejects(
    f.owner.bindRepositoryAuthentication!({
      ...request,
      url: "https://github.com/fixture/fork.git",
      selection: choice.key,
      expectedRevision: initial.revision,
    }),
    /binding-conflict/,
  );
  assert.equal(
    view.remotes.find((r) => r.name === "origin")!.urls[0]!.selection,
    view.remotes.find((r) => r.name === "same")!.urls[0]!.selection,
  );
  const profile = await f.owner.getSnapshot();
  await f.owner.mutate({
    type: "delete",
    id: profile.accounts[0]!.id,
    expectedRevision: profile.revision,
  });
  view = await f.owner.getRepositoryAuthentication!(request);
  assert.equal(view.remotes.find((r) => r.name === "origin")!.urls[0]!.stale, true);
  await assert.rejects(
    f.owner.resolveRepositoryAuthentication(request, "https://github.com/fixture/original.git"),
    /missing-account|binding-stale/,
  );
});

test("Concurrent choices share the profile CAS; vanished candidates cannot be used", async () => {
  const f = await fixture(),
    scope = { workspacePath: f.repo },
    view = await f.owner.getRepositoryAuthentication!(scope);
  const attempts = await Promise.allSettled([
    f.owner.bindRepositoryAuthentication!({
      ...scope,
      url: "https://github.com/fixture/original.git",
      selection: view.choices[0]!.key,
      expectedRevision: view.revision,
    }),
    f.owner.bindRepositoryAuthentication!({
      ...scope,
      url: "https://github.com/fixture/fork.git",
      selection: view.choices[1]!.key,
      expectedRevision: view.revision,
    }),
  ]);
  assert.equal(attempts.filter((a) => a.status === "fulfilled").length, 1);
  assert.equal((await f.owner.getSnapshot()).accounts.length, 1);
  const fresh = await fixture(),
    initial = await fresh.owner.getRepositoryAuthentication!({ workspacePath: fresh.repo });
  await writeFile(
    join(fresh.home, ".config", "gh", "hosts.yml"),
    "github.com:\n  user: alice\n  users:\n    alice: {}\n",
  );
  await assert.rejects(
    fresh.owner.bindRepositoryAuthentication!({
      workspacePath: fresh.repo,
      url: "https://github.com/fixture/original.git",
      selection: initial.choices.find((c) => c.username === "bob")!.key,
      expectedRevision: initial.revision,
    }),
    /selection-unavailable/,
  );
  assert.equal((await fresh.owner.getSnapshot()).accounts.length, 0);
});

test("Remote subdirectory identities normalize to the repository while distinct targets remain isolated", async () => {
  const f = await fixture(),
    target = { kind: "ssh" as const, host: "fixture.invalid", port: 22, username: "fixture" };
  const identity = buildRemoteWorkspaceIdentity(f.repo, target),
    scope = { workspacePath: f.repo, workspaceIdentity: identity };
  const view = await f.owner.getRepositoryAuthentication!(scope);
  await f.owner.bindRepositoryAuthentication!({
    ...scope,
    url: "https://github.com/fixture/original.git",
    selection: view.choices.find((c) => c.username === "bob")!.key,
    expectedRevision: view.revision,
  });
  const child = join(f.repo, "child");
  await mkdir(child);
  assert.equal(
    (
      await f.owner.resolveRepositoryAuthentication(
        {
          workspacePath: child,
          workspaceIdentity: replaceRemoteWorkspaceIdentityPath(identity, child)!,
        },
        "https://github.com/fixture/original.git",
      )
    ).account?.username,
    "bob",
  );
  await assert.rejects(
    f.owner.resolveRepositoryAuthentication(
      {
        ...scope,
        workspaceIdentity: buildRemoteWorkspaceIdentity(f.repo, { ...target, port: 2222 }),
      },
      "https://github.com/fixture/original.git",
    ),
    /selection-required/,
  );
});

test("Choosing automatic explicitly suppresses a legacy clone account instead of resurrecting it", async () => {
  const f = await fixture(),
    scope = { workspacePath: f.repo },
    url = "https://github.com/fixture/original.git";
  let view = await f.owner.getRepositoryAuthentication!(scope);
  view = await f.owner.bindRepositoryAuthentication!({
    ...scope,
    url,
    selection: view.choices.find((c) => c.username === "bob")!.key,
    expectedRevision: view.revision,
  });
  const account = (await f.owner.getSnapshot()).accounts[0]!;
  await f.git(f.repo, ["config", "lcode.accountId", account.id]);
  view = await f.owner.getRepositoryAuthentication!(scope);
  await f.owner.bindRepositoryAuthentication!({
    ...scope,
    url,
    selection: null,
    expectedRevision: view.revision,
  });
  await assert.rejects(f.owner.resolveRepositoryAuthentication(scope, url), /selection-required/);
});

test("Linked worktrees reuse the repository URL binding ahead of the old shared clone account", async () => {
  const f = await fixture(),
    scope = { workspacePath: f.repo },
    url = "https://github.com/fixture/original.git";
  let view = await f.owner.getRepositoryAuthentication!(scope);
  await f.owner.bindRepositoryAuthentication!({
    ...scope,
    url,
    selection: view.choices.find((c) => c.username === "bob")!.key,
    expectedRevision: view.revision,
  });
  view = await f.owner.getRepositoryAuthentication!(scope);
  const alice = view.choices.find((c) => c.username === "alice")!;
  const profile = await f.owner.getSnapshot();
  await f.owner.mutate({
    type: "import",
    candidateId: alice.key.slice(9),
    expectedRevision: profile.revision,
  });
  const original = (await f.owner.getSnapshot()).accounts.find((c) => c.username === "alice")!;
  await f.git(f.repo, ["config", "lcode.accountId", original.id]);
  await f.git(f.repo, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "fixture",
  ]);
  const checkout = join(f.home, "worktree");
  await f.git(f.repo, ["worktree", "add", "-b", "side", checkout]);
  const auth = await f.owner.resolveRepositoryAuthentication({ workspacePath: checkout }, url);
  assert.equal(auth.account?.username, "bob");
});

test("Direct system selection cannot be swallowed by a saved token for the same login", async () => {
  const f = await fixture(),
    initial = await f.owner.getSnapshot();
  const saved = await f.owner.mutate({
    type: "save",
    expectedRevision: initial.revision,
    account: {
      name: "Saved token",
      provider: "github",
      serverUrl: "https://github.com",
      username: "bob",
      auth: "token",
      privateKeyPath: "",
      token: "fixture-secret",
    },
  });
  const candidate = (await f.owner.detect()).accounts.find((c) => c.username === "bob")!;
  const selected = await f.owner.mutate({
    type: "import",
    expectedRevision: saved.revision,
    candidateId: candidate.candidateId,
  });
  assert.equal(
    selected.accounts.filter((c) => c.username === "bob" && c.auth === "system").length,
    1,
  );
  assert.equal(
    selected.accounts.filter((c) => c.username === "bob" && c.auth === "token").length,
    1,
  );
});

test("A legacy clone choice is visible for origin and cannot leak into another remote URL", async () => {
  const f = await fixture(),
    scope = { workspacePath: f.repo };
  const initial = await f.owner.getSnapshot();
  const alice = (await f.owner.detect()).accounts.find((c) => c.username === "alice")!;
  const imported = await f.owner.mutate({
    type: "import",
    candidateId: alice.candidateId,
    expectedRevision: initial.revision,
  });
  const account = imported.accounts[0]!;
  await f.git(f.repo, ["config", "lcode.accountId", account.id]);
  const view = await f.owner.getRepositoryAuthentication!(scope);
  assert.equal(
    view.remotes.find((r) => r.name === "origin")!.urls[0]!.selection,
    `saved:${account.id}:${account.revision}`,
  );
  assert.equal(view.remotes.find((r) => r.name === "fork")!.urls[0]!.selection, null);
  await assert.rejects(
    f.owner.resolveRepositoryAuthentication(scope, "https://github.com/fixture/fork.git"),
    /selection-required/,
  );
  assert.equal(
    (
      await f.owner.resolveRepositoryAuthentication(
        scope,
        "https://github.com/fixture/original.git",
      )
    ).account?.id,
    account.id,
  );
});
