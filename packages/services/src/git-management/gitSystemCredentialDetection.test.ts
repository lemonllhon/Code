import assert from "node:assert/strict";
import test from "node:test";
import type { GitCredentialMetadataRunner } from "./gitCredentialMetadataProcess.js";
import { detectSystemGitCredentials } from "./gitSystemCredentialDetection.js";
import { gitProviderForUrl } from "./gitProviderEvidence.js";

const records = [
  { target: "git:https://gitlab.com", userName: "alice" },
  { target: "git:https://bob@gitlab.com", userName: "bob" },
  {
    target: "LegacyGeneric:target=git:https://code.company.invalid:8443/team",
    userName: "内部用户",
  },
  { target: "git:https://gitea.example.invalid", userName: "forge" },
  { target: "git:https://forgejo.example.invalid", userName: "forgejo" },
  { target: "git:https://bitbucket.org", userName: "first" },
  { target: "git:https://second@bitbucket.org", userName: "second" },
];
test("WinCred metadata discovers all providers and multiple usernames without exporting credential blobs", async () => {
  const calls: string[][] = [];
  const runner: GitCredentialMetadataRunner = async (command) => {
    calls.push(command.args);
    assert.ok(command.executable.toLowerCase().includes("powershell"));
    const script = Buffer.from(command.args.at(-1)!, "base64").toString("utf16le");
    assert.ok(script.includes("CredEnumerateW") && script.includes("CredFree"));
    assert.ok(
      !/PtrToStringUni\([^)]*CredentialBlob|Copy\([^)]*CredentialBlob|CredReadW|CredWriteW/.test(
        script,
      ),
    );
    return {
      status: "ok",
      stdout: JSON.stringify({
        items: [
          ...records,
          { target: "git:https://u:secret@gitlab.com", userName: "u" },
          { target: "website:https://example.invalid", userName: "private-web-user" },
        ],
        partial: false,
      }),
    };
  };
  const result = await detectSystemGitCredentials({ platform: "win32", runner });
  assert.equal(result.accounts.length, 7);
  assert.deepEqual(
    result.accounts.filter((a) => a.serverUrl === "https://gitlab.com").map((a) => a.username),
    ["alice", "bob"],
  );
  assert.equal(
    result.accounts.find((a) => a.username === "内部用户")!.serverUrl,
    "https://code.company.invalid:8443/team",
  );
  assert.equal(result.source.status, "ok");
  assert.equal(calls.length, 1);
  assert.ok(!JSON.stringify(result).includes("secret"));
});

test("macOS Keychain attribute dump covers GCM and osxkeychain accounts, including Unicode, without password flags", async () => {
  const blocks = records
    .map(
      (r) =>
        `keychain: "/fixture/login.keychain-db"\nclass: "genp"\nattributes:\n    "svce"<blob>=${JSON.stringify(r.target.replace(/^LegacyGeneric:target=/, ""))}\n    "acct"<blob>=${JSON.stringify(r.userName)}\n`,
    )
    .join("");
  const internet = `keychain: "/fixture/login.keychain-db"\nclass: "inet"\nattributes:\n "srvr"<blob>="gitlab.com"\n "acct"<blob>=0xE794A8E688B7\n "ptcl"<uint32>="htps"\n "port"<uint32>=0x000001BB\n "path"<blob>="/group"\nkeychain: "/fixture/login.keychain-db"\nclass: "inet"\n "srvr"<blob>="shopping.example.invalid"\n "acct"<blob>="not-git"\n "ptcl"<uint32>="htps"\n`;
  const result = await detectSystemGitCredentials({
    platform: "darwin",
    runner: async (command) => {
      assert.deepEqual(command.args, ["dump-keychain"]);
      return { status: "ok", stdout: blocks + internet };
    },
  });
  assert.equal(result.accounts.length, 8);
  assert.equal(
    result.accounts.find((a) => a.username === "用户")!.serverUrl,
    "https://gitlab.com/group",
  );
  assert.ok(!result.accounts.some((a) => a.username === "not-git"));
});

test("Linux Secret Service reads GCM/libsecret attributes including locked-item metadata and never opens secrets", async () => {
  const calls: string[][] = [];
  const attributes: Record<string, string>[] = [
    ...records.map((record) => ({
      service: record.target.replace(/^LegacyGeneric:target=/, ""),
      account: record.userName,
    })),
    {
      protocol: "https",
      server: "gitlab.com",
      user: "bob",
      object: "team/repo.git",
      "xdg:schema": "org.git.Password",
    },
  ];
  const paths = attributes.map((_, index) => `/org/freedesktop/secrets/collection/login/${index}`);
  const runner: GitCredentialMetadataRunner = async (command) => {
    calls.push(command.args);
    assert.ok(!command.args.some((a) => /^(GetSecret|GetSecrets|OpenSession|Unlock)$/.test(a)));
    if (command.args.includes("SearchItems"))
      return {
        status: "ok",
        stdout: JSON.stringify({
          type: "aoao",
          data: [paths.slice(0, -1), paths.slice(-1)],
        }),
      };
    const path = command.args.find((a) => a.startsWith("/org/freedesktop/secrets/collection/"))!;
    const attrs = attributes[Number(path.split("/").at(-1))]!;
    return { status: "ok", stdout: JSON.stringify({ type: "a{ss}", data: attrs }) };
  };
  const result = await detectSystemGitCredentials({ platform: "linux", runner });
  assert.equal(result.accounts.length, 8);
  assert.equal(result.source.status, "ok");
  assert.ok(result.accounts.some((a) => a.username === "内部用户"));
  assert.ok(result.accounts.some((a) => a.username === "forgejo"));
  assert.equal(result.accounts.filter((a) => a.serverUrl === "https://bitbucket.org").length, 2);
  assert.ok(
    result.accounts.some(
      (a) => a.username === "bob" && a.serverUrl === "https://gitlab.com/team/repo.git",
    ),
  );
  assert.equal(
    new Set(calls.filter((a) => a.includes("Attributes")).map((a) => a.join(" "))).size,
    8,
  );
});

test("Linux property metadata rejects method-style array wrapping without exposing its contents", async () => {
  const result = await detectSystemGitCredentials({
    platform: "linux",
    runner: async ({ args }) => ({
      status: "ok",
      stdout: JSON.stringify(
        args.includes("SearchItems")
          ? { type: "aoao", data: [["/org/freedesktop/secrets/collection/login/1"], []] }
          : { type: "a{ss}", data: [{ service: "git:https://gitlab.com", account: "unverified" }] },
      ),
    }),
  });
  assert.equal(result.source.status, "partial");
  assert.equal(result.accounts.length, 0);
  assert.ok(!JSON.stringify(result).includes("unverified"));
});

test("Unavailable/invalid/oversized metadata sources are isolated and unknown platforms are explicit", async () => {
  for (const platform of ["win32", "darwin", "linux"] as const) {
    for (const output of [
      { status: "unavailable" as const, stdout: "" },
      { status: "failed" as const, stdout: "private-raw-error" },
      { status: "ok" as const, stdout: "not-valid-metadata" },
    ]) {
      const result = await detectSystemGitCredentials({ platform, runner: async () => output });
      assert.ok(["partial", "unavailable"].includes(result.source.status));
      assert.equal(result.accounts.length, 0);
      assert.ok(!JSON.stringify(result).includes("private-raw-error"));
    }
  }
  const result = await detectSystemGitCredentials({
    platform: "freebsd",
    runner: async () => {
      throw new Error("must not run");
    },
  });
  assert.equal(result.source.status, "unsupported");
});

test("Explicit self-hosted provider evidence wins over host guessing and preserves path/port isolation", () => {
  const evidence = [
    { serverUrl: "https://code.company.invalid:8443/team", provider: "gitlab" as const },
    { serverUrl: "https://gitlab-mirror.invalid/forge", provider: "gitea" as const },
  ];
  assert.equal(
    gitProviderForUrl("https://code.company.invalid:8443/team/repo", evidence),
    "gitlab",
  );
  assert.equal(
    gitProviderForUrl("https://code.company.invalid:8443/teams/repo", evidence),
    "server",
  );
  assert.equal(gitProviderForUrl("https://code.company.invalid/team/repo", evidence), "server");
  assert.equal(gitProviderForUrl("https://gitlab-mirror.invalid/forge", evidence), "gitea");
});
