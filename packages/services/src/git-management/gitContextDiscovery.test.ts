import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitAccountRouting } from "./gitAccountRouting.js";
import { projectGitRepositoryContext } from "./gitRepositoryContext.js";
import { createSystemGitCredentialGuard } from "./gitSystemCredentialGuard.js";

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "lcode-context-discovery-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = await realpath(directory);
  const url = "https://example.invalid/team/repo.git";
  const account = {
    id: "11111111-1111-4111-8111-111111111111",
    revision: "22222222-2222-4222-8222-222222222222",
    name: "Fixture",
    username: "alice",
    provider: "github" as const,
    serverUrl: "https://example.invalid",
    auth: "token" as const,
    privateKeyPath: "",
    token: "fixture-only",
  };
  type Profile = Awaited<ReturnType<Parameters<typeof createGitAccountRouting>[0]["read"]>>;
  const profile: Profile = {
    revision: "profile-1",
    accounts: [account],
    systemCredentialAttempts: [],
    bindings: [{ scope: root, root, url, id: account.id, revision: account.revision }],
  };
  const remotes = new Map([["origin", url]]);
  let discoveries = 0,
    authentication = 0,
    legacy = "";
  const routing = createGitAccountRouting({
    read: async () => profile,
    update: async () => assert.fail("read-only context cannot write"),
    detect: async () => {
      discoveries++;
      return { entries: [] };
    },
    authenticate: async () => {
      authentication++;
      return { account, secret: account.token };
    },
    command: {
      resolveGitBinary: async () => "/fixture/git",
      run: async (input) => ({
        ...input,
        binaryPath: "/fixture/git",
        stderr: "",
        stdout:
          input.args[0] === "rev-parse"
            ? root
            : input.args[0] === "config"
              ? legacy
              : input.args.length === 1
                ? [...remotes.keys()].join("\n")
                : (remotes.get(input.args.at(-1)!) ?? ""),
        exitCode: 0,
        signal: null,
        durationMs: 0,
        timedOut: false,
        outputTruncated: false,
      }),
    },
    systemCredentials: createSystemGitCredentialGuard({
      change: async () => assert.fail("no credentials"),
    }),
  });
  return {
    routing,
    root,
    profile,
    remotes,
    account,
    url,
    setLegacy(value: string) {
      legacy = value;
    },
    counts: () => ({ discoveries, authentication }),
    context: async (identity?: string) =>
      projectGitRepositoryContext(
        root,
        await routing.getRepositoryContextSnapshot({
          workspacePath: root,
          workspaceIdentity: identity,
        }),
      ),
  };
}

test("explicit bindings avoid discovery only for model metadata; account menus and execution keep their owners", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.context()).remotes[0]!.authentication.account?.username, "alice");
  assert.equal((await f.context()).remotes[0]!.authentication.status, "selected");
  assert.deepEqual(f.counts(), { discoveries: 0, authentication: 0 });
  await f.routing.getRepositoryAuthentication({ workspacePath: f.root });
  assert.equal(f.counts().discoveries, 1);
  await f.routing.resolve({ workspacePath: f.root }, f.url);
  assert.equal(f.counts().authentication, 1);
});

test("each read observes deleted or revised accounts and new remotes without a context cache", async (t) => {
  const f = await fixture(t);
  f.profile.accounts[0] = { ...f.account, revision: "33333333-3333-4333-8333-333333333333" };
  assert.equal((await f.context()).remotes[0]!.authentication.status, "stale");
  f.profile.accounts = [];
  assert.equal((await f.context()).remotes[0]!.authentication.status, "stale");
  assert.equal(f.counts().discoveries, 0);
  f.remotes.set("origin", "https://example.invalid/other/repo.git");
  assert.equal((await f.context()).remotes[0]!.authentication.status, "system-default");
  assert.equal(f.counts().discoveries, 1);
});

test("automatic targets, tombstones and different identities still discover current candidates", async (t) => {
  const f = await fixture(t);
  await f.context("different-host-identity");
  assert.equal(f.counts().discoveries, 1);
  f.remotes.set("fork", "https://example.invalid/other/fork.git");
  await f.context();
  assert.equal(f.counts().discoveries, 2);
  f.remotes.delete("fork");
  f.profile.bindings[0] = { ...f.profile.bindings[0]!, id: null, revision: null };
  f.setLegacy(f.account.id);
  await f.context();
  assert.equal(f.counts().discoveries, 3);
});

test("legacy origin selection and empty remotes need no candidate discovery", async (t) => {
  const f = await fixture(t);
  f.profile.bindings = [];
  f.setLegacy(f.account.id);
  assert.equal((await f.context()).remotes[0]!.authentication.status, "selected");
  f.remotes.clear();
  assert.deepEqual((await f.context()).remotes, []);
  assert.deepEqual(f.counts(), { discoveries: 0, authentication: 0 });
});
