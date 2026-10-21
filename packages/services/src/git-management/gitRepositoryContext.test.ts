import test from "node:test";
import assert from "node:assert/strict";
import { projectGitRepositoryContext } from "./gitRepositoryContext.js";
import { gitAgentContextSchema, type GitRepositoryAuthentication } from "@lcode/shared";

const fixture = (): GitRepositoryAuthentication => ({
  revision: "r1",
  choices: ["alice", "bob"].map((username) => ({
    key: `saved:${username}:r1`,
    name: username,
    username,
    provider: "github",
    auth: "system",
    serverUrl: "https://github.com",
  })),
  remotes: [
    {
      name: "origin",
      urls: [
        { url: "https://github.com/fixture/repo.git", selection: "saved:bob:r1", stale: false },
      ],
    },
  ],
});
test("Git context projects only current effective account metadata, never candidate IDs or secrets", () => {
  const snapshot = fixture(),
    result = projectGitRepositoryContext("/repo", snapshot);
  assert.equal(result.remotes[0]!.authentication.status, "selected");
  assert.deepEqual(result.remotes[0]!.authentication.account, {
    name: "bob",
    username: "bob",
    provider: "github",
  });
  assert.ok(!JSON.stringify(result).includes("saved:"));
  assert.ok(!JSON.stringify(result).includes("alice"));
  const context = { status: "available", partial: false, repositories: [result] };
  assert.equal(gitAgentContextSchema.safeParse(context).success, true);
  assert.equal(gitAgentContextSchema.safeParse({ ...context, token: "fixture" }).success, false);
  assert.equal(
    gitAgentContextSchema.safeParse({
      ...context,
      repositories: [{ ...result, privateKeyPath: "/secret" }],
    }).success,
    false,
  );
  const secretUrl = {
    ...result,
    remotes: [
      { ...result.remotes[0]!, url: "https://alice:fixture-secret@example.invalid/repo.git" },
    ],
  };
  assert.equal(
    gitAgentContextSchema.safeParse({ ...context, repositories: [secretUrl] }).success,
    false,
  );
  snapshot.remotes[0]!.urls[0]!.url = secretUrl.remotes[0]!.url;
  assert.throws(() => projectGitRepositoryContext("/repo", snapshot), /git-context-unavailable/);
});
test("Current choices, stale binding, explicit URL usernames and nonnetwork remotes remain distinct", () => {
  const snapshot = fixture(),
    target = snapshot.remotes[0]!.urls[0]!;
  target.selection = null;
  assert.equal(
    projectGitRepositoryContext("/repo", snapshot).remotes[0]!.authentication.status,
    "selection-required",
  );
  snapshot.choices.pop();
  assert.equal(
    projectGitRepositoryContext("/repo", snapshot).remotes[0]!.authentication.account?.username,
    "alice",
  );
  snapshot.choices = [];
  assert.equal(
    projectGitRepositoryContext("/repo", snapshot).remotes[0]!.authentication.status,
    "system-default",
  );
  target.selection = "saved:deleted:revision";
  target.stale = true;
  assert.equal(
    projectGitRepositoryContext("/repo", snapshot).remotes[0]!.authentication.status,
    "stale",
  );
  target.selection = null;
  target.stale = false;
  target.url = "D:/repos/remote.git";
  assert.equal(
    projectGitRepositoryContext("/repo", snapshot).remotes[0]!.authentication.status,
    "not-applicable",
  );
  target.url = "https://alice@github.com/fixture/repo.git";
  snapshot.choices = fixture().choices;
  const actual = projectGitRepositoryContext("/repo", snapshot).remotes[0]!;
  assert.equal(actual.authentication.account?.username, "alice");
  assert.equal(actual.url, "https://github.com/fixture/repo.git");
});
test("Large remote lists have an explicit partial marker", () => {
  const snapshot = fixture();
  snapshot.remotes = Array.from({ length: 35 }, (_, i) => ({
    ...snapshot.remotes[0]!,
    name: `remote${i}`,
  }));
  const result = projectGitRepositoryContext("/repo", snapshot);
  assert.equal(result.remotes.length, 32);
  assert.equal(result.partial, true);
});
